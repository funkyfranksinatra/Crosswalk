/**
 * Job handlers. Each one is small and delegates to the domain module, which owns the
 * resumability rules: a handler may be invoked again for the same job after a crash
 * (pg-boss expiry) — see queues.ts.
 *
 * `startWorkers()` is called once per process: from src/instrumentation.ts inside the
 * Next.js server (default), or from scripts/worker.ts for a dedicated worker process.
 */
import type { PgBoss, JobWithMetadata } from "pg-boss";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { getBoss, jobsEnabled } from "./boss";
import { QUEUES, CRON, type QueueName, type JobData } from "./queues";

type G = typeof globalThis & { __crosswalkWorkers?: Promise<void> | null };
const g = globalThis as G;

type Meta = { id: string; retryCount: number; retryLimit: number };

/** What every handler receives: its data plus the retry position, so it can say "attempt 2 of 3". */
type Handler<N extends QueueName> = (data: JobData[N], meta: Meta & { attempt: number; finalAttempt: boolean; signal: AbortSignal }) => Promise<unknown>;

const handlers: { [N in QueueName]: Handler<N> } = {
  "request.run": async (data, meta) => {
    const { runRequest } = await import("@/lib/pipeline/run");
    return runRequest(data.requestId, { jobId: meta.id, attempt: meta.attempt, freshGrades: data.freshGrades, signal: meta.signal, resume: data.resume });
  },
  "gudid.import": async (data, meta) => {
    const { runImport } = await import("@/lib/gudid/library");
    return runImport(data.importId, { jobId: meta.id, attempt: meta.attempt, resume: data.resume });
  },
  "gudid.refresh": async (data) => {
    const { refreshStaleRecords } = await import("@/lib/gudid/refresh");
    return refreshStaleRecords(data);
  },
  "integration.sync": async (data) => {
    const { syncCrmAccounts, syncErp, syncGpoMemberships } = await import("@/lib/integrations/sync");
    const { getCompany } = await import("@/lib/settings");
    if (data.system === "crm") return syncCrmAccounts(data.actorUserId);
    if (data.system === "erp") return syncErp(data.actorUserId, (await getCompany()).id);
    return syncGpoMemberships(data.actorUserId);
  },
  "feed.ingest": async (data, meta) => {
    const { ingestFeed } = await import("@/lib/feeds");
    return ingestFeed(data.feed, { trigger: data.trigger, actorUserId: data.actorUserId ?? null, jobId: meta.id });
  },
  "notify.deliver": async (data) => {
    const { deliver } = await import("@/lib/notifications/deliver");
    return deliver(data.notificationId, data.channel);
  },
  "alerts.evaluate": async () => {
    const { evaluateAlerts } = await import("@/lib/observability/alerts");
    return evaluateAlerts();
  },
};

/** Concurrency per queue in one process (a run is CPU + network heavy; deliveries are cheap). */
const CONCURRENCY: Record<QueueName, number> = { "request.run": 1, "gudid.import": 1, "gudid.refresh": 1, "integration.sync": 1, "feed.ingest": 1, "notify.deliver": 4, "alerts.evaluate": 1 };

async function onFinalFailure(queue: QueueName, data: unknown, error: string) {
  try {
    const { notifyJobFailed } = await import("@/lib/notifications");
    await notifyJobFailed(queue, data, error);
  } catch (e) {
    log.error("jobs.final_failure_notify_error", { queue, error: e instanceof Error ? e.message : String(e) });
  }
}

async function register<N extends QueueName>(boss: PgBoss, name: N) {
  const retryLimit = QUEUES[name].retryLimit;
  for (let i = 0; i < CONCURRENCY[name]; i++) {
    const options = { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: name === "notify.deliver" ? 2 : 5 } as const;
    await boss.work<JobData[N], unknown, typeof options>(name, options, async (jobs: JobWithMetadata<JobData[N]>[]) => {
      const job = jobs[0];
      const attempt = (job.retryCount ?? 0) + 1;
      const finalAttempt = attempt > retryLimit;
      const t0 = Date.now();
      log.info("jobs.start", { queue: name, jobId: job.id, attempt, retryLimit });
      try {
        const out = await handlers[name](job.data, { id: job.id, retryCount: job.retryCount ?? 0, retryLimit, attempt, finalAttempt, signal: job.signal });
        log.info("jobs.done", { queue: name, jobId: job.id, attempt, ms: Date.now() - t0 });
        return out;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log.error("jobs.failed", { queue: name, jobId: job.id, attempt, finalAttempt, ms: Date.now() - t0, error });
        if (finalAttempt) await onFinalFailure(name, job.data, error);
        throw e;
      }
    });
  }
}

/** Cron-driven queues. Schedules are idempotent per (queue, key). */
async function registerSchedules(boss: PgBoss) {
  await boss.schedule("alerts.evaluate", CRON["alerts.evaluate"], {}, { tz: "UTC", singletonKey: "cron" });
  await boss.schedule("gudid.refresh", CRON["gudid.refresh"], { limit: Number(process.env.GUDID_REFRESH_BATCH ?? 200) }, { tz: "UTC", singletonKey: "refresh:sweep" });
  const { scheduleFeeds } = await import("@/lib/feeds/schedule");
  await scheduleFeeds(boss);
}

/**
 * Anything the database says is running but no worker holds: pg-boss retries the job when it
 * expires, but a row can also say "running" from before the queue existed. Reconcile both ways.
 */
async function recoverOrphans() {
  const { enqueue } = await import("./boss");
  // Requests marked queued/running without a job → (re)enqueue them; their pipeline resumes from its checkpoint.
  const requests = await prisma.request.findMany({ where: { status: { in: ["queued", "running"] } }, select: { id: true, jobId: true, status: true } });
  for (const r of requests) {
    if (r.jobId) {
      const boss = await getBoss();
      const job = await boss.getJobById("request.run", r.jobId).catch(() => null);
      if (job && ["created", "retry", "active"].includes(job.state)) continue;
    }
    const { jobId } = await enqueue("request.run", { requestId: r.id, resume: true }, { singletonKey: r.id });
    if (jobId) await prisma.request.update({ where: { id: r.id }, data: { jobId, status: "queued", stage: "Queued (recovered after restart)" } });
    log.warn("jobs.recovered_request", { requestId: r.id, jobId });
  }
  const imports = await prisma.gudidImport.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, jobId: true } });
  for (const im of imports) {
    if (im.jobId) {
      const boss = await getBoss();
      const job = await boss.getJobById("gudid.import", im.jobId).catch(() => null);
      if (job && ["created", "retry", "active"].includes(job.state)) continue;
    }
    const { jobId } = await enqueue("gudid.import", { importId: im.id, resume: true }, { singletonKey: im.id });
    if (jobId) await prisma.gudidImport.update({ where: { id: im.id }, data: { jobId, status: "QUEUED" } });
    log.warn("jobs.recovered_import", { importId: im.id, jobId });
  }
}

export function startWorkers(): Promise<void> {
  if (!jobsEnabled()) return Promise.resolve();
  if (!g.__crosswalkWorkers) {
    g.__crosswalkWorkers = (async () => {
      const boss = await getBoss();
      for (const name of Object.keys(QUEUES) as QueueName[]) await register(boss, name);
      await registerSchedules(boss);
      await recoverOrphans().catch((e) => log.error("jobs.recover_error", { error: e instanceof Error ? e.message : String(e) }));
      log.info("jobs.workers_started", { queues: Object.keys(QUEUES), mode: process.env.JOBS_WORKER ?? "inline" });
    })().catch((e) => {
      g.__crosswalkWorkers = null;
      log.error("jobs.workers_failed", { error: e instanceof Error ? e.message : String(e) });
      throw e;
    });
  }
  return g.__crosswalkWorkers;
}

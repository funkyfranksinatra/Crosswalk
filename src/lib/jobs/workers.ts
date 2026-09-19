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
    return runRequest(data.requestId, { jobId: meta.id, attempt: meta.attempt, freshGrades: data.freshGrades, signal: meta.signal, resume: data.resume, finalAttempt: meta.finalAttempt });
  },
  "gudid.import": async (data, meta) => {
    const { runImport } = await import("@/lib/gudid/library");
    return runImport(data.importId, { jobId: meta.id, attempt: meta.attempt, resume: data.resume, finalAttempt: meta.finalAttempt });
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
    return ingestFeed(data.feed, { trigger: data.trigger, actorUserId: data.actorUserId ?? null, jobId: meta.id, force: Boolean(data.force) });
  },
  "notify.deliver": async (data) => {
    const { deliver } = await import("@/lib/notifications/deliver");
    return deliver(data.notificationId, data.channel);
  },
  "alerts.evaluate": async () => {
    const { evaluateAlerts } = await import("@/lib/observability/alerts");
    return evaluateAlerts();
  },
  "embed.refresh": async (data) => {
    const { refreshEmbeddings, embeddingsEnabled } = await import("@/lib/match/embeddings");
    if (!embeddingsEnabled()) return { skipped: "embeddings off or no key" };
    const tables = data.table ? [data.table] : (["OwnProduct", "CompetitorProduct"] as const);
    const out: Record<string, unknown> = {};
    for (const t of tables) out[t] = await refreshEmbeddings(t, { ids: data.ids, limit: data.limit });
    return out;
  },
  "analytics.refresh": async (data) => {
    const { refreshSnapshots } = await import("@/lib/analytics/snapshots");
    return refreshSnapshots(data.reports, data.trigger ?? "schedule");
  },
  "bids.ingest": async (data, meta) => {
    const { ingestPublicAwards } = await import("@/lib/intelligence/bids");
    return ingestPublicAwards(data.source, { trigger: data.trigger, actorUserId: data.actorUserId ?? null, jobId: meta.id, lookbackDays: data.lookbackDays });
  },
  "retention.sweep": async (data) => {
    const { runRetention, retentionConfig } = await import("@/lib/retention");
    return runRetention(retentionConfig(), { actorUserId: data.actorUserId ?? null }); // never forced: RETENTION_ENABLED decides
  },
};

/** Concurrency per queue in one process (a run is CPU + network heavy; deliveries are cheap). */
const CONCURRENCY: Record<QueueName, number> = { "request.run": 1, "gudid.import": 1, "gudid.refresh": 1, "integration.sync": 1, "feed.ingest": 1, "notify.deliver": 4, "alerts.evaluate": 1, "embed.refresh": 1, "analytics.refresh": 1, "bids.ingest": 1, "retention.sweep": 1 };

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
        const interrupted = e instanceof Error && e.name === "RunInterrupted";
        log[interrupted ? "warn" : "error"]("jobs.failed", { queue: name, jobId: job.id, attempt, finalAttempt, interrupted, ms: Date.now() - t0, error });
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
  // A bad or "off" cron for one of these must not stop feeds scheduling and orphan recovery below.
  // Schedule keys allow only [A-Za-z0-9_-]; the job's singletonKey may carry ":" like the manual ones.
  const sched = async (queue: "embed.refresh" | "analytics.refresh" | "retention.sweep", cron: string, data: object, key: string, singletonKey: string) => {
    if (cron === "off") { await boss.unschedule(queue, key).catch(() => undefined); return; }
    try { await boss.schedule(queue, cron, data, { tz: "UTC", key, singletonKey }); } catch (e) { log.error("jobs.schedule_failed", { queue, cron, error: e instanceof Error ? e.message : String(e) }); }
  };
  await sched("embed.refresh", CRON["embed.refresh"], { limit: Number(process.env.EMBED_REFRESH_BATCH ?? 5000) }, "embed-sweep", "embed:sweep");
  await sched("analytics.refresh", CRON["analytics.refresh"], { trigger: "schedule" }, "analytics-cron", "analytics:cron");
  // Retention is scheduled only while it is switched on; switching it off unschedules it at the next start.
  const { retentionConfig } = await import("@/lib/retention");
  await sched("retention.sweep", retentionConfig().enabled ? CRON["retention.sweep"] : "off", { trigger: "schedule" }, "retention-cron", "retention:cron");
  const { bidSourcesConfigured, BID_SOURCES } = await import("@/lib/intelligence/bids");
  const configured = new Set(await bidSourcesConfigured());
  for (const source of BID_SOURCES) {
    const key = `bids-${source}`;
    if (!configured.has(source) || CRON["bids.ingest"] === "off") { await boss.unschedule("bids.ingest", key).catch(() => undefined); continue; }
    try { await boss.schedule("bids.ingest", CRON["bids.ingest"], { source, trigger: "schedule" }, { tz: "UTC", key, singletonKey: `bids:${source}`, missed: "once" }); } catch (e) { log.error("jobs.schedule_failed", { queue: "bids.ingest", cron: CRON["bids.ingest"], error: e instanceof Error ? e.message : String(e) }); }
  }
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
  const boss = await getBoss();
  // A job that is still live (its heartbeat will fail it soon if the process died) is left alone.
  const live = async (queue: "request.run" | "gudid.import", jobId: string | null) => {
    if (!jobId) return false;
    const job = await boss.getJobById(queue, jobId).catch(() => null);
    return Boolean(job && ["created", "retry", "active"].includes(job.state));
  };
  const requests = await prisma.request.findMany({ where: { status: { in: ["queued", "running"] } }, select: { id: true, jobId: true, status: true, attempt: true } });
  const runCap = QUEUES["request.run"].retryLimit + 1;
  for (const r of requests) {
    if (await live("request.run", r.jobId)) continue;
    // Recovery counts as an attempt: a request that keeps killing the process is not re-queued forever.
    if (r.attempt >= runCap) {
      await prisma.request.update({ where: { id: r.id }, data: { status: "failed", stage: "Failed", error: `Interrupted ${r.attempt} times (server restarts); not retried automatically — Re-run to try again` } });
      log.error("jobs.recovery_gave_up", { crossRef: r.id, attempts: r.attempt });
      continue;
    }
    const { jobId } = await enqueue("request.run", { requestId: r.id, resume: true }, { singletonKey: r.id });
    if (jobId) await prisma.request.update({ where: { id: r.id }, data: { jobId, status: "queued", stage: "Queued (recovered after restart)" } });
    log.warn("jobs.recovered_request", { crossRef: r.id, jobId });
  }
  const imports = await prisma.gudidImport.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, jobId: true, attempt: true } });
  const importCap = QUEUES["gudid.import"].retryLimit + 1;
  for (const im of imports) {
    if (await live("gudid.import", im.jobId)) continue;
    if (im.attempt >= importCap) {
      await prisma.gudidImport.update({ where: { id: im.id }, data: { status: "FAILED", error: `Interrupted ${im.attempt} times (server restarts); start the import again to continue from where it stopped`, finishedAt: new Date() } });
      log.error("jobs.recovery_gave_up", { importId: im.id, attempts: im.attempt });
      continue;
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

/**
 * WS5 — pg-boss queue lifecycle against the real queue in the test database (JOBS_WORKER=inline in
 * this process; one case drives an external `scripts/worker.ts` child process). Every case pins a
 * documented property of src/lib/jobs: registration, singleton keys, UTC schedules and "off",
 * failure-tolerant scheduling, retries and exhausted retries (JOB_FAILED), orphan recovery, the
 * heartbeat crash detector, graceful stop handing active jobs back, and the retry-failed action.
 * Needs DATABASE_URL with the demo seed; no network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { getBoss, enqueue, queueHealth, recentFailures, stopBoss, JOBS_SCHEMA } from "@/lib/jobs/boss";
import { QUEUES, CRON, type QueueName } from "@/lib/jobs/queues";
import { startWorkers } from "@/lib/jobs/workers";
import { scheduleFeeds } from "@/lib/feeds/schedule";
import { FEEDS } from "@/lib/feeds";
import { getCompany } from "@/lib/settings";
import { queueRule } from "@/lib/observability/alerts";

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = `WS5JOBS-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000, every = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms`); await sleep(every); }
}
const jobRow = (id: string) => prisma.$queryRawUnsafe<{ state: string; retry_count: number; output: unknown; started_on: Date | null; completed_on: Date | null }[]>(`SELECT state::text, retry_count, output, started_on, completed_on FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, id).then((r) => r[0]);

async function cleanup() {
  await prisma.request.deleteMany({ where: { reference: { startsWith: TAG } } });
  await prisma.integrationSyncJob.deleteMany({ where: { errorSummary: { contains: TAG } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { title: { contains: `feed ${TAG}` } }] } });
  await prisma.alert.deleteMany({ where: { fingerprint: "jobs_failed" } });
}

describe.skipIf(!hasDb)("WS5 jobs", () => {
  let orphanA: string, orphanB: string, staleSync: string;
  beforeAll(async () => { await cleanup(); }, 60_000);
  afterAll(async () => { await cleanup(); await stopBoss().catch(() => undefined); }, 60_000);

  test("an external worker process (scripts/worker.ts) shares the queue: a job enqueued here is processed there; SIGTERM stops it cleanly", async () => {
    process.env.JOBS_WORKER = "off"; // this process only enqueues
    const boss = await getBoss();
    const worker: ChildProcess = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/worker.ts")], { env: { ...process.env, JOBS_WORKER: "external", LOG_SILENT: "false", LOG_FORMAT: "json" }, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    worker.stdout!.on("data", (d) => out.push(String(d))); worker.stderr!.on("data", (d) => out.push(String(d)));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => worker.on("exit", (code, signal) => resolve({ code, signal })));
    try {
      await until(async () => out.join("").includes("worker.ready"), 60_000, 500);
      const { jobId } = await enqueue("retention.sweep", { trigger: "manual" }, { singletonKey: `ws5:${TAG}` });
      expect(jobId).toBeTruthy();
      const done = await until(async () => { const j = await boss.getJobById("retention.sweep", jobId!); return j && j.state === "completed" ? j : null; }, 60_000, 500);
      expect(done.state).toBe("completed");
      expect(out.join("")).toContain(`"jobId":"${jobId}"`);
    } finally {
      worker.kill("SIGTERM");
    }
    const r = await exited;
    expect(r.code).toBe(0);
    expect(out.join("")).toContain("worker.stopping");
  }, 120_000);

  test("orphan recovery at start: a running request with no live job is re-queued (resume) or failed once attempts are exhausted; stale RUNNING integration jobs are cancelled", async () => {
    const company = await getCompany();
    orphanA = (await prisma.request.create({ data: { companyId: company.id, reference: `${TAG}-A`, accountName: "x", status: "running", stage: "Resolving", attempt: 1, createdBy: "t", checkpoint: "resolve" } })).id;
    orphanB = (await prisma.request.create({ data: { companyId: company.id, reference: `${TAG}-B`, accountName: "x", status: "running", stage: "Resolving", attempt: 3, createdBy: "t" } })).id;
    await prisma.integrationConfig.upsert({ where: { key: "fx" }, create: { key: "fx", provider: "mock", status: "NOT_CONFIGURED" }, update: {} });
    staleSync = (await prisma.integrationSyncJob.create({ data: { integrationKey: "fx", provider: "mock", syncType: "rates", trigger: "schedule", status: "RUNNING", startedAt: new Date(Date.now() - 13 * 3600_000), errorSummary: TAG } })).id;
    process.env.JOBS_WORKER = "inline";
    await startWorkers();
    const boss = await getBoss();
    const a = await prisma.request.findUniqueOrThrow({ where: { id: orphanA } });
    expect(a.status).toBe("queued"); expect(a.jobId).toBeTruthy(); expect(a.stage).toMatch(/recovered after restart/);
    expect(a.checkpoint).toBe("resolve"); // the checkpoint survives: the run resumes, it does not start over
    const job = await boss.getJobById("request.run", a.jobId!);
    expect(job?.data).toMatchObject({ requestId: orphanA, resume: true });
    // take it off the queue before the worker starts a real pipeline run (no openFDA here)
    await boss.cancel("request.run", a.jobId!);
    await prisma.request.update({ where: { id: orphanA }, data: { status: "cancelled" } });
    const b = await prisma.request.findUniqueOrThrow({ where: { id: orphanB } });
    expect(b.status).toBe("failed"); expect(b.error).toMatch(/Interrupted 3 times/); expect(b.jobId).toBeNull();
    expect((await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: staleSync } })).status).toBe("CANCELLED");
  }, 60_000);

  test("every queue in QUEUES is registered with its policy and retry settings; startWorkers is idempotent", async () => {
    const boss = await getBoss();
    const names = Object.keys(QUEUES) as QueueName[];
    const queues = await boss.getQueues(names);
    expect(queues.map((q) => q.name).sort()).toEqual([...names].sort());
    for (const q of queues) {
      const want = QUEUES[q.name as QueueName];
      expect(q.policy, q.name).toBe("exclusive");
      expect(q.retryLimit, q.name).toBe(want.retryLimit);
      expect(q.expireInSeconds, q.name).toBe(want.expireInSeconds);
    }
    await expect(startWorkers()).resolves.toBeUndefined();
    await expect(startWorkers()).resolves.toBeUndefined();
    const health = await queueHealth();
    expect(health.map((h) => h.name).sort()).toEqual([...names].sort());
  });

  test("singleton keys: a second enqueue with the same key while the first is queued/active is deduplicated; a different key is not", async () => {
    const first = await enqueue("retention.sweep", { trigger: "manual" }, { singletonKey: `ws5:${TAG}:dedupe`, startAfterSeconds: 30 });
    const second = await enqueue("retention.sweep", { trigger: "manual" }, { singletonKey: `ws5:${TAG}:dedupe`, startAfterSeconds: 30 });
    const other = await enqueue("retention.sweep", { trigger: "manual" }, { singletonKey: `ws5:${TAG}:other`, startAfterSeconds: 30 });
    expect(first.jobId).toBeTruthy(); expect(second).toEqual({ jobId: null, deduplicated: true }); expect(other.jobId).toBeTruthy();
    const boss = await getBoss();
    await boss.cancel("retention.sweep", first.jobId!); await boss.cancel("retention.sweep", other.jobId!);
  });

  test("schedules are UTC crons from CRON/FEEDS; 'off' unschedules; a malformed feed cron is logged and skipped without breaking the others", async () => {
    const boss = await getBoss();
    const all = await boss.getSchedules();
    const byKey = new Map(all.map((s) => [`${s.name}:${s.key ?? ""}`, s]));
    expect(byKey.get("alerts.evaluate:")?.cron ?? byKey.get("alerts.evaluate:alerts.evaluate")?.cron ?? all.find((s) => s.name === "alerts.evaluate")?.cron).toBe(CRON["alerts.evaluate"]);
    for (const s of all) expect(s.timezone, `${s.name}/${s.key}`).toBe("UTC");
    for (const f of Object.values(FEEDS)) {
      const s = all.find((x) => x.name === "feed.ingest" && x.key === `feed-${f.name}`);
      expect(s?.cron, f.name).toBe(f.defaultCron);
      expect(s?.data).toMatchObject({ feed: f.name, trigger: "schedule" });
    }
    const saved = { gpo: process.env.FEED_GPO_CRON, pricing: process.env.FEED_PRICING_CRON };
    try {
      process.env.FEED_GPO_CRON = "off";
      process.env.FEED_PRICING_CRON = "every other tuesday";
      await expect(scheduleFeeds(boss)).resolves.toBeUndefined(); // must not throw
      const after = await boss.getSchedules("feed.ingest");
      expect(after.some((s) => s.key === "feed-gpo")).toBe(false);
      expect(after.some((s) => s.key === "feed-pricing")).toBe(false);
      expect(after.some((s) => s.key === "feed-crm")).toBe(true);
    } finally {
      if (saved.gpo === undefined) delete process.env.FEED_GPO_CRON; else process.env.FEED_GPO_CRON = saved.gpo;
      if (saved.pricing === undefined) delete process.env.FEED_PRICING_CRON; else process.env.FEED_PRICING_CRON = saved.pricing;
      await scheduleFeeds(boss);
    }
    const restored = await boss.getSchedules("feed.ingest");
    expect(restored.some((s) => s.key === "feed-gpo")).toBe(true);
    expect(restored.some((s) => s.key === "feed-pricing")).toBe(true);
  });

  test("a failing job is retried with its retry policy and, once exhausted, is failed, notifies admins (JOB_FAILED), shows in recentFailures and fires jobs_failed; retry-failed puts it back", async () => {
    const boss = await getBoss();
    const id = await boss.send("feed.ingest", { feed: TAG, trigger: "manual" }, { retryLimit: 1, retryDelay: 1, singletonKey: `feed:${TAG}` });
    expect(id).toBeTruthy();
    const failed = await until(async () => { const j = await jobRow(id!); return j.state === "failed" ? j : null; }, 60_000, 500);
    expect(failed.retry_count).toBe(1); // attempt 1 failed → retried after 1 s → attempt 2 failed → exhausted
    expect(JSON.stringify(failed.output)).toMatch(/unknown feed/);
    const note = await until(async () => prisma.notification.findFirst({ where: { kind: "JOB_FAILED", title: { contains: `feed ${TAG}` } } }), 20_000, 500);
    expect(note.body).toMatch(/unknown feed/);
    const admins = await prisma.user.count({ where: { isActive: true, roles: { some: { role: { in: ["ADMIN", "PRICING_DIRECTOR"] } } } } });
    expect(await prisma.notification.count({ where: { kind: "JOB_FAILED", title: { contains: `feed ${TAG}` } } })).toBe(admins);
    const failures = await recentFailures(50);
    expect(failures.some((f) => f.id === id)).toBe(true);
    expect(failures.find((f) => f.id === id)?.error).toMatch(/unknown feed/);
    const conds = await queueRule();
    expect(conds.find((c) => c.fingerprint === "jobs_failed")).toBeTruthy();
    // the Settings → System "Retry failed" action: boss.retry puts the job back; it runs again and fails again
    await boss.retry("feed.ingest", id!);
    const again = await until(async () => { const j = await jobRow(id!); return j.state === "failed" && j.completed_on && j.completed_on.getTime() > failed.completed_on!.getTime() ? j : null; }, 60_000, 500);
    expect(again.state).toBe("failed");
  }, 120_000);

  test("heartbeat lapse: an active job whose process died (stale heartbeat_on) is failed by supervision and retried; a live heartbeat is left alone", async () => {
    const boss = await getBoss();
    const insert = async (staleSeconds: number) => (await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ${JOBS_SCHEMA}.job (name, data, state, retry_limit, retry_delay, expire_seconds, started_on, heartbeat_on, heartbeat_seconds, singleton_key) VALUES ('retention.sweep', $1::jsonb, 'active', 1, 1, 3600, now() - interval '10 minutes', now() - ($2::int * interval '1 second'), 60, $3) RETURNING id`,
      JSON.stringify({ trigger: "manual" }), staleSeconds, `ws5:${TAG}:hb-${staleSeconds}`,
    ))[0].id;
    const dead = await insert(300);
    const alive = await insert(5);
    // The crash sweep is part of the supervision pass, claimed at most once per monitorIntervalSeconds (60 s) per queue;
    // release the claim so this pass runs now instead of waiting for the timer.
    await prisma.$executeRawUnsafe(`UPDATE ${JOBS_SCHEMA}.queue SET monitor_claim_on = NULL, monitor_on = NULL WHERE name = 'retention.sweep'`);
    await boss.supervise((await boss.getQueues(["retention.sweep"])) as never);
    const d = await jobRow(dead);
    expect(["retry", "created", "active", "completed"]).toContain(d.state); // failed by the heartbeat sweep and put back for its retry
    expect(d.state).not.toBe("failed");
    expect(JSON.stringify(d.output ?? "")).toMatch(/heartbeat timeout/);
    expect((await jobRow(alive)).state).toBe("active");
    // the retried job runs on this process's worker (retention is off → a cheap no-op)
    const done = await until(async () => { const j = await jobRow(dead); return j.state === "completed" ? j : null; }, 60_000, 500);
    expect(done.retry_count).toBe(1);
    await prisma.$executeRawUnsafe(`DELETE FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, alive);
  }, 120_000);

  test("graceful stop hands active jobs back: a job still running at stop is failed 'pg-boss shut down while active' and retried by the next process", async () => {
    const boss = await getBoss();
    const q = `ws5-sleep-${TAG.toLowerCase()}`;
    await boss.createQueue(q, { retryLimit: 2, retryDelay: 1 });
    let started = false;
    await boss.work(q, { pollingIntervalSeconds: 1 }, async () => { started = true; await sleep(60_000); });
    const id = await boss.send(q, { t: 1 });
    await until(async () => started, 20_000, 200);
    expect((await jobRow(id!)).state).toBe("active");
    const t0 = Date.now();
    await stopBoss(); // graceful with a 10 s deadline; the handler is still sleeping
    expect(Date.now() - t0).toBeLessThan(20_000);
    const after = await jobRow(id!);
    expect(after.state).not.toBe("active");
    expect(JSON.stringify(after.output ?? "")).toMatch(/shut down while active/);
    expect(["retry", "created"]).toContain(after.state); // handed back: the next worker picks it up
    const fresh = await getBoss(); // a new instance can start after the stop
    await fresh.deleteQueue(q);
  }, 60_000);
});

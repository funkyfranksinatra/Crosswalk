/**
 * The job queue: pg-boss on the application's own Postgres (schema `pgboss`). It gets its
 * own small connection pool (pg over TCP, or Neon's WebSocket pool where only HTTPS is
 * allowed — the same DATABASE_ADAPTER switch as the Prisma client; Prisma's raw-query
 * path cannot carry pg-boss's `regclass` results). One instance per process; the first
 * call starts it.
 *
 * Producers (API routes) only need `enqueue()`. Workers are started by
 * `startWorkers()` (src/lib/jobs/workers.ts) — inside the Next.js server by default
 * (`JOBS_WORKER=inline`), or in a separate `npm run worker` process
 * (`JOBS_WORKER=external` on the web server, `npm run worker` elsewhere).
 */
import { PgBoss } from "pg-boss";

type IDatabase = { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
import { prisma, strictSsl, adapterKind } from "@/lib/db";
import { log, withRequestContext } from "@/lib/log";
import { intEnv, enumEnv } from "@/lib/env";
import { QUEUES, type QueueName, type JobData } from "./queues";

const schemaEnv = process.env.JOBS_SCHEMA ?? "pgboss";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaEnv)) throw new Error("JOBS_SCHEMA must be a plain lowercase identifier");
export const JOBS_SCHEMA = schemaEnv;

type Db = IDatabase & { end(): Promise<void> };
type G = typeof globalThis & { __crosswalkBoss?: Promise<PgBoss> | null; __crosswalkBossStopped?: boolean; __crosswalkBossDb?: Db | null };
const g = globalThis as G;

export type JobsMode = "inline" | "external" | "off";
/**
 * JOBS_WORKER, validated: inline (default — this process enqueues and runs jobs), external (this
 * process only enqueues; `npm run worker` runs them) or off (no queue). Anything else — "on",
 * "yes", "true" — is NOT a mode: it is logged (env.invalid) and read as the default, inline, so a
 * typo leaves the queue processed rather than silently filling up with nobody working it.
 */
export function jobsMode(): JobsMode {
  return enumEnv("JOBS_WORKER", ["inline", "external", "off"] as const, "inline");
}
export function jobsEnabled(): boolean {
  return jobsMode() !== "off";
}

/** A pg-compatible pool for pg-boss, chosen like the Prisma adapter is (src/lib/db.ts). */
async function makeDb(): Promise<IDatabase & { end(): Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const max = intEnv("JOBS_POOL_MAX", 3, { min: 1, max: 100 });
  if (adapterKind() === "neon-ws") {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const ws = (await import("ws")).default;
    neonConfig.webSocketConstructor = ws;
    const pool = new Pool({ connectionString: url, max });
    // The raw driver result goes back as-is: pg-boss's multi-statement maintenance SQL yields an ARRAY of
    // results (one per statement) that it unwraps itself; wrapping it as { rows } would hide them.
    return { executeSql: (text: string, values?: unknown[]) => pool.query(text, values) as unknown as Promise<{ rows: unknown[] }>, end: () => pool.end() };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: strictSsl(url), max });
  return { executeSql: (text: string, values?: unknown[]) => pool.query(text, values) as unknown as Promise<{ rows: unknown[] }>, end: () => pool.end() };
}

/** The started pg-boss instance (starting it on first use). */
export function getBoss(): Promise<PgBoss> {
  if (!g.__crosswalkBoss) {
    // Detached from any request's log context: the boss's timers outlive the request that started it.
    g.__crosswalkBoss = detached(async () => {
      g.__crosswalkBossDb = await makeDb();
      const boss = new PgBoss({
        db: g.__crosswalkBossDb,
        schema: JOBS_SCHEMA,
        // Maintenance (expiring dead jobs, archiving) runs in every process; cheap and idempotent.
        maintenanceIntervalSeconds: intEnv("JOBS_MAINTENANCE_SECONDS", 60, { min: 1, max: 86_400 }),
        // pg-boss's own supervision loop — required for expired-job retries.
        supervise: true,
        schedule: true,
        migrate: true,
      });
      boss.on("error", (e: unknown) => log.error("jobs.boss_error", { error: e instanceof Error ? e.message : String(e) }));
      await boss.start();
      for (const [name, opts] of Object.entries(QUEUES)) {
        await boss.createQueue(name, { ...opts });
        // createQueue is create-if-missing: push the current retry/expiry options onto an existing
        // queue so an edit in queues.ts reaches every database. Policy is fixed at creation — if
        // ours changed (an upgrade), recreate an empty queue; one holding jobs is reported, not dropped.
        const q = await boss.getQueue(name);
        if (q && q.policy !== opts.policy) {
          if (q.totalCount === 0) { await boss.deleteQueue(name); await boss.createQueue(name, { ...opts }); log.warn("jobs.queue_recreated", { queue: name, from: q.policy, to: opts.policy }); }
          else log.warn("jobs.queue_policy_mismatch", { queue: name, have: q.policy, want: opts.policy, jobs: q.totalCount });
        } else if (q) {
          const { policy: _p, heartbeatSeconds: _h, ...rest } = opts as Record<string, unknown> & { policy: string; heartbeatSeconds?: number };
          void _p; void _h;
          const differs = Object.entries(rest).some(([k, v]) => (q as unknown as Record<string, unknown>)[k] !== v);
          if (differs) await boss.updateQueue(name, rest as never);
        }
      }
      g.__crosswalkBossStopped = false;
      log.info("jobs.started", { schema: JOBS_SCHEMA });
      return boss;
    }).catch((e: unknown) => {
      g.__crosswalkBoss = null;
      throw e;
    });
  }
  return g.__crosswalkBoss!;
}

/** Run `fn` outside the current AsyncLocalStorage log context. */
function detached<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => { setImmediate(() => { withRequestContext({ requestId: "boss" }, fn).then(resolve, reject); }); });
}

export type EnqueueOptions = { singletonKey?: string; startAfterSeconds?: number; priority?: number };

/**
 * Put a job on a queue. `singletonKey` makes the enqueue idempotent while an identical
 * job is still queued or running (pg-boss returns null instead of a second id).
 */
export async function enqueue<N extends QueueName>(name: N, data: JobData[N], opts: EnqueueOptions = {}): Promise<{ jobId: string | null; deduplicated: boolean }> {
  const boss = await getBoss();
  const sendOpts: Record<string, unknown> = {};
  // Job-level heartbeat as well as the queue's, so it applies even on a queue created before the option existed.
  const hb = (QUEUES[name] as { heartbeatSeconds?: number }).heartbeatSeconds;
  if (hb) sendOpts.heartbeatSeconds = hb;
  if (opts.singletonKey) sendOpts.singletonKey = opts.singletonKey;
  if (opts.startAfterSeconds) sendOpts.startAfter = opts.startAfterSeconds;
  if (opts.priority !== undefined) sendOpts.priority = opts.priority;
  const id = await boss.send(name, data as object, sendOpts);
  log.info("jobs.enqueued", { queue: name, jobId: id, deduplicated: id === null, singletonKey: opts.singletonKey ?? null });
  return { jobId: id, deduplicated: id === null };
}

export async function jobById(name: QueueName, id: string) {
  const boss = await getBoss();
  return boss.getJobById(name, id);
}

export type QueueHealth = { name: string; queued: number; ready: number; active: number; failed: number; oldestReadySeconds: number | null };

/**
 * Counts per queue plus the age of the oldest job that is ready but not picked up — the "stalled"
 * signal. The counts come from pg-boss's queue statistics, which it refreshes at most once per
 * minute (and less often under vacuum back-off); the stalled signal is read live from the job
 * table in one grouped query so /api/health and the alert never depend on a stale counter.
 */
export async function queueHealth(): Promise<QueueHealth[]> {
  const boss = await getBoss();
  const queues = await boss.getQueues(Object.keys(QUEUES));
  // Not caught: a failing query here must surface (health → degraded, alert rule → "could not run") rather than read as "nothing stalled".
  const ages = await prisma.$queryRawUnsafe<{ name: string; age: number | null }[]>(`SELECT name, EXTRACT(EPOCH FROM (now() - min(created_on)))::float AS age FROM ${JOBS_SCHEMA}.job WHERE state IN ('created','retry') AND start_after <= now() GROUP BY name`);
  const oldestBy = new Map(ages.map((r) => [r.name, r.age == null ? null : Math.round(Number(r.age))]));
  return queues.map((q) => ({ name: q.name, queued: q.queuedCount, ready: q.readyCount, active: q.activeCount, failed: q.failedCount, oldestReadySeconds: oldestBy.get(q.name) ?? null }));
}

/** Recent failures across queues (for the Settings → System panel and the alerts). */
export async function recentFailures(limit = 20) {
  const rows = await prisma.$queryRawUnsafe<{ id: string; name: string; data: unknown; output: unknown; retry_count: number; completed_on: Date | null }[]>(
    `SELECT id, name, data, output, retry_count, completed_on FROM ${JOBS_SCHEMA}.job WHERE state = 'failed' ORDER BY completed_on DESC NULLS LAST LIMIT $1`, limit,
  ).catch(() => []);
  return rows.map((r) => ({ id: r.id, queue: r.name, data: r.data, error: (r.output as { message?: string } | null)?.message ?? (typeof r.output === "string" ? r.output : null), retries: r.retry_count, failedAt: r.completed_on }));
}

export async function stopBoss() {
  if (!g.__crosswalkBoss || g.__crosswalkBossStopped) return;
  const boss = await g.__crosswalkBoss;
  g.__crosswalkBossStopped = true;
  await boss.stop({ graceful: true, timeout: 10_000 });
  await g.__crosswalkBossDb?.end().catch(() => undefined);
  g.__crosswalkBossDb = null;
  g.__crosswalkBoss = null;
}

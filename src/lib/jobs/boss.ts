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
import { prisma, strictSsl } from "@/lib/db";
import { log } from "@/lib/log";
import { QUEUES, type QueueName, type JobData } from "./queues";

export const JOBS_SCHEMA = process.env.JOBS_SCHEMA ?? "pgboss";

type G = typeof globalThis & { __crosswalkBoss?: Promise<PgBoss> | null; __crosswalkBossStopped?: boolean };
const g = globalThis as G;

export function jobsEnabled(): boolean {
  return (process.env.JOBS_WORKER ?? "inline") !== "off";
}

/** A pg-compatible pool for pg-boss, chosen like the Prisma adapter is (src/lib/db.ts). */
async function makeDb(): Promise<IDatabase & { end(): Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const max = Number(process.env.JOBS_POOL_MAX ?? 3);
  if ((process.env.DATABASE_ADAPTER ?? "pg").toLowerCase() === "neon-ws") {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const ws = (await import("ws")).default;
    neonConfig.webSocketConstructor = ws;
    const pool = new Pool({ connectionString: url, max });
    return { executeSql: async (text: string, values?: unknown[]) => { const r = await pool.query(text, values); return { rows: r.rows }; }, end: () => pool.end() };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: strictSsl(url), max });
  return { executeSql: async (text: string, values?: unknown[]) => { const r = await pool.query(text, values); return { rows: r.rows }; }, end: () => pool.end() };
}

let dbHandle: (IDatabase & { end(): Promise<void> }) | null = null;

/** The started pg-boss instance (starting it on first use). */
export function getBoss(): Promise<PgBoss> {
  if (!g.__crosswalkBoss) {
    g.__crosswalkBoss = (async () => {
      dbHandle = await makeDb();
      const boss = new PgBoss({
        db: dbHandle,
        schema: JOBS_SCHEMA,
        // Maintenance (expiring dead jobs, archiving) runs in every process; cheap and idempotent.
        maintenanceIntervalSeconds: Number(process.env.JOBS_MAINTENANCE_SECONDS ?? 60),
        // pg-boss's own supervision loop — required for expired-job retries.
        supervise: true,
        schedule: true,
        migrate: true,
      });
      boss.on("error", (e: unknown) => log.error("jobs.boss_error", { error: e instanceof Error ? e.message : String(e) }));
      await boss.start();
      for (const [name, opts] of Object.entries(QUEUES)) {
        await boss.createQueue(name, { ...opts });
        // A queue's policy is fixed at creation. If ours changed (an upgrade), recreate an empty
        // queue; a queue holding jobs is left alone and reported, never dropped.
        const q = await boss.getQueue(name);
        if (q && q.policy !== opts.policy) {
          if (q.totalCount === 0) { await boss.deleteQueue(name); await boss.createQueue(name, { ...opts }); log.warn("jobs.queue_recreated", { queue: name, from: q.policy, to: opts.policy }); }
          else log.warn("jobs.queue_policy_mismatch", { queue: name, have: q.policy, want: opts.policy, jobs: q.totalCount });
        }
      }
      g.__crosswalkBossStopped = false;
      log.info("jobs.started", { schema: JOBS_SCHEMA });
      return boss;
    })().catch((e) => {
      g.__crosswalkBoss = null;
      throw e;
    });
  }
  return g.__crosswalkBoss;
}

export type EnqueueOptions = { singletonKey?: string; startAfterSeconds?: number; priority?: number };

/**
 * Put a job on a queue. `singletonKey` makes the enqueue idempotent while an identical
 * job is still queued or running (pg-boss returns null instead of a second id).
 */
export async function enqueue<N extends QueueName>(name: N, data: JobData[N], opts: EnqueueOptions = {}): Promise<{ jobId: string | null; deduplicated: boolean }> {
  const boss = await getBoss();
  const sendOpts: Record<string, unknown> = {};
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

/** Counts per queue plus the age of the oldest job that is ready but not picked up — the "stalled" signal. */
export async function queueHealth(): Promise<QueueHealth[]> {
  const boss = await getBoss();
  const queues = await boss.getQueues(Object.keys(QUEUES));
  const out: QueueHealth[] = [];
  for (const q of queues) {
    let oldest: number | null = null;
    if (q.readyCount > 0) {
      const rows = await prisma.$queryRawUnsafe<{ age: number | null }[]>(`SELECT EXTRACT(EPOCH FROM (now() - min(created_on)))::float AS age FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND state IN ('created','retry') AND start_after <= now()`, q.name).catch(() => [{ age: null }]);
      oldest = rows[0]?.age == null ? null : Math.round(Number(rows[0].age));
    }
    out.push({ name: q.name, queued: q.queuedCount, ready: q.readyCount, active: q.activeCount, failed: q.failedCount, oldestReadySeconds: oldest });
  }
  return out;
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
  await dbHandle?.end().catch(() => undefined);
  dbHandle = null;
  g.__crosswalkBoss = null;
}

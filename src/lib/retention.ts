/**
 * Data retention (Tier 0.7) — a nightly sweep that deletes what the organisation has decided
 * not to keep. OFF by default: nothing is deleted until RETENTION_ENABLED=true, and the one
 * class that holds customer data (cross-reference requests with the prospect's purchase
 * list) is deleted only when RETENTION_REQUESTS_DAYS is set explicitly — that number is a
 * legal decision, not a default. Audit events are never deleted by this job.
 *
 * Classes and the environment variable that sets each window (days; unset = keep):
 *   requests        RETENTION_REQUESTS_DAYS        finished requests (complete/failed/cancelled) older
 *                                                  than N days that no proposal references — lines,
 *                                                  candidates and the uploaded list go with them; match
 *                                                  decisions (learning data) are kept, unlinked
 *   llmCalls        RETENTION_LLM_CALLS_DAYS       model-call telemetry            (default 90 when enabled)
 *   syncLog         RETENTION_SYNC_LOG_DAYS        integration sync log            (default 180)
 *   feedRuns        RETENTION_FEED_RUNS_DAYS       feed / bid-pull run records     (default 180)
 *   notifications   RETENTION_NOTIFICATIONS_DAYS   read in-app notifications       (default 180)
 *   snapshots       RETENTION_SNAPSHOTS_DAYS       analytics snapshots, always keeping the newest per report (default 90)
 *   alerts          RETENTION_ALERTS_DAYS          resolved alerts                 (default 90)
 *
 * RETENTION_DRY_RUN=true reports what would go without deleting. Every sweep — dry or not —
 * writes one RETENTION_SWEEP audit event with the counts. Deletes are batched (RETENTION_BATCH,
 * default 5000 rows per class per run; requests at most 200, in chunks of 25, because each
 * cascades) so a first sweep over a long history never holds a long lock; the next night
 * takes the next batch.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";

type Env = Record<string, string | undefined>;

export type RetentionConfig = {
  enabled: boolean;
  dryRun: boolean;
  batch: number;
  days: { requests: number | null; llmCalls: number | null; syncLog: number | null; feedRuns: number | null; notifications: number | null; snapshots: number | null; alerts: number | null };
};

const DEFAULTS = { llmCalls: 90, syncLog: 180, feedRuns: 180, notifications: 180, snapshots: 90, alerts: 90 } as const;

function days(env: Env, key: string, fallback: number | null): number | null {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (/^(off|never|none|0)$/i.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${key} must be a whole number of days (>= 1), "off", or unset`);
  return Math.floor(n);
}

export function retentionConfig(env: Env = process.env): RetentionConfig {
  const enabled = (env.RETENTION_ENABLED ?? "").toLowerCase() === "true";
  const batch = Number(env.RETENTION_BATCH ?? 5000);
  return {
    enabled,
    dryRun: (env.RETENTION_DRY_RUN ?? "").toLowerCase() === "true",
    batch: Number.isFinite(batch) && batch >= 1 ? Math.min(100_000, Math.floor(batch)) : 5000,
    days: {
      requests: days(env, "RETENTION_REQUESTS_DAYS", null), // never implied
      llmCalls: days(env, "RETENTION_LLM_CALLS_DAYS", DEFAULTS.llmCalls),
      syncLog: days(env, "RETENTION_SYNC_LOG_DAYS", DEFAULTS.syncLog),
      feedRuns: days(env, "RETENTION_FEED_RUNS_DAYS", DEFAULTS.feedRuns),
      notifications: days(env, "RETENTION_NOTIFICATIONS_DAYS", DEFAULTS.notifications),
      snapshots: days(env, "RETENTION_SNAPSHOTS_DAYS", DEFAULTS.snapshots),
      alerts: days(env, "RETENTION_ALERTS_DAYS", DEFAULTS.alerts),
    },
  };
}

export type SweepResult = { dryRun: boolean; counts: Record<string, number>; more: Record<string, boolean> };

const cutoff = (d: number, now: Date) => new Date(now.getTime() - d * 86_400_000);

/**
 * One sweep. `force` runs even when RETENTION_ENABLED is not set (the operator script, always
 * with an explicit config); the scheduled job never forces.
 */
export async function runRetention(cfg: RetentionConfig = retentionConfig(), opts: { now?: Date; force?: boolean; actorUserId?: string | null } = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const counts: Record<string, number> = {};
  const more: Record<string, boolean> = {};
  if (!cfg.enabled && !opts.force) { log.info("retention.skipped", { reason: "RETENTION_ENABLED is not true" }); return { dryRun: true, counts, more }; }
  const take = cfg.batch;

  // Customer data: finished requests nobody built a proposal from. A request cascades to its
  // lines and candidates (hundreds of rows each), so these go in small chunks with no long
  // transaction — the unlink and the delete need not be atomic (MatchDecision has no FK).
  if (cfg.days.requests !== null) {
    const reqTake = Math.min(take, 200);
    const rows = await prisma.request.findMany({ where: { status: { in: ["complete", "failed", "cancelled"] }, createdAt: { lt: cutoff(cfg.days.requests, now) }, proposals: { none: {} } }, select: { id: true }, take: reqTake + 1, orderBy: { createdAt: "asc" } });
    more.requests = rows.length > reqTake;
    const ids = rows.slice(0, reqTake).map((r) => r.id);
    counts.requests = ids.length;
    if (ids.length && !cfg.dryRun) {
      for (let i = 0; i < ids.length; i += 25) {
        const chunk = ids.slice(i, i + 25);
        const lineIds = (await prisma.requestLine.findMany({ where: { requestId: { in: chunk } }, select: { id: true } })).map((l) => l.id);
        if (lineIds.length) await prisma.matchDecision.updateMany({ where: { requestLineId: { in: lineIds } }, data: { requestLineId: null } });
        await prisma.request.deleteMany({ where: { id: { in: chunk } } }); // lines and candidates cascade
      }
    }
  }

  const simple = async (name: string, d: number | null, count: () => Promise<number>, del: () => Promise<{ count: number }>) => {
    if (d === null) return;
    const n = await count();
    counts[name] = Math.min(n, take);
    more[name] = n > take;
    if (n && !cfg.dryRun) await del();
  };
  if (cfg.days.llmCalls !== null) {
    const c = cutoff(cfg.days.llmCalls, now);
    await simple("llmCalls", cfg.days.llmCalls, () => prisma.llmCall.count({ where: { createdAt: { lt: c } } }), async () => {
      const ids = (await prisma.llmCall.findMany({ where: { createdAt: { lt: c } }, select: { id: true }, take, orderBy: { createdAt: "asc" } })).map((r) => r.id);
      return prisma.llmCall.deleteMany({ where: { id: { in: ids } } });
    });
  }
  if (cfg.days.syncLog !== null) {
    const c = cutoff(cfg.days.syncLog, now);
    await simple("syncLog", cfg.days.syncLog, () => prisma.syncLog.count({ where: { at: { lt: c } } }), async () => {
      const ids = (await prisma.syncLog.findMany({ where: { at: { lt: c } }, select: { id: true }, take, orderBy: { at: "asc" } })).map((r) => r.id);
      return prisma.syncLog.deleteMany({ where: { id: { in: ids } } });
    });
  }
  if (cfg.days.feedRuns !== null) {
    const c = cutoff(cfg.days.feedRuns, now);
    const where = { startedAt: { lt: c }, status: { not: "RUNNING" } };
    await simple("feedRuns", cfg.days.feedRuns, () => prisma.feedRun.count({ where }), async () => {
      const ids = (await prisma.feedRun.findMany({ where, select: { id: true }, take, orderBy: { startedAt: "asc" } })).map((r) => r.id);
      return prisma.feedRun.deleteMany({ where: { id: { in: ids } } });
    });
  }
  if (cfg.days.notifications !== null) {
    const c = cutoff(cfg.days.notifications, now);
    const where = { createdAt: { lt: c }, readAt: { not: null } };
    await simple("notifications", cfg.days.notifications, () => prisma.notification.count({ where }), async () => {
      const ids = (await prisma.notification.findMany({ where, select: { id: true }, take, orderBy: { createdAt: "asc" } })).map((r) => r.id);
      return prisma.notification.deleteMany({ where: { id: { in: ids } } });
    });
  }
  if (cfg.days.snapshots !== null) {
    const c = cutoff(cfg.days.snapshots, now);
    // The newest snapshot of every report stays whatever its age: the UI reads it.
    const latest = await prisma.analyticsSnapshot.groupBy({ by: ["report"], _max: { computedAt: true } });
    const keep = latest.map((l) => ({ report: l.report, computedAt: l._max.computedAt! }));
    const where = { computedAt: { lt: c }, NOT: keep.length ? keep.map((k) => ({ report: k.report, computedAt: k.computedAt })) : undefined };
    await simple("snapshots", cfg.days.snapshots, () => prisma.analyticsSnapshot.count({ where }), async () => {
      const ids = (await prisma.analyticsSnapshot.findMany({ where, select: { id: true }, take, orderBy: { computedAt: "asc" } })).map((r) => r.id);
      return prisma.analyticsSnapshot.deleteMany({ where: { id: { in: ids } } });
    });
  }
  if (cfg.days.alerts !== null) {
    const c = cutoff(cfg.days.alerts, now);
    const where = { resolvedAt: { lt: c } };
    await simple("alerts", cfg.days.alerts, () => prisma.alert.count({ where }), async () => {
      const ids = (await prisma.alert.findMany({ where, select: { id: true }, take, orderBy: { resolvedAt: "asc" } })).map((r) => r.id);
      return prisma.alert.deleteMany({ where: { id: { in: ids } } });
    });
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  log.info("retention.sweep", { dryRun: cfg.dryRun, counts, more });
  await audit({ actorUserId: opts.actorUserId ?? null, entityType: "System", entityId: "retention", action: cfg.dryRun ? "RETENTION_DRY_RUN" : "RETENTION_SWEEP", context: { counts, more, days: cfg.days, batch: cfg.batch, total } }).catch(() => undefined);
  return { dryRun: cfg.dryRun, counts, more };
}

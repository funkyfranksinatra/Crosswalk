/**
 * Materialised analytics (Tier 3.8). The reports in ./index.ts scan proposals, outcomes,
 * decisions and observations on every request; at pilot volume that is fine, at scale it is
 * not. `refreshSnapshots` computes each report once and stores it (AnalyticsSnapshot); the
 * pages read the latest snapshot and say how old it is. A report with no snapshot yet is
 * computed live (and stored) so a fresh deployment is never blank.
 *
 * Refresh triggers: the hourly cron (ANALYTICS_CRON), a commercial event (outcome recorded,
 * proposal decided — `requestAnalyticsRefresh`, debounced through the queue's singleton key),
 * and the Refresh button on the page.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { winLoss, pricingEffectiveness, conversion, crossReferenceAccuracy } from "./index";

export const REPORTS = ["winloss", "pricing", "conversion", "accuracy"] as const;
export type Report = (typeof REPORTS)[number];

const compute: Record<Report, () => Promise<unknown>> = { winloss: winLoss, pricing: pricingEffectiveness, conversion, accuracy: crossReferenceAccuracy };

export function isReport(x: string): x is Report { return (REPORTS as readonly string[]).includes(x); }

/** Snapshots older than this are served but flagged stale (the page shows a warning and a Refresh button). */
export const STALE_AFTER_MS = Math.max(60_000, Number(process.env.ANALYTICS_STALE_MINUTES ?? 120) * 60_000);
/** History kept per report (for "as of" comparisons and debugging); older rows are pruned on refresh. */
const KEEP = 24;

/** Keep a short history per report; the pages only read the newest. */
async function prune(report: Report) {
  const old = await prisma.analyticsSnapshot.findMany({ where: { report }, orderBy: { computedAt: "desc" }, skip: KEEP, select: { id: true } }).catch(() => []);
  if (old.length) await prisma.analyticsSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } }).catch(() => undefined);
}

export async function refreshSnapshots(reports: readonly string[] | undefined, trigger: "schedule" | "event" | "manual" = "schedule"): Promise<Record<string, { ms: number; ok: boolean; error?: string }>> {
  const list = (reports?.length ? reports : REPORTS).filter(isReport);
  const out: Record<string, { ms: number; ok: boolean; error?: string }> = {};
  for (const r of list) {
    const t0 = Date.now();
    try {
      const data = await compute[r]();
      const ms = Date.now() - t0;
      await prisma.analyticsSnapshot.create({ data: { report: r, json: JSON.stringify(data), durationMs: ms, trigger } });
      await prune(r);
      out[r] = { ms, ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out[r] = { ms: Date.now() - t0, ok: false, error };
      log.error("analytics.refresh_failed", { report: r, error });
    }
  }
  log.info("analytics.refreshed", { trigger, reports: out });
  return out;
}

export type Served<T> = { data: T; asOf: string; ageMs: number; stale: boolean; source: "snapshot" | "live"; durationMs: number };

/** The latest snapshot of a report, computing it live (and storing it) when none exists or `fresh` is asked. */
export async function readReport<T = unknown>(report: Report, opts: { fresh?: boolean } = {}): Promise<Served<T>> {
  if (!opts.fresh) {
    const snap = await prisma.analyticsSnapshot.findFirst({ where: { report }, orderBy: { computedAt: "desc" } });
    if (snap) {
      const ageMs = Date.now() - snap.computedAt.getTime();
      return { data: JSON.parse(snap.json) as T, asOf: snap.computedAt.toISOString(), ageMs, stale: ageMs > STALE_AFTER_MS, source: "snapshot", durationMs: snap.durationMs };
    }
  }
  const t0 = Date.now();
  const data = (await compute[report]()) as T;
  const durationMs = Date.now() - t0;
  const row = await prisma.analyticsSnapshot.create({ data: { report, json: JSON.stringify(data), durationMs, trigger: "manual" } }).catch(() => null);
  await prune(report);
  return { data, asOf: (row?.computedAt ?? new Date()).toISOString(), ageMs: 0, stale: false, source: "live", durationMs };
}

/**
 * Ask for a refresh after a commercial event. Debounced: one queued refresh at a time, 30 s after the
 * event. The queue keeps only the first job's payload while one is waiting, so an event refresh always
 * covers every report — a second event's list would otherwise be dropped.
 */
export async function requestAnalyticsRefresh(_reports?: readonly string[], trigger: "event" | "manual" = "event"): Promise<void> {
  try {
    const { enqueue, jobsEnabled } = await import("@/lib/jobs/boss");
    if (!jobsEnabled()) return;
    await enqueue("analytics.refresh", { trigger }, { singletonKey: trigger === "manual" ? "analytics:manual" : "analytics:event", startAfterSeconds: trigger === "manual" ? 0 : 30 });
  } catch (e) {
    log.warn("analytics.enqueue_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

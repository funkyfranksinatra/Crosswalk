/**
 * Monitoring rules, evaluated every few minutes by the `alerts.evaluate` queue and on
 * demand from Settings → System. Each rule yields zero or more conditions with a stable
 * fingerprint; the Alert table keeps one row per fingerprint so a condition that fires
 * for hours notifies once (and again every ALERT_RENOTIFY_HOURS), and is marked resolved
 * the moment it stops firing.
 *
 * Rules (thresholds from the environment, defaults in brackets):
 *   model_unreachable    LLM configured and the recent model calls are failing        CRITICAL
 *   resolution_rate_low  last completed run resolved < ALERT_RESOLUTION_MIN [0.7]     WARNING
 *   runs_failing         > ALERT_RUN_FAILURES [2] failed runs in the last 24 h         WARNING
 *   queue_stalled        a ready job older than ALERT_QUEUE_STALL_MIN [15] minutes    WARNING / CRITICAL at 4×
 *   jobs_failed          jobs that exhausted their retries in the last 24 h            WARNING
 *   feed_stale           a connected, scheduled feed without an OK run in its window    WARNING
 *   feed_failed          a feed whose last run failed                                   CRITICAL
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { llmConfig } from "@/lib/llm/client";
import { alertsFiring } from "./metrics";

export type Severity = "INFO" | "WARNING" | "CRITICAL";
export type Condition = { fingerprint: string; rule: string; severity: Severity; title: string; detail?: string | null; context?: Record<string, unknown> };

const num = (env: string, def: number) => { const v = Number(process.env[env]); return Number.isFinite(v) && v > 0 ? v : def; };

export async function modelRule(): Promise<Condition[]> {
  if (!llmConfig().available) return [];
  const recent = await prisma.llmCall.findMany({ where: { createdAt: { gt: new Date(Date.now() - 30 * 60_000) } }, orderBy: { createdAt: "desc" }, take: 5, select: { ok: true, error: true } });
  if (recent.length < 3) return [];
  const failed = recent.filter((c) => !c.ok);
  if (failed.length < Math.max(3, Math.ceil(recent.length * 0.6))) return [];
  return [{ fingerprint: "model_unreachable", rule: "model_unreachable", severity: "CRITICAL", title: `Model ${llmConfig().model} is failing (${failed.length} of the last ${recent.length} calls)`, detail: failed[0]?.error ?? null }];
}

export async function resolutionRule(): Promise<Condition[]> {
  const min = num("ALERT_RESOLUTION_MIN", 0.7);
  const last = await prisma.request.findFirst({ where: { status: "complete" }, orderBy: { completedAt: "desc" }, select: { id: true, reference: true, _count: { select: { lines: true } } } });
  if (!last || last._count.lines < 5) return [];
  const resolved = await prisma.requestLine.count({ where: { requestId: last.id, resolutionStatus: "resolved" } });
  const rate = resolved / last._count.lines;
  if (rate >= min) return [];
  return [{ fingerprint: "resolution_rate_low", rule: "resolution_rate_low", severity: "WARNING", title: `${last.reference} resolved only ${Math.round(rate * 100)}% of its codes (threshold ${Math.round(min * 100)}%)`, detail: "GUDID coverage dropped, openFDA was unreachable, or the list is from a labeler not in the library.", context: { requestId: last.id, rate } }];
}

export async function runsRule(): Promise<Condition[]> {
  const max = num("ALERT_RUN_FAILURES", 2);
  const failed = await prisma.request.count({ where: { status: "failed", updatedAt: { gt: new Date(Date.now() - 86_400_000) } } });
  if (failed <= max) return [];
  return [{ fingerprint: "runs_failing", rule: "runs_failing", severity: "WARNING", title: `${failed} cross-reference runs failed in the last 24 hours`, context: { failed } }];
}

export async function queueRule(): Promise<Condition[]> {
  const stallMin = num("ALERT_QUEUE_STALL_MIN", 15);
  const out: Condition[] = [];
  try {
    const { queueHealth, recentFailures } = await import("@/lib/jobs/boss");
    for (const q of await queueHealth()) {
      if (q.oldestReadySeconds !== null && q.oldestReadySeconds > stallMin * 60) {
        const minutes = Math.round(q.oldestReadySeconds / 60);
        out.push({ fingerprint: `queue_stalled:${q.name}`, rule: "queue_stalled", severity: minutes > stallMin * 4 ? "CRITICAL" : "WARNING", title: `Queue ${q.name} has a job waiting for ${minutes} minutes`, detail: "No worker is picking jobs up. Is the worker process running (JOBS_WORKER)?", context: { queue: q.name, ready: q.ready, minutes } });
      }
    }
    const failures = (await recentFailures(50)).filter((f) => f.failedAt && Date.now() - new Date(f.failedAt).getTime() < 86_400_000);
    if (failures.length) out.push({ fingerprint: "jobs_failed", rule: "jobs_failed", severity: "WARNING", title: `${failures.length} background job${failures.length === 1 ? "" : "s"} exhausted retries in the last 24 hours`, detail: failures.slice(0, 3).map((f) => `${f.queue}: ${f.error ?? "?"}`).join("\n"), context: { count: failures.length } });
  } catch (e) {
    log.warn("alerts.queue_rule_error", { error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

export async function feedRule(): Promise<Condition[]> {
  const { feedStatuses } = await import("@/lib/feeds");
  const out: Condition[] = [];
  for (const f of await feedStatuses()) {
    if (f.lastRun?.status === "FAILED") out.push({ fingerprint: `feed_failed:${f.name}`, rule: "feed_failed", severity: "CRITICAL", title: `Feed "${f.title}" failed its last run`, detail: f.lastRun.error, context: { feed: f.name } });
    else if (f.stale) out.push({ fingerprint: `feed_stale:${f.name}`, rule: "feed_stale", severity: "WARNING", title: `Feed "${f.title}" is stale — ${f.lastOk ? `last successful run ${Math.round(f.ageHours ?? 0)} h ago` : "it has never run"} (window ${f.maxAgeHours} h)`, context: { feed: f.name, ageHours: f.ageHours } });
  }
  return out;
}

export const RULES: (() => Promise<Condition[]>)[] = [modelRule, resolutionRule, runsRule, queueRule, feedRule];

/** Run every rule, reconcile the Alert table, notify on new/renewed conditions. */
export async function evaluateAlerts(): Promise<{ firing: Condition[]; resolved: number; notified: number }> {
  const firing: Condition[] = [];
  for (const rule of RULES) {
    try { firing.push(...(await rule())); } catch (e) { log.error("alerts.rule_error", { rule: rule.name, error: e instanceof Error ? e.message : String(e) }); }
  }
  const renotifyMs = num("ALERT_RENOTIFY_HOURS", 6) * 3600_000;
  const now = new Date();
  let notified = 0;
  const { notifyAlert } = await import("@/lib/notifications");
  for (const c of firing) {
    const existing = await prisma.alert.findUnique({ where: { fingerprint: c.fingerprint } });
    const renewed = !existing || existing.resolvedAt !== null;
    const row = await prisma.alert.upsert({
      where: { fingerprint: c.fingerprint },
      create: { fingerprint: c.fingerprint, rule: c.rule, severity: c.severity, title: c.title, detail: c.detail ?? null, contextJson: c.context ? JSON.stringify(c.context) : null },
      update: { severity: c.severity, title: c.title, detail: c.detail ?? null, contextJson: c.context ? JSON.stringify(c.context) : null, lastFiredAt: now, resolvedAt: null, ...(renewed ? { firstFiredAt: now } : {}) },
    });
    const due = renewed || !row.lastNotifiedAt || now.getTime() - row.lastNotifiedAt.getTime() > renotifyMs;
    if (due) {
      await notifyAlert({ fingerprint: row.fingerprint, severity: row.severity, title: row.title, detail: row.detail, id: row.id }).catch((e) => log.warn("alerts.notify_failed", { fingerprint: c.fingerprint, error: e instanceof Error ? e.message : String(e) }));
      await prisma.alert.update({ where: { id: row.id }, data: { lastNotifiedAt: now } });
      notified++;
    }
  }
  const resolvedRes = await prisma.alert.updateMany({ where: { resolvedAt: null, fingerprint: { notIn: firing.map((c) => c.fingerprint) } }, data: { resolvedAt: now } });
  alertsFiring.clear();
  for (const sev of ["INFO", "WARNING", "CRITICAL"] as const) alertsFiring.set({ severity: sev }, firing.filter((c) => c.severity === sev).length);
  log.info("alerts.evaluated", { firing: firing.length, resolved: resolvedRes.count, notified });
  return { firing, resolved: resolvedRes.count, notified };
}

export async function activeAlerts() {
  return prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: [{ severity: "desc" }, { lastFiredAt: "desc" }] });
}

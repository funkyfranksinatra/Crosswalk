/**
 * Per-integration schedules. Each enabled IntegrationConfig with a scheduleCron gets one
 * pg-boss schedule per sync type (key `integration-<key>-<syncType>`); disabled or
 * unscheduled integrations are unscheduled. Called at worker start and whenever a
 * configuration is saved, so the admin UI's schedule field takes effect without a restart.
 */
import type { PgBoss } from "pg-boss";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { INTEGRATION_KEYS, isIntegrationKey } from "./config";
import { INTEGRATIONS } from "./registry";

const scheduleKey = (k: string, syncType: string) => `integration-${k.replace(/[^A-Za-z0-9_-]/g, "-")}-${syncType}`;

export async function scheduleIntegrations(boss: PgBoss, only?: string): Promise<void> {
  if (!only) { const { cancelStaleJobs } = await import("./jobs"); const n = await cancelStaleJobs().catch(() => 0); if (n) log.warn("integration.stale_jobs_cancelled", { count: n }); }
  const rows = await prisma.integrationConfig.findMany({ select: { key: true, enabled: true, scheduleCron: true } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const k of INTEGRATION_KEYS) {
    if (only && k !== only) continue;
    const row = byKey.get(k);
    const on = Boolean(row?.enabled && row.scheduleCron);
    for (const st of INTEGRATIONS[k].syncTypes) {
      const key = scheduleKey(k, st.id);
      if (!on) { await boss.unschedule("integration.sync", key).catch(() => undefined); continue; }
      try { await boss.schedule("integration.sync", row!.scheduleCron!, { key: k, syncType: st.id, trigger: "schedule", actorUserId: null }, { tz: "UTC", key, singletonKey: `integration:${k}:${st.id}`, missed: "once" }); }
      catch (e) { log.error("jobs.schedule_failed", { queue: "integration.sync", integration: k, cron: row!.scheduleCron, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
}

/** Re-apply one integration's schedule after a save (no-op when the job system is off). */
export async function rescheduleIntegration(k: string): Promise<void> {
  if (!isIntegrationKey(k)) return;
  try { const { getBoss } = await import("@/lib/jobs/boss"); const boss = await getBoss(); await scheduleIntegrations(boss, k); }
  catch (e) { log.warn("integration.reschedule_skipped", { integration: k, error: e instanceof Error ? e.message : String(e) }); }
}

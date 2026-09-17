import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { llmConfig } from "@/lib/llm/client";
import { channelsConfigured } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness for a load balancer or uptime check. Unauthenticated, so it says
 * only whether each dependency answers — never data, versions of secrets, or hostnames.
 * 200 when the database answers; 503 otherwise.
 */
export async function GET() {
  const t0 = Date.now();
  const checks: Record<string, { ok: boolean; ms?: number; detail?: string }> = {};
  try {
    const t = Date.now();
    await prisma.$queryRawUnsafe("SELECT 1");
    checks.database = { ok: true, ms: Date.now() - t };
  } catch {
    checks.database = { ok: false, detail: "unreachable" };
  }
  try {
    const { queueHealth, jobsEnabled } = await import("@/lib/jobs/boss");
    if (!jobsEnabled()) checks.jobs = { ok: true, detail: "disabled" };
    else {
      const t = Date.now();
      const q = await queueHealth();
      const stalled = q.filter((x) => x.oldestReadySeconds !== null && x.oldestReadySeconds > 900);
      checks.jobs = { ok: stalled.length === 0, ms: Date.now() - t, detail: stalled.length ? `stalled: ${stalled.map((s) => s.name).join(", ")}` : `${q.reduce((a, x) => a + x.active, 0)} active, ${q.reduce((a, x) => a + x.ready, 0)} ready` };
    }
  } catch {
    checks.jobs = { ok: false, detail: "queue unavailable" };
  }
  checks.model = { ok: true, detail: llmConfig().available ? "configured" : "not configured (heuristic mode)" };
  const ch = channelsConfigured();
  checks.notifications = { ok: true, detail: `in-app${ch.email ? ", email" : ""}${ch.teams ? ", teams" : ""}` };
  try {
    const { feedStatuses } = await import("@/lib/feeds");
    const feeds = await feedStatuses();
    const stale = feeds.filter((f) => f.stale).map((f) => f.name);
    checks.feeds = { ok: stale.length === 0, detail: stale.length ? `stale: ${stale.join(", ")}` : `${feeds.filter((f) => f.source.kind !== "none").length} connected` };
  } catch {
    checks.feeds = { ok: false, detail: "unavailable" };
  }
  const ok = checks.database.ok;
  return NextResponse.json({ ok, status: ok ? "ready" : "degraded", checks, ms: Date.now() - t0, at: new Date().toISOString() }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

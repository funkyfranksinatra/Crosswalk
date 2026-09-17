import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness for a load balancer or uptime check. Unauthenticated, so it is cheap
 * (two queries) and says only whether the database and the job queue answer — no names,
 * no counts, no integration topology. The detailed picture is on /api/system
 * (configure_settings) and /api/metrics (token or ADMIN).
 */
export async function GET() {
  const t0 = Date.now();
  const checks: Record<string, { ok: boolean; ms?: number }> = {};
  try {
    const t = Date.now();
    await prisma.$queryRawUnsafe("SELECT 1");
    checks.database = { ok: true, ms: Date.now() - t };
  } catch {
    checks.database = { ok: false };
  }
  try {
    const { jobsEnabled, queueHealth } = await import("@/lib/jobs/boss");
    if (!jobsEnabled()) checks.jobs = { ok: true };
    else {
      const t = Date.now();
      const q = await queueHealth();
      checks.jobs = { ok: !q.some((x) => x.oldestReadySeconds !== null && x.oldestReadySeconds > 900), ms: Date.now() - t };
    }
  } catch {
    checks.jobs = { ok: false };
  }
  const ok = checks.database.ok;
  return NextResponse.json({ ok, status: ok ? (checks.jobs.ok ? "ready" : "degraded") : "down", checks, ms: Date.now() - t0 }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

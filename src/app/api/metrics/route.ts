import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getActor } from "@/lib/auth";
import { render, queueDepth, queueOldestReady } from "@/lib/observability/metrics";

export const dynamic = "force-dynamic";

/**
 * Prometheus scrape endpoint. Authorised by `Authorization: Bearer $METRICS_TOKEN`
 * (for the scraper) or an ADMIN session (for a person). Without METRICS_TOKEN set, only
 * an ADMIN session works — the endpoint is never open.
 */
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN;
  const auth = req.headers.get("authorization") ?? "";
  let allowed = false;
  if (token && auth.startsWith("Bearer ")) {
    const given = Buffer.from(auth.slice(7)), want = Buffer.from(token);
    allowed = given.length === want.length && timingSafeEqual(given, want);
  }
  if (!allowed) {
    const actor = await getActor().catch(() => null);
    allowed = Boolean(actor?.roles.includes("ADMIN"));
  }
  if (!allowed) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  try {
    const { queueHealth, jobsEnabled } = await import("@/lib/jobs/boss");
    if (jobsEnabled()) {
      queueDepth.clear(); queueOldestReady.clear();
      for (const q of await queueHealth()) {
        queueDepth.set({ queue: q.name, state: "ready" }, q.ready);
        queueDepth.set({ queue: q.name, state: "active" }, q.active);
        queueDepth.set({ queue: q.name, state: "failed" }, q.failed);
        queueOldestReady.set({ queue: q.name }, q.oldestReadySeconds ?? 0);
      }
    }
    const { feedStatuses } = await import("@/lib/feeds");
    await feedStatuses(); // refreshes the feed-age gauges
  } catch { /* metrics must render even when the queue is down */ }
  return new NextResponse(render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}

import { handle } from "@/lib/api";
import { redactJsonForActor } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isReport, readReport, refreshSnapshots, requestAnalyticsRefresh, STALE_AFTER_MS } from "@/lib/analytics/snapshots";
import { jobsEnabled } from "@/lib/jobs/boss";

/**
 * Analytics reports are served from materialised snapshots (Tier 3): the payload carries
 * `asOf`, `ageMs` and `stale` so the page can say how current the numbers are. Margin fields
 * are redacted for actors without view_margin. `?fresh=1` recomputes on the spot when the
 * snapshot is older than a minute; POST refreshes every report through the queue.
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  return handle("view_analytics", async (actor) => {
    if (!isReport(report)) throw new Error("unknown report");
    let served = await readReport(report);
    // A fresh read is a full recompute: allow it once a minute per report, not per request.
    if (fresh && (served.source === "snapshot" && served.ageMs > 60_000)) served = await readReport(report, { fresh: true });
    return { ...(redactJsonForActor(actor, served.data) as Record<string, unknown>), _meta: { asOf: served.asOf, ageMs: served.ageMs, stale: served.stale, source: served.source, durationMs: served.durationMs, staleAfterMs: STALE_AFTER_MS } };
  });
}

export async function POST(_req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return handle("view_analytics", async () => {
    if (report !== "all" && !isReport(report)) throw new Error("unknown report");
    const reports = report === "all" ? undefined : [report];
    if (jobsEnabled()) { await requestAnalyticsRefresh(reports, "manual"); return { queued: true, note: "Refresh queued; the page updates when it finishes" }; }
    // No queue (scripts / demos): compute inline, but never more than once a minute.
    const newest = await prisma.analyticsSnapshot.findFirst({ orderBy: { computedAt: "desc" }, select: { computedAt: true } });
    if (newest && Date.now() - newest.computedAt.getTime() < 60_000) return { queued: false, note: "Refreshed less than a minute ago" };
    return refreshSnapshots(reports, "manual");
  });
}

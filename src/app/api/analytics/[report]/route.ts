import { handle } from "@/lib/api";
import { isReport, readReport, refreshSnapshots } from "@/lib/analytics/snapshots";

/**
 * Analytics reports are served from materialised snapshots (Tier 3): the payload carries
 * `asOf`, `ageMs` and `stale` so the page can say how current the numbers are.
 * `?fresh=1` recomputes on the spot (and stores the result); POST refreshes every report.
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  return handle("view_analytics", async () => {
    if (!isReport(report)) throw new Error("unknown report");
    const served = await readReport(report, { fresh });
    return { ...(served.data as Record<string, unknown>), _meta: { asOf: served.asOf, ageMs: served.ageMs, stale: served.stale, source: served.source, durationMs: served.durationMs } };
  });
}

export async function POST(_req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return handle("view_analytics", async () => {
    if (report !== "all" && !isReport(report)) throw new Error("unknown report");
    return refreshSnapshots(report === "all" ? undefined : [report], "manual");
  });
}

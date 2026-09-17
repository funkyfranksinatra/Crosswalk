import { handle, body } from "@/lib/api";
import { audit } from "@/lib/audit";
import { listAwards, bidSettings, saveBidSettings, bidSourcesConfigured, BID_SOURCES, type BidSource } from "@/lib/intelligence/bids";
import { enqueue, jobsEnabled } from "@/lib/jobs/boss";

/** Public bid intelligence: the award list, the pull settings, and "pull now". */
export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle("view_pricing", async () => {
    const [list, settings, configured] = await Promise.all([
      listAwards({ q: u.searchParams.get("q"), source: u.searchParams.get("source"), competitorId: u.searchParams.get("competitorId"), sinceDays: Number(u.searchParams.get("sinceDays") ?? 365) || null }),
      bidSettings(), bidSourcesConfigured(),
    ]);
    return { ...list, settings, sources: BID_SOURCES.map((s) => ({ source: s, configured: configured.includes(s), note: s === "sam" ? (configured.includes(s) ? "SAM.gov award notices (SAM_API_KEY set)" : "Set SAM_API_KEY to pull SAM.gov award notices") : "USAspending.gov contract awards (no key needed)" })), queue: jobsEnabled() };
  });
}

export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const b = await body<{ action?: string; source?: string; settings?: unknown; lookbackDays?: number }>(req);
    if (b.action === "settings") {
      const s = await saveBidSettings(b.settings);
      await audit({ actorUserId: actor.id, entityType: "Setting", entityId: "bidIntel", action: "UPDATED", after: s as unknown as Record<string, unknown> });
      return { settings: s };
    }
    if (b.action === "pull") {
      const source = String(b.source ?? "") as BidSource;
      if (!BID_SOURCES.includes(source)) throw new Error("source must be sam or usaspending");
      if (!(await bidSourcesConfigured()).includes(source)) throw new Error(source === "sam" ? "SAM_API_KEY is not set" : "USAspending pulls are switched off (BIDS_USASPENDING=off)");
      if (!jobsEnabled()) throw new Error("The job queue is off (JOBS_WORKER=off); pulls run in the background");
      const lookbackDays = b.lookbackDays === undefined ? undefined : Math.max(1, Math.min(365, Number(b.lookbackDays) || 30));
      const r = await enqueue("bids.ingest", { source, trigger: "manual", actorUserId: actor.id, ...(lookbackDays ? { lookbackDays } : {}) }, { singletonKey: `bids:${source}` });
      return { queued: !r.deduplicated, jobId: r.jobId, note: r.deduplicated ? "A pull for this source is already queued or running" : "Pull queued; results appear here when it finishes" };
    }
    throw new Error("action must be settings or pull");
  });
}

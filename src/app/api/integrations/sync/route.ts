import { handle, body } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requestIngest, isFeedName } from "@/lib/feeds";

/**
 * "Sync now" for CRM / ERP / GPO: queued on the same `feed.ingest` path the scheduler uses
 * (one ingestion per feed at a time), then waited on briefly so the button can show the
 * report. A long sync keeps running in the background; Settings → System shows its run.
 */
export async function POST(req: Request) {
  return handle("manage_contracts", async (actor) => {
    const { system } = await body<{ system?: string }>(req);
    if (!isFeedName(system) || !["crm", "erp", "gpo"].includes(system)) throw new Error("system must be crm, erp or gpo");
    const since = new Date();
    const { jobId, alreadyQueued } = await requestIngest(system, actor.id, true);
    if (alreadyQueued) throw new Error(`A ${system.toUpperCase()} sync is already queued or running`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const run = await prisma.feedRun.findFirst({ where: { feed: system, startedAt: { gte: since }, status: { not: "RUNNING" } }, orderBy: { startedAt: "desc" } });
      if (run) {
        if (run.status === "FAILED") throw new Error(run.error ?? "sync failed");
        if (run.status === "SKIPPED") throw new Error(run.error ?? "nothing to sync");
        return run.reportJson ? JSON.parse(run.reportJson) : { status: run.status, rows: run.rows, created: run.created, updated: run.updated, skipped: run.skipped, failed: run.failed };
      }
    }
    return { queued: true, jobId, message: "Sync is still running in the background; Settings → System shows its progress" };
  });
}

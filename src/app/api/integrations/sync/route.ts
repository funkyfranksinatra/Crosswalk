import { handle, body } from "@/lib/api";
import { ingestFeed } from "@/lib/feeds";

/**
 * "Sync now" for CRM / ERP / GPO. Runs synchronously (it is interactive and short for
 * file feeds) through the same feed path the scheduler uses, so it is recorded as a
 * FeedRun and counted for freshness. Scheduled syncs run on the `feed.ingest` queue.
 */
export async function POST(req: Request) {
  return handle("manage_contracts", async (actor) => {
    const { system } = await body<{ system: "crm" | "erp" | "gpo" }>(req);
    if (!["crm", "erp", "gpo"].includes(system)) throw new Error("unknown system");
    const res = await ingestFeed(system, { trigger: "manual", actorUserId: actor.id, force: true });
    if (res.status === "SKIPPED") throw new Error(res.reason ?? "nothing to sync");
    return res.report;
  });
}

import { handle, body } from "@/lib/api";
import { adoptRecords } from "@/lib/gudid/library";
import { audit } from "@/lib/audit";

/** Add specific library records to our catalog (the per-row "Add to our catalog" button). */
export async function POST(req: Request) {
  return handle("manage_catalog", async (actor) => {
    const b = await body<{ recordKeys?: string[] }>(req);
    const keys = (b.recordKeys ?? []).filter((k) => typeof k === "string").slice(0, 500);
    if (!keys.length) throw new Error("No records selected");
    const added = await adoptRecords(keys);
    if (added) await audit({ actorUserId: actor.id, entityType: "OwnProduct", entityId: "gudid-adopt", action: "ADOPTED_FROM_GUDID", after: { recordKeys: keys.slice(0, 50), added } });
    return { added };
  });
}

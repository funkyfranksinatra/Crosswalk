import { handle, body } from "@/lib/api";
import { pruneAdopted } from "@/lib/gudid/library";
import { audit } from "@/lib/audit";

/**
 * Clean up SKUs that GUDID imports added to our catalog: re-bin with the current rules and
 * remove everything that is now "Other" (plus any families passed in). Referenced SKUs are
 * deactivated, not deleted.
 */
export async function POST(req: Request) {
  return handle("manage_catalog", async (actor) => {
    const b = await body<{ families?: string[]; dryRun?: boolean }>(req);
    const r = await pruneAdopted({ families: b.families?.filter((f) => typeof f === "string") ?? null, dryRun: Boolean(b.dryRun) });
    if (!b.dryRun) await audit({ actorUserId: actor.id, entityType: "OwnProduct", entityId: "gudid-prune", action: "PRUNED_IMPORTED", after: { families: b.families ?? null, ...r } });
    return r;
  });
}

import { handle, body } from "@/lib/api";
import { pruneAdopted } from "@/lib/gudid/library";

/**
 * Clean up SKUs that GUDID imports added to our catalog: re-bin with the current rules and
 * remove everything that is now "Other" (plus any families passed in). Referenced SKUs are
 * deactivated, not deleted.
 */
export async function POST(req: Request) {
  return handle("manage_catalog", async () => {
    const b = await body<{ families?: string[]; dryRun?: boolean }>(req);
    return pruneAdopted({ families: b.families?.filter(Boolean) ?? null, dryRun: Boolean(b.dryRun) });
  });
}

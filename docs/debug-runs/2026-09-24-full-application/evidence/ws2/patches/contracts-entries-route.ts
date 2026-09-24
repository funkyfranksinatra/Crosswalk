// Suggested replacement for src/app/api/contracts/[id]/entries/route.ts (WS4-owned file).
// The whole write path moves to src/lib/contracts/entries.ts (WS2): one transaction, per-contract
// row lock, audit with the real counts, refused on the neon-http adapter. Body shape and the
// response { created, superseded, unknown } are unchanged.
import { handle, body } from "@/lib/api";
import { addContractEntries, type EntryRowInput } from "@/lib/contracts/entries";

/** Add / replace price entries on a contract (edit_contract_pricing). Effective-dated; never deletes history — supersedes. All or nothing. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_contract_pricing", async (actor) => {
    const b = await body<{ entries: EntryRowInput[] }>(req);
    return addContractEntries(actor, id, b.entries);
  });
}

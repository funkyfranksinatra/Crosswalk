import { handle, body } from "@/lib/api";
import { addContractEntries, type EntryRowInput } from "@/lib/contracts/entries";

/** Add / replace price entries on a contract (edit_contract_pricing). Effective-dated; never deletes history — supersedes. All or nothing (one transaction, per-contract row lock; see src/lib/contracts/entries.ts). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_contract_pricing", async (actor) => {
    const b = await body<{ entries: EntryRowInput[] }>(req);
    return addContractEntries(actor, id, b.entries);
  });
}

import { handle, body } from "@/lib/api";
import { decideConflict, type ConflictDecision } from "@/lib/xref/conflicts";

/**
 * Settle an evidence conflict on a curated cross (Crosswalk → Evidence conflicts):
 * { decision: "RETIRE" | "REPLACE" | "KEEP", note?: string }. Requires manage_crosswalk.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_crosswalk", async (actor) => {
    const b = await body<{ decision?: string; note?: string | null }>(req);
    return decideConflict(actor.id, id, String(b.decision ?? "").toUpperCase() as ConflictDecision, b.note ?? null);
  });
}

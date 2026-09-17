import { handle } from "@/lib/api";
import { queueFor } from "@/lib/approvals/service";
import { redactForActor, redactJsonForActor } from "@/lib/auth";
export async function GET() {
  return handle("view_pricing", async (actor) => (await queueFor(actor)).map((r) => ({ ...r, proposalLine: r.proposalLine ? redactForActor(actor, r.proposalLine as unknown as Record<string, unknown>) : null, snapshotJson: r.snapshotJson ? JSON.stringify(redactJsonForActor(actor, JSON.parse(r.snapshotJson))) : null })));
}

import { handle } from "@/lib/api";
import { queueFor } from "@/lib/approvals/service";
import { redactForActor, redactApprovalRequest } from "@/lib/auth";
export async function GET() {
  return handle("view_pricing", async (actor) => (await queueFor(actor)).map((r) => ({ ...redactApprovalRequest(actor, r), proposalLine: r.proposalLine ? redactForActor(actor, r.proposalLine as unknown as Record<string, unknown>) : null })));
}

import { handle, body } from "@/lib/api";
import { submitForApproval } from "@/lib/approvals/service";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => submitForApproval(actor, id, (await body<{ notes?: string }>(req)).notes));
}

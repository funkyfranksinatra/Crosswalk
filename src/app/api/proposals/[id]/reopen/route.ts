import { handle, body } from "@/lib/api";
import { reopen } from "@/lib/approvals/service";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => reopen(actor, id, (await body<{ reason?: string }>(req)).reason));
}

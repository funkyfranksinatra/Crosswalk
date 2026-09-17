import { handle } from "@/lib/api";
import { revokeDelegation } from "@/lib/approvals/delegation";
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => revokeDelegation(actor, id));
}

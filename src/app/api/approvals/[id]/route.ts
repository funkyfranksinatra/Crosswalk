import { handle, body } from "@/lib/api";
import { decide } from "@/lib/approvals/service";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("approve_discount", async (actor) => { const b = await body<{ decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED"; comments?: string }>(req); return decide(actor, id, b.decision, b.comments); });
}

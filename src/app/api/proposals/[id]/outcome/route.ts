import { handle, body } from "@/lib/api";
import { recordOutcome } from "@/lib/proposals/outcome";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("record_outcomes", async (actor) => recordOutcome(actor, id, await body(req) as Parameters<typeof recordOutcome>[2]));
}

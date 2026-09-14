import { handle } from "@/lib/api";
import { applyScenario } from "@/lib/proposals/service";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { sid } = await params;
  return handle("edit_proposed_pricing", async (actor) => applyScenario(actor, sid));
}

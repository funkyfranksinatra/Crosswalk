import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { applyScenario } from "@/lib/proposals/service";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params;
  return handle("edit_proposed_pricing", async (actor) => {
    if (!(await prisma.scenario.findFirst({ where: { id: sid, proposalId: id }, select: { id: true } }))) throw new Error("scenario not found on this proposal");
    return applyScenario(actor, sid);
  });
}

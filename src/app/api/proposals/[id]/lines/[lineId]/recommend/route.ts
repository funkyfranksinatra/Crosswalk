import { handle, body, num, str } from "@/lib/api";
import { prisma } from "@/lib/db";
import { redactJsonForActor } from "@/lib/auth";
import { rerecommendLine } from "@/lib/proposals/service";
import type { Strategy } from "@/lib/pricing/policy-model";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  return handle("edit_proposed_pricing", async (actor) => {
    // The line must belong to the proposal in the path — that is the one the ownership scope checked.
    if (!(await prisma.proposalLine.findFirst({ where: { id: lineId, proposalId: id }, select: { id: true } }))) throw new Error("line not found");
    const b = await body<{ strategy?: Strategy; adjustmentPct?: number; adjustmentAmount?: number; justification?: string; apply?: boolean }>(req);
    const out = await rerecommendLine(actor, lineId, { strategy: b.strategy ?? null, adjustmentPct: num(b.adjustmentPct), adjustmentAmount: num(b.adjustmentAmount), justification: str(b.justification), apply: Boolean(b.apply) });
    return redactJsonForActor(actor, out);
  });
}

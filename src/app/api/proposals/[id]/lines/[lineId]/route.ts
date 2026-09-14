import { prisma } from "@/lib/db";
import { handle, body, str } from "@/lib/api";
import { money } from "@/lib/money";
import { setProposedPrice, setLineIncluded, refreshEconomics } from "@/lib/proposals/service";
import { redactForActor } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  return handle("edit_proposed_pricing", async (actor) => {
    const b = await body<{ proposedPrice?: string | number | null; included?: boolean; reason?: string; justification?: string; notes?: string }>(req);
    const line = await prisma.proposalLine.findFirstOrThrow({ where: { id: lineId, proposalId: id } });
    if ("included" in b && typeof b.included === "boolean") await setLineIncluded(actor, lineId, b.included);
    if ("proposedPrice" in b) await setProposedPrice(actor, lineId, b.proposedPrice === null || b.proposedPrice === "" ? null : money(b.proposedPrice as never), str(b.reason));
    if ("justification" in b || "notes" in b) await prisma.proposalLine.update({ where: { id: lineId }, data: { ...(b.justification !== undefined ? { justification: b.justification } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}) } });
    void line;
    const updated = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId } });
    const economics = await refreshEconomics(id);
    return { line: redactForActor(actor, updated as unknown as Record<string, unknown>), economics: (await import("@/lib/proposals/economics")).economicsToJson(economics) };
  });
}

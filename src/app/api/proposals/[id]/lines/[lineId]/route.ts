import { prisma } from "@/lib/db";
import { handle, body, str } from "@/lib/api";
import { money } from "@/lib/money";
import { setProposedPrice, setLineIncluded, refreshEconomics, assertEditable } from "@/lib/proposals/service";
import { audit } from "@/lib/audit";
import { redactForActor } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  return handle("edit_proposed_pricing", async (actor) => {
    const b = await body<{ proposedPrice?: string | number | null; included?: boolean; reason?: string; justification?: string; notes?: string; customerNote?: string | null }>(req);
    const line = await prisma.proposalLine.findFirstOrThrow({ where: { id: lineId, proposalId: id } });
    if ("included" in b && typeof b.included === "boolean") await setLineIncluded(actor, lineId, b.included);
    if ("proposedPrice" in b) {
      const clear = b.proposedPrice === null || b.proposedPrice === "";
      const price = clear ? null : money(b.proposedPrice as never);
      if (!clear && price === null) throw new Error(`proposedPrice "${String(b.proposedPrice).slice(0, 40)}" is not a number`);
      await setProposedPrice(actor, lineId, price, str(b.reason));
    }
    if ("justification" in b || "notes" in b) {
      if ((typeof b.justification === "string" && b.justification.length > 4000) || (typeof b.notes === "string" && b.notes.length > 4000)) throw new Error("text too long (max 4000 characters)");
      // Justification is part of what an approver reviews; it follows the same lock as the price.
      if (b.justification !== undefined) await assertEditable(id);
      await prisma.proposalLine.update({ where: { id: lineId }, data: { ...(b.justification !== undefined ? { justification: b.justification == null ? null : String(b.justification) } : {}), ...(b.notes !== undefined ? { notes: b.notes == null ? null : String(b.notes) } : {}) } });
      await audit({ actorUserId: actor.id, entityType: "ProposalLine", entityId: lineId, action: "NOTES_CHANGED", before: { justification: line.justification, notes: line.notes }, after: { justification: b.justification ?? line.justification, notes: b.notes ?? line.notes } });
    }
    if ("customerNote" in b) {
      // Printed on the quote: editable until the proposal closes, audited, never part of what approvers review.
      if (typeof b.customerNote === "string" && b.customerNote.length > 1000) throw new Error("customer note is too long (max 1000 characters)");
      const p = await prisma.proposal.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (["WON", "LOST"].includes(p.status)) throw new Error("Closed proposals cannot be edited; create a new version");
      const customerNote = b.customerNote == null || b.customerNote === "" ? null : String(b.customerNote);
      await prisma.proposalLine.update({ where: { id: lineId }, data: { customerNote } });
      await audit({ actorUserId: actor.id, entityType: "ProposalLine", entityId: lineId, action: "CUSTOMER_NOTE_CHANGED", before: { customerNote: line.customerNote }, after: { customerNote } });
    }
    const updated = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId } });
    const economics = await refreshEconomics(id);
    return { line: redactForActor(actor, updated as unknown as Record<string, unknown>), economics: (await import("@/lib/proposals/economics")).economicsToJson(economics) };
  });
}

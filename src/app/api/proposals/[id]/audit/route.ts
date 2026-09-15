import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { redactAuditEvent } from "@/lib/auth";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => {
    const lineIds = (await prisma.proposalLine.findMany({ where: { proposalId: id }, select: { id: true } })).map((l) => l.id);
    const events = await prisma.auditEvent.findMany({ where: { OR: [{ entityType: "Proposal", entityId: id }, { entityType: "ProposalLine", entityId: { in: lineIds } }, { entityType: "ApprovalRequest", contextJson: { contains: id } }] }, orderBy: { at: "desc" }, take: 300 });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorUserId).filter((x): x is string => Boolean(x)))] } } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return events.map((e) => ({ ...redactAuditEvent(actor, e), actorName: e.actorUserId ? names.get(e.actorUserId) ?? e.actorUserId : "system" }));
  });
}

import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { redactForActor, can } from "@/lib/auth";
import { finalizeCheck } from "@/lib/approvals/service";
import { integrationStatus } from "@/lib/integrations/sync";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => {
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id }, include: { account: { include: { parent: true } }, opportunity: true, contract: true, crosswalkVersion: true, request: { select: { id: true, reference: true } }, lines: { orderBy: { lineNo: "asc" } }, scenarios: { orderBy: { createdAt: "asc" } }, approvals: { orderBy: { requestedAt: "desc" } }, outcome: true } });
    const finalize = await finalizeCheck(id);
    const lines = p.lines.map((l) => redactForActor(actor, l as unknown as Record<string, unknown>));
    const economics = p.economicsJson ? JSON.parse(p.economicsJson) : null;
    if (economics && !can(actor, "view_margin")) { economics.grossProfit = null; economics.blendedMarginPct = null; economics.cogs = null; economics.byFamily = economics.byFamily.map((f: Record<string, unknown>) => ({ ...f, grossProfit: null, marginPct: null })); }
    return { ...p, lines, economics, finalize, permissions: { editPricing: can(actor, "edit_proposed_pricing"), viewCost: can(actor, "view_cost"), viewMargin: can(actor, "view_margin"), approve: can(actor, "approve_discount"), export: can(actor, "export_proposals"), outcomes: can(actor, "record_outcomes") }, integrations: await integrationStatus() };
  });
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async () => { const p = await prisma.proposal.findUniqueOrThrow({ where: { id } }); if (p.status !== "DRAFT") throw new Error("Only drafts can be deleted"); await prisma.proposal.delete({ where: { id } }); });
}

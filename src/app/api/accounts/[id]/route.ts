import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { redactJsonString } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => {
    const a = await prisma.account.findUniqueOrThrow({ where: { id }, include: { parent: true, children: true, memberships: { include: { gpo: true }, orderBy: { effectiveFrom: "desc" } }, contracts: { orderBy: { effectiveFrom: "desc" } }, opportunities: true, proposals: { orderBy: { createdAt: "desc" } }, requests: { orderBy: { createdAt: "desc" }, take: 20 }, purchases: { orderBy: { invoiceDate: "desc" }, take: 50 }, observations: { orderBy: { observedAt: "desc" }, take: 50, include: { competitor: true } } } });
    // Proposal rows carry the economics rollup (COGS / margin): redacted per role like the proposal routes.
    return { ...a, proposals: a.proposals.map((p) => ({ ...p, economicsJson: redactJsonString(actor, p.economicsJson) })) };
  });
}

import { prisma } from "@/lib/db";
import { handle, body, date, str, requireText, optText } from "@/lib/api";
import { audit } from "@/lib/audit";
/** Membership changes open a new effective-dated row and close the previous one; history is kept. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_contracts", async (actor) => {
    const b = await body<{ gpoName: string; tier?: string; effectiveFrom?: string; effectiveTo?: string }>(req);
    const gpoName = requireText(b.gpoName, "gpoName", 120);
    if (!(await prisma.account.findUnique({ where: { id }, select: { id: true } }))) throw new Error("account not found");
    const gpo = await prisma.gpo.upsert({ where: { name: gpoName }, create: { name: gpoName }, update: {} });
    const from = date(b.effectiveFrom) ?? new Date();
    const to = date(b.effectiveTo);
    if (b.effectiveTo && !to) throw new Error("effectiveTo is not a date");
    if (to && to <= from) throw new Error("effectiveTo must be after effectiveFrom");
    await prisma.gpoMembership.updateMany({ where: { accountId: id, gpoId: gpo.id, effectiveTo: null, effectiveFrom: { lt: from } }, data: { effectiveTo: from } });
    const m = await prisma.gpoMembership.create({ data: { accountId: id, gpoId: gpo.id, tier: optText(b.tier, "tier", 40), effectiveFrom: from, effectiveTo: to, source: "manual", verifiedAt: new Date(), verifiedBy: actor.id } });
    await audit({ actorUserId: actor.id, entityType: "Account", entityId: id, action: "MEMBERSHIP_CHANGED", after: { gpo: gpo.name, tier: m.tier, effectiveFrom: from } });
    return m;
  });
}

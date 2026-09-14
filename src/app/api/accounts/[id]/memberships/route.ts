import { prisma } from "@/lib/db";
import { handle, body, date, str } from "@/lib/api";
import { audit } from "@/lib/audit";
/** Membership changes open a new effective-dated row and close the previous one; history is kept. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_contracts", async (actor) => {
    const b = await body<{ gpoName: string; tier?: string; effectiveFrom?: string; effectiveTo?: string }>(req);
    const gpo = await prisma.gpo.upsert({ where: { name: b.gpoName }, create: { name: b.gpoName }, update: {} });
    const from = date(b.effectiveFrom) ?? new Date();
    await prisma.gpoMembership.updateMany({ where: { accountId: id, gpoId: gpo.id, effectiveTo: null, effectiveFrom: { lt: from } }, data: { effectiveTo: from } });
    const m = await prisma.gpoMembership.create({ data: { accountId: id, gpoId: gpo.id, tier: str(b.tier), effectiveFrom: from, effectiveTo: date(b.effectiveTo), source: "manual", verifiedAt: new Date(), verifiedBy: actor.id } });
    await audit({ actorUserId: actor.id, entityType: "Account", entityId: id, action: "MEMBERSHIP_CHANGED", after: { gpo: gpo.name, tier: m.tier, effectiveFrom: from } });
    return m;
  });
}

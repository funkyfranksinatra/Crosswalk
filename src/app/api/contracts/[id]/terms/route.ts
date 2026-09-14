import { prisma } from "@/lib/db";
import { handle, body, date, str } from "@/lib/api";
import { audit } from "@/lib/audit";
import { toDb } from "@/lib/money";
import { TiersSchema } from "@/lib/contracts/rebates";
import { ConditionSchema, BenefitSchema } from "@/lib/contracts/bundles";

/** Commitments, rebates, bundles and scope on a contract. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_contracts", async (actor) => {
    const b = await body<{ kind: "commitment" | "rebate" | "bundle" | "scope"; data: Record<string, unknown> }>(req);
    const d = b.data ?? {};
    let row: unknown;
    if (b.kind === "commitment") row = await prisma.contractCommitment.create({ data: { contractId: id, productFamily: str(d.productFamily), productId: str(d.productId), committedUnits: toDb(d.committedUnits as never), committedValue: toDb(d.committedValue as never), periodStart: date(d.periodStart) ?? new Date(), periodEnd: date(d.periodEnd) ?? new Date(Date.now() + 365 * 86_400_000) } });
    else if (b.kind === "rebate") row = await prisma.rebateSchedule.create({ data: { contractId: id, type: String(d.type ?? "VOLUME"), basis: String(d.basis ?? "VALUE"), productFamily: str(d.productFamily), tiersJson: JSON.stringify(TiersSchema.parse(d.tiers ?? [])), periodMonths: Number(d.periodMonths ?? 12), notes: str(d.notes) } });
    else if (b.kind === "bundle") row = await prisma.bundleTerm.create({ data: { contractId: id, name: String(d.name ?? "Bundle"), description: str(d.description), conditionJson: JSON.stringify(ConditionSchema.parse(d.condition ?? {})), benefitJson: JSON.stringify(BenefitSchema.parse(d.benefit ?? {})) } });
    else if (b.kind === "scope") row = await prisma.contractScope.create({ data: { contractId: id, productFamily: str(d.productFamily), productId: str(d.productId) } });
    else throw new Error("unknown term kind");
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: `${b.kind.toUpperCase()}_ADDED`, after: d });
    return row;
  });
}
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_contracts", async (actor) => {
    const b = await body<{ kind: string; termId: string }>(req);
    if (b.kind === "commitment") await prisma.contractCommitment.delete({ where: { id: b.termId } });
    else if (b.kind === "rebate") await prisma.rebateSchedule.delete({ where: { id: b.termId } });
    else if (b.kind === "bundle") await prisma.bundleTerm.delete({ where: { id: b.termId } });
    else if (b.kind === "scope") await prisma.contractScope.delete({ where: { id: b.termId } });
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: `${b.kind.toUpperCase()}_REMOVED`, before: { termId: b.termId } });
  });
}

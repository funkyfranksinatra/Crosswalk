import { prisma } from "@/lib/db";
import { handle, body, date, str, oneOf } from "@/lib/api";
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
    if (!(await prisma.contract.findUnique({ where: { id }, select: { id: true } }))) throw new Error("contract not found");
    if (d.productId && !(await prisma.ownProduct.findUnique({ where: { id: String(d.productId) }, select: { id: true } }))) throw new Error("unknown productId");
    if (b.kind === "commitment") { const ps = date(d.periodStart), pe = date(d.periodEnd); if (ps && pe && pe <= ps) throw new Error("periodEnd must be after periodStart"); if (!d.committedUnits && !d.committedValue) throw new Error("a commitment needs committedUnits or committedValue"); }
    let row: unknown;
    if (b.kind === "commitment") row = await prisma.contractCommitment.create({ data: { contractId: id, productFamily: str(d.productFamily), productId: str(d.productId), committedUnits: toDb(d.committedUnits as never), committedValue: toDb(d.committedValue as never), periodStart: date(d.periodStart) ?? new Date(), periodEnd: date(d.periodEnd) ?? new Date(Date.now() + 365 * 86_400_000) } });
    else if (b.kind === "rebate") row = await prisma.rebateSchedule.create({ data: { contractId: id, type: oneOf(d.type, ["VOLUME", "GROWTH", "COMPLIANCE", "FAMILY", "BUNDLE"] as const, "type", "VOLUME"), basis: oneOf(d.basis, ["UNITS", "VALUE", "COMPLIANCE_PCT", "GROWTH_PCT"] as const, "basis", "VALUE"), productFamily: str(d.productFamily), tiersJson: JSON.stringify(TiersSchema.parse(d.tiers ?? [])), periodMonths: Number(d.periodMonths ?? 12), notes: str(d.notes) } });
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
    if (typeof b.termId !== "string") throw new Error("termId required");
    // Scoped to this contract: a term id from another contract must not be deletable through this URL.
    const where = { id: b.termId, contractId: id };
    let n = 0;
    if (b.kind === "commitment") n = (await prisma.contractCommitment.deleteMany({ where })).count;
    else if (b.kind === "rebate") n = (await prisma.rebateSchedule.deleteMany({ where })).count;
    else if (b.kind === "bundle") n = (await prisma.bundleTerm.deleteMany({ where })).count;
    else if (b.kind === "scope") n = (await prisma.contractScope.deleteMany({ where })).count;
    else throw new Error("unknown term kind");
    if (n === 0) throw new Error("term not found on this contract");
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: `${b.kind.toUpperCase()}_REMOVED`, before: { termId: b.termId } });
  });
}

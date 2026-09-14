import { prisma } from "@/lib/db";
import { handle, body, date, str } from "@/lib/api";
import { audit } from "@/lib/audit";
import { toDb } from "@/lib/money";
import { RenewalSchema, PriceProtectionSchema, EscalationSchema, parseClause } from "@/lib/contracts/clauses";
import { redactForActor } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id }, include: { account: true, parentAccount: true, gpo: true, scopes: true, entries: { include: { product: { select: { sku: true, description: true, category: true } } }, orderBy: [{ productId: "asc" }, { minQty: "asc" }] }, commitments: true, rebates: true, bundles: true, proposals: { select: { id: true, reference: true, status: true } } } });
    return { ...c, entries: c.entries.map((e) => redactForActor(actor, e as unknown as Record<string, unknown>)), renewal: parseClause(RenewalSchema, c.renewalJson), priceProtection: parseClause(PriceProtectionSchema, c.priceProtectionJson), escalation: parseClause(EscalationSchema, c.escalationJson), performance: c.performanceJson ? JSON.parse(c.performanceJson) : null };
  });
}
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_contracts", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    const before = await prisma.contract.findUniqueOrThrow({ where: { id } });
    const data: Record<string, unknown> = {};
    for (const k of ["name", "status", "tier", "notes", "type"]) if (k in b) data[k] = str(b[k]);
    if ("effectiveTo" in b) data.effectiveTo = date(b.effectiveTo);
    if ("precedence" in b) data.precedence = Number(b.precedence);
    if ("committedValue" in b) data.committedValue = toDb(b.committedValue as never);
    if ("renewal" in b) data.renewalJson = b.renewal ? JSON.stringify(RenewalSchema.parse(b.renewal)) : null;
    if ("priceProtection" in b) data.priceProtectionJson = b.priceProtection ? JSON.stringify(PriceProtectionSchema.parse(b.priceProtection)) : null;
    if ("escalation" in b) data.escalationJson = b.escalation ? JSON.stringify(EscalationSchema.parse(b.escalation)) : null;
    const c = await prisma.contract.update({ where: { id }, data });
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: "UPDATED", before: { status: before.status, effectiveTo: before.effectiveTo, tier: before.tier }, after: data });
    return c;
  });
}

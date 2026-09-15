import { prisma } from "@/lib/db";
import { handle, body, date, str, oneOf, optText, nonNegativeMoney } from "@/lib/api";
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
    if ("name" in b) data.name = optText(b.name, "name", 200) ?? before.name;
    if ("tier" in b) data.tier = optText(b.tier, "tier", 40);
    if ("notes" in b) data.notes = optText(b.notes, "notes", 4000);
    if ("type" in b) data.type = oneOf(b.type, ["NATIONAL", "GPO", "IDN", "LOCAL"] as const, "type");
    if ("status" in b) {
      const status = oneOf(b.status, ["DRAFT", "ACTIVE", "EXPIRED", "TERMINATED", "SUPERSEDED"] as const, "status");
      // Contract state machine: a terminated or superseded contract does not come back to life.
      if (["TERMINATED", "SUPERSEDED"].includes(before.status) && status !== before.status) throw new Error(`a ${before.status.toLowerCase()} contract cannot be reactivated; create a new contract`);
      if (status === "ACTIVE" && before.effectiveTo && before.effectiveTo < new Date() && !("effectiveTo" in b)) throw new Error("this contract has already expired; extend effectiveTo to reactivate it");
      data.status = status;
    }
    if ("effectiveTo" in b) { const to = date(b.effectiveTo); if (b.effectiveTo && !to) throw new Error("effectiveTo is not a date"); if (to && to <= before.effectiveFrom) throw new Error("effectiveTo must be after effectiveFrom"); data.effectiveTo = to; }
    if ("precedence" in b) { const pr = Number(b.precedence); if (!Number.isInteger(pr) || pr < 0 || pr > 100) throw new Error("precedence must be an integer 0–100"); data.precedence = pr; }
    if ("committedValue" in b) data.committedValue = toDb(nonNegativeMoney(b.committedValue, "committedValue"));
    if ("renewal" in b) data.renewalJson = b.renewal ? JSON.stringify(RenewalSchema.parse(b.renewal)) : null;
    if ("priceProtection" in b) data.priceProtectionJson = b.priceProtection ? JSON.stringify(PriceProtectionSchema.parse(b.priceProtection)) : null;
    if ("escalation" in b) data.escalationJson = b.escalation ? JSON.stringify(EscalationSchema.parse(b.escalation)) : null;
    const c = await prisma.contract.update({ where: { id }, data });
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: "UPDATED", before: { status: before.status, effectiveTo: before.effectiveTo, tier: before.tier }, after: data });
    return c;
  });
}

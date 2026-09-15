import { prisma } from "@/lib/db";
import { handle, body, date, str, requireText, optText, oneOf, currencyCode, nonNegativeMoney } from "@/lib/api";
import { audit } from "@/lib/audit";
import { RenewalSchema, PriceProtectionSchema, EscalationSchema } from "@/lib/contracts/clauses";
import { toDb } from "@/lib/money";

export async function GET() {
  return handle("view_pricing", async () => prisma.contract.findMany({ orderBy: [{ status: "asc" }, { effectiveTo: "asc" }], include: { account: true, gpo: true, _count: { select: { entries: true, commitments: true, rebates: true, bundles: true } } } }));
}
export async function POST(req: Request) {
  return handle("manage_contracts", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    const clause = <T,>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, v: unknown) => { if (!v) return null; const r = schema.safeParse(v); if (!r.success) throw new Error("Invalid clause"); return JSON.stringify(r.data); };
    const from = date(b.effectiveFrom); if (!from) throw new Error("effectiveFrom required");
    const to = date(b.effectiveTo);
    if (b.effectiveTo && !to) throw new Error("effectiveTo is not a date");
    if (to && to <= from) throw new Error("effectiveTo must be after effectiveFrom");
    const type = oneOf(b.type, ["NATIONAL", "GPO", "IDN", "LOCAL"] as const, "type", "LOCAL");
    const status = oneOf(b.status, ["DRAFT", "ACTIVE", "EXPIRED", "TERMINATED", "SUPERSEDED"] as const, "status", "DRAFT");
    if (type === "GPO" && !str(b.gpoId)) throw new Error("a GPO contract needs a gpoId");
    if ((type === "LOCAL" || type === "IDN") && !str(b.accountId) && !str(b.parentAccountId)) throw new Error(`a ${type} contract needs an account`);
    const precedence = Number(b.precedence ?? 0); if (!Number.isInteger(precedence) || precedence < 0 || precedence > 100) throw new Error("precedence must be an integer 0–100");
    if (str(b.accountId) && !(await prisma.account.findUnique({ where: { id: String(b.accountId) }, select: { id: true } }))) throw new Error("unknown accountId");
    if (str(b.gpoId) && !(await prisma.gpo.findUnique({ where: { id: String(b.gpoId) }, select: { id: true } }))) throw new Error("unknown gpoId");
    const c = await prisma.contract.create({ data: { contractNumber: requireText(b.contractNumber, "contractNumber", 80), name: requireText(b.name, "name"), type, status, accountId: str(b.accountId), parentAccountId: str(b.parentAccountId), gpoId: str(b.gpoId), tier: optText(b.tier, "tier", 40), currency: currencyCode(b.currency), effectiveFrom: from, effectiveTo: to, precedence, committedVolume: toDb(nonNegativeMoney(b.committedVolume, "committedVolume")), committedValue: toDb(nonNegativeMoney(b.committedValue, "committedValue")), renewalJson: clause(RenewalSchema, b.renewal), priceProtectionJson: clause(PriceProtectionSchema, b.priceProtection), escalationJson: clause(EscalationSchema, b.escalation), notes: optText(b.notes, "notes", 4000), sourceSystem: "crosswalk", ownerUserId: actor.id, createdByUserId: actor.id } });
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: c.id, action: "CREATED", after: { contractNumber: c.contractNumber, type: c.type } });
    return c;
  });
}

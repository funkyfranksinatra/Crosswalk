import { prisma } from "@/lib/db";
import { handle, body, date, str } from "@/lib/api";
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
    const c = await prisma.contract.create({ data: { contractNumber: String(b.contractNumber), name: String(b.name), type: String(b.type ?? "LOCAL"), status: String(b.status ?? "DRAFT"), accountId: str(b.accountId), parentAccountId: str(b.parentAccountId), gpoId: str(b.gpoId), tier: str(b.tier), currency: String(b.currency ?? "USD"), effectiveFrom: from, effectiveTo: date(b.effectiveTo), precedence: Number(b.precedence ?? 0), committedVolume: toDb(b.committedVolume as never), committedValue: toDb(b.committedValue as never), renewalJson: clause(RenewalSchema, b.renewal), priceProtectionJson: clause(PriceProtectionSchema, b.priceProtection), escalationJson: clause(EscalationSchema, b.escalation), notes: str(b.notes), sourceSystem: "crosswalk", ownerUserId: actor.id, createdByUserId: actor.id } });
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: c.id, action: "CREATED", after: { contractNumber: c.contractNumber, type: c.type } });
    return c;
  });
}

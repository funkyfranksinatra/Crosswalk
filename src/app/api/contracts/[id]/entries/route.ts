import { prisma } from "@/lib/db";
import { handle, body, date, str } from "@/lib/api";
import { audit } from "@/lib/audit";
import { toDb } from "@/lib/money";

/** Add / replace price entries on a contract (edit_contract_pricing). Effective-dated; never deletes history — supersedes. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_contract_pricing", async (actor) => {
    const b = await body<{ entries: { sku: string; price: string | number; currency?: string; effectiveFrom?: string; effectiveTo?: string; tier?: string; minQty?: string | number; maxQty?: string | number; volumeTierName?: string }[] }>(req);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    const company = await prisma.company.findFirstOrThrow();
    let created = 0, superseded = 0; const unknown: string[] = [];
    for (const e of b.entries ?? []) {
      const product = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku: e.sku.toUpperCase() } } });
      if (!product) { unknown.push(e.sku); continue; }
      const from = date(e.effectiveFrom) ?? new Date();
      const prior = await prisma.priceEntry.findMany({ where: { contractId: id, productId: product.id, status: "ACTIVE", minQty: toDb(e.minQty as never) ?? null, maxQty: toDb(e.maxQty as never) ?? null } });
      if (prior.length) { await prisma.priceEntry.updateMany({ where: { id: { in: prior.map((p) => p.id) } }, data: { status: "SUPERSEDED", effectiveTo: from } }); superseded += prior.length; }
      await prisma.priceEntry.create({ data: { contractId: id, accountId: c.accountId, gpoId: c.gpoId, productId: product.id, productFamily: product.category, price: toDb(e.price)!, currency: e.currency ?? c.currency, effectiveFrom: from, effectiveTo: date(e.effectiveTo) ?? c.effectiveTo, tier: str(e.tier) ?? c.tier, minQty: toDb(e.minQty as never), maxQty: toDb(e.maxQty as never), volumeTierName: str(e.volumeTierName), source: "manual", status: "ACTIVE", approvalState: "APPROVED" } });
      created++;
    }
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: "ENTRIES_CHANGED", after: { created, superseded, unknown } });
    return { created, superseded, unknown };
  });
}

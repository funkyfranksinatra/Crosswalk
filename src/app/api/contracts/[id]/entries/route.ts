import { prisma } from "@/lib/db";
import { handle, body, date, str, positiveMoney, nonNegativeMoney, currencyCode } from "@/lib/api";
import { audit } from "@/lib/audit";
import { toDb } from "@/lib/money";

/** Add / replace price entries on a contract (edit_contract_pricing). Effective-dated; never deletes history — supersedes. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_contract_pricing", async (actor) => {
    const b = await body<{ entries: { sku: string; price: string | number; currency?: string; effectiveFrom?: string; effectiveTo?: string; tier?: string; minQty?: string | number; maxQty?: string | number; volumeTierName?: string }[] }>(req);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } });
    if (["TERMINATED", "SUPERSEDED"].includes(c.status)) throw new Error(`cannot add prices to a ${c.status.toLowerCase()} contract`);
    const company = await prisma.company.findFirstOrThrow();
    if (!Array.isArray(b.entries)) throw new Error("entries must be a list");
    if (b.entries.length > 5000) throw new Error("at most 5,000 entries per call");
    let created = 0, superseded = 0; const unknown: string[] = [];
    for (const e of b.entries) {
      if (!e || typeof e.sku !== "string" || !e.sku.trim()) throw new Error("every entry needs a sku");
      const price = positiveMoney(e.price, `price for ${e.sku}`);
      const minQty = nonNegativeMoney(e.minQty, `minQty for ${e.sku}`), maxQty = nonNegativeMoney(e.maxQty, `maxQty for ${e.sku}`);
      if (minQty && maxQty && maxQty.lt(minQty)) throw new Error(`maxQty below minQty for ${e.sku}`);
      const currency = currencyCode(e.currency, c.currency);
      if (currency !== c.currency) throw new Error(`entry for ${e.sku} is in ${currency} but the contract is in ${c.currency}`);
      const product = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku: e.sku.toUpperCase().trim() } } });
      if (!product) { unknown.push(e.sku); continue; }
      const from = date(e.effectiveFrom) ?? new Date();
      const to = date(e.effectiveTo) ?? c.effectiveTo;
      if (to && to <= from) throw new Error(`effectiveTo before effectiveFrom for ${e.sku}`);
      const prior = await prisma.priceEntry.findMany({ where: { contractId: id, productId: product.id, status: "ACTIVE", minQty: toDb(e.minQty as never) ?? null, maxQty: toDb(e.maxQty as never) ?? null } });
      if (prior.length) {
        // An entry that started before the new one ends when it starts; one dated at or after it is just superseded.
        const ending = prior.filter((p) => p.effectiveFrom < from).map((p) => p.id), replaced = prior.filter((p) => p.effectiveFrom >= from).map((p) => p.id);
        if (ending.length) await prisma.priceEntry.updateMany({ where: { id: { in: ending } }, data: { status: "SUPERSEDED", effectiveTo: from } });
        if (replaced.length) await prisma.priceEntry.updateMany({ where: { id: { in: replaced } }, data: { status: "SUPERSEDED" } });
        superseded += prior.length;
      }
      await prisma.priceEntry.create({ data: { contractId: id, accountId: c.accountId, gpoId: c.gpoId, productId: product.id, productFamily: product.category, price: toDb(price)!, currency, effectiveFrom: from, effectiveTo: to, tier: str(e.tier) ?? c.tier, minQty: toDb(minQty), maxQty: toDb(maxQty), volumeTierName: str(e.volumeTierName), source: "manual", status: "ACTIVE", approvalState: "APPROVED" } });
      created++;
    }
    await audit({ actorUserId: actor.id, entityType: "Contract", entityId: id, action: "ENTRIES_CHANGED", after: { created, superseded, unknown, entries: b.entries.slice(0, 200).map((e) => ({ sku: e.sku, price: String(e.price), minQty: e.minQty ?? null, maxQty: e.maxQty ?? null, effectiveFrom: e.effectiveFrom ?? null })) } });
    return { created, superseded, unknown };
  });
}

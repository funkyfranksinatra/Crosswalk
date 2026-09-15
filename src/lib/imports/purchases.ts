/**
 * Purchase-history import (CSV grid → PurchaseRecord rows). Idempotent on the invoice /
 * external id per account and SKU: a file imported twice does not double conversion figures.
 * Rows that cannot be trusted (unknown account, unreadable date, non-numeric amounts) are
 * reported with their row number and skipped.
 */
import { prisma } from "@/lib/db";
import { money, toDb } from "@/lib/money";
import { normalizeCfn } from "@/lib/cfn";

export type PurchaseImportReport = { created: number; updated: number; skipped: string[] };

export async function importPurchasesGrid(grid: unknown[][], companyId: string, documentId: string | null): Promise<PurchaseImportReport> {
  const h = (grid[0] ?? []).map((c) => String(c ?? "").toLowerCase().trim());
  const ix = (re: RegExp) => h.findIndex((x) => re.test(x));
  // Header detection: first match wins, so specific patterns must not be shadowed by a broader
  // sibling ("Invoice Date" must never be taken as the invoice number).
  const cAcc = ix(/account/), cSku = ix(/sku|product|item/), cQty = ix(/qty|quantity|units/), cPrice = ix(/price/), cCcy = ix(/currency/), cDate = ix(/date/), cContract = ix(/contract/), cInv = ix(/^invoice$|invoice\s*(no|num|number|#|id)|external|document\s*(no|number)|reference/);
  if (cAcc < 0 || cSku < 0 || cQty < 0 || cPrice < 0 || cDate < 0) throw new Error("Need Account, SKU, Quantity, Net Price and Invoice Date columns");
  const report: PurchaseImportReport = { created: 0, updated: 0, skipped: [] };
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r]; if (!row?.[cSku]) continue;
    const accKey = String(row[cAcc] ?? "").trim();
    const account = accKey ? await prisma.account.findFirst({ where: { OR: [{ accountNumber: accKey }, { name: accKey }] } }) : null;
    if (!account) { report.skipped.push(`row ${r + 1}: unknown account ${accKey || "(blank)"}`); continue; }
    const qty = money(row[cQty] as never), price = money(row[cPrice] as never);
    if (!qty || qty.isZero() || qty.abs().gt("100000000")) { report.skipped.push(`row ${r + 1}: quantity "${row[cQty]}" is not a usable number`); continue; }
    if (!price || price.lt(0) || price.gt("1000000000")) { report.skipped.push(`row ${r + 1}: net price "${row[cPrice]}" is not a usable number`); continue; }
    const invoiceDate = new Date(String(row[cDate]));
    if (Number.isNaN(invoiceDate.getTime())) { report.skipped.push(`row ${r + 1}: unreadable invoice date "${row[cDate]}"`); continue; }
    const currency = cCcy >= 0 && row[cCcy] ? String(row[cCcy]).toUpperCase().trim() : "USD";
    if (!/^[A-Z]{3}$/.test(currency)) { report.skipped.push(`row ${r + 1}: currency "${row[cCcy]}" is not a 3-letter code`); continue; }
    const sku = normalizeCfn(row[cSku]);
    const product = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId, sku } } });
    const contract = cContract >= 0 && row[cContract] ? await prisma.contract.findUnique({ where: { contractNumber: String(row[cContract]) } }) : null;
    const won = await prisma.proposal.findFirst({ where: { accountId: account.id, status: "WON" }, orderBy: { decidedAt: "desc" } });
    const externalId = cInv >= 0 && row[cInv] ? String(row[cInv]).trim() : null;
    const data = { accountId: account.id, productId: product?.id ?? null, sku, quantity: toDb(qty)!, netPrice: toDb(price)!, currency, invoiceDate, contractId: contract?.id ?? null, proposalId: won?.id ?? null, source: "import", externalId, documentId };
    const existing = externalId ? await prisma.purchaseRecord.findFirst({ where: { accountId: account.id, sku, externalId } }) : null;
    if (existing) { await prisma.purchaseRecord.update({ where: { id: existing.id }, data }); report.updated++; continue; }
    await prisma.purchaseRecord.create({ data });
    report.created++;
  }
  return report;
}

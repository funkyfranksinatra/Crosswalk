/**
 * Standard-cost import (CSV grid → StandardCost rows). Idempotent on the natural key
 * (product, plant, region, currency, cost type, effective-from): re-importing a file updates
 * the cost instead of stacking a duplicate row; invalid rows are reported, never half-written.
 */
import { prisma } from "@/lib/db";
import { money, toDb } from "@/lib/money";
import { normalizeCfn } from "@/lib/cfn";

export type CostImportReport = { created: number; updated: number; unknown: string[]; invalid: { row: number; reason: string }[] };

const COST_TYPES = new Set(["STANDARD", "LANDED", "TRANSFER"]);
const isCurrency = (s: string) => /^[A-Z]{3}$/.test(s);
function parseDate(v: unknown): Date | null {
  if (v == null || String(v).trim() === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function importCostsGrid(grid: unknown[][], companyId: string): Promise<CostImportReport> {
  const h = (grid[0] ?? []).map((c) => String(c ?? "").toLowerCase().trim());
  const ix = (re: RegExp) => h.findIndex((x) => re.test(x));
  const cSku = ix(/^sku$|product|item/), cCost = ix(/cost$|standard cost|^cost/), cCcy = ix(/currency/), cPlant = ix(/plant/), cRegion = ix(/region/), cType = ix(/type/), cFrom = ix(/from|effective$/), cTo = ix(/^to$|expir|effective to/);
  if (cSku < 0 || cCost < 0) throw new Error("Need SKU and Cost columns");
  const report: CostImportReport = { created: 0, updated: 0, unknown: [], invalid: [] };
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r]; if (!row?.[cSku]) continue;
    const sku = normalizeCfn(row[cSku]);
    const product = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId, sku } } });
    if (!product) { report.unknown.push(String(row[cSku])); continue; }
    const cost = money(row[cCost] as never);
    if (!cost || cost.lte(0) || cost.gt("1000000000")) { report.invalid.push({ row: r + 1, reason: `cost "${row[cCost]}" is not a positive number` }); continue; }
    const currency = cCcy >= 0 && row[cCcy] ? String(row[cCcy]).toUpperCase().trim() : "USD";
    if (!isCurrency(currency)) { report.invalid.push({ row: r + 1, reason: `currency "${row[cCcy]}" is not a 3-letter code` }); continue; }
    const costType = cType >= 0 && row[cType] ? String(row[cType]).toUpperCase().trim() : "STANDARD";
    if (!COST_TYPES.has(costType)) { report.invalid.push({ row: r + 1, reason: `cost type "${row[cType]}" must be STANDARD, LANDED or TRANSFER` }); continue; }
    const from = cFrom >= 0 && row[cFrom] ? parseDate(row[cFrom]) : new Date();
    const to = cTo >= 0 && row[cTo] ? parseDate(row[cTo]) : null;
    if (!from || (cTo >= 0 && row[cTo] && !to)) { report.invalid.push({ row: r + 1, reason: "unreadable effective date" }); continue; }
    if (to && to <= from) { report.invalid.push({ row: r + 1, reason: "effective-to must be after effective-from" }); continue; }
    const plant = cPlant >= 0 && row[cPlant] ? String(row[cPlant]).trim() : null;
    const region = cRegion >= 0 && row[cRegion] ? String(row[cRegion]).trim() : null;
    const existing = await prisma.standardCost.findFirst({ where: { productId: product.id, plant, region, currency, costType, effectiveFrom: from } });
    if (existing) {
      if (!money(existing.cost)!.eq(cost) || String(existing.effectiveTo ?? "") !== String(to ?? "")) { await prisma.standardCost.update({ where: { id: existing.id }, data: { cost: toDb(cost)!, effectiveTo: to } }); report.updated++; }
      continue;
    }
    await prisma.standardCost.create({ data: { productId: product.id, cost: toDb(cost)!, currency, plant, region, costType, effectiveFrom: from, effectiveTo: to, source: "import" } });
    report.created++;
  }
  return report;
}

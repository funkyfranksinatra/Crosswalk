/**
 * Pricing import: SKU, List Price, COGS, and any number of pricebook
 * columns. Header names are matched loosely. Produces a template too.
 */
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { normalizeCfn } from "@/lib/cfn";

export type PricingImportResult = { updated: number; unknownSkus: string[]; pricebooks: string[]; rows: number };

export async function importPricing(buffer: Buffer, companyId: string): Promise<PricingImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Workbook has no sheets");
  const grid: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    const cells: (string | number | null)[] = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const v = cell.value;
      cells[c - 1] = typeof v === "number" ? v : v == null ? null : typeof v === "object" && "result" in v ? (v.result as string | number) : String(v);
    });
    grid[r - 1] = cells;
  });
  return importPricingRows(grid, companyId);
}

/** Same import from a plain grid (CSV or Google Sheet). Header row first. */
export async function importPricingRows(grid: (string | number | null | undefined)[][], companyId: string): Promise<PricingImportResult> {
  const headerCells = grid[0] ?? [];
  const cols: Record<string, number> = {};
  const pricebookCols: { name: string; col: number }[] = [];
  headerCells.forEach((cell, i) => {
    const t = String(cell ?? "").trim();
    const l = t.toLowerCase();
    if (!t) return;
    if (/^(sku|product\s*code|cfn|catalog|item)/.test(l)) cols.sku = i + 1;
    else if (/^(list\s*price|list)$/.test(l)) cols.list = i + 1;
    else if (/^(cogs|cost|cost\s*to\s*manufacture|unit\s*cost|standard\s*cost)$/.test(l)) cols.cogs = i + 1;
    else if (/^(description|desc|category)$/.test(l)) cols.desc = i + 1;
    else pricebookCols.push({ name: t, col: i + 1 });
  });
  if (!cols.sku) throw new Error("Could not find a SKU column (expected 'SKU' or 'Product Code')");
  const cellAt = (r: number, c: number) => (grid[r] ?? [])[c - 1] ?? null;

  const products = await prisma.ownProduct.findMany({ where: { companyId }, select: { id: true, sku: true } });
  const bySku = new Map(products.map((p) => [normalizeCfn(p.sku), p.id]));
  const pricebooks = new Map<string, string>();
  for (const pb of pricebookCols) {
    const row = await prisma.pricebook.upsert({ where: { name: pb.name }, create: { name: pb.name }, update: {} });
    pricebooks.set(pb.name, row.id);
  }

  let updated = 0;
  const unknown: string[] = [];
  let rows = 0;
  for (let r = 1; r < grid.length; r++) {
    const sku = normalizeCfn(cellAt(r, cols.sku));
    if (!sku) continue;
    rows++;
    const id = bySku.get(sku);
    if (!id) { unknown.push(sku); continue; }
    const num = (c?: number) => {
      if (!c) return undefined;
      const v = cellAt(r, c);
      const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
      return Number.isFinite(n) && String(v ?? "") !== "" ? n : undefined;
    };
    const listPrice = num(cols.list);
    const cogs = num(cols.cogs);
    await prisma.ownProduct.update({ where: { id }, data: { ...(listPrice !== undefined ? { listPrice } : {}), ...(cogs !== undefined ? { cogs } : {}) } });
    for (const pb of pricebookCols) {
      const price = num(pb.col);
      if (price === undefined) continue;
      const pricebookId = pricebooks.get(pb.name)!;
      await prisma.priceEntry.upsert({ where: { pricebookId_productId: { pricebookId, productId: id } }, create: { pricebookId, productId: id, price }, update: { price } });
    }
    updated++;
  }
  return { updated, unknownSkus: unknown, pricebooks: [...pricebooks.keys()], rows };
}

export async function pricingTemplateRows(companyId: string): Promise<(string | number | null)[][]> {
  const products = await prisma.ownProduct.findMany({ where: { companyId }, orderBy: [{ category: "asc" }, { sku: "asc" }], include: { prices: true } });
  const pricebooks = await prisma.pricebook.findMany({ orderBy: { name: "asc" } });
  const headers = ["SKU", "Description", "Category", "List Price", "COGS", ...pricebooks.map((p) => p.name)];
  if (pricebooks.length === 0) headers.push("HOSPITAL LIST PRICE");
  const rows: (string | number | null)[][] = [headers];
  for (const p of products) {
    const row: (string | number | null)[] = [p.sku, p.description, p.category ?? "", p.listPrice ?? null, p.cogs ?? null];
    for (const pb of pricebooks) row.push(p.prices.find((e) => e.pricebookId === pb.id)?.price ?? null);
    if (pricebooks.length === 0) row.push(null);
    rows.push(row);
  }
  return rows;
}

export async function pricingTemplate(companyId: string): Promise<Buffer> {
  const products = await prisma.ownProduct.findMany({ where: { companyId }, orderBy: [{ category: "asc" }, { sku: "asc" }], include: { prices: { include: { pricebook: true } } } });
  const pricebooks = await prisma.pricebook.findMany({ orderBy: { name: "asc" } });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Pricing");
  const headers = ["SKU", "Description", "Category", "List Price", "COGS", ...pricebooks.map((p) => p.name)];
  if (pricebooks.length === 0) headers.push("HOSPITAL LIST PRICE");
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3F1EF" } };
  for (const p of products) {
    const row: (string | number | null)[] = [p.sku, p.description, p.category ?? "", p.listPrice ?? null, p.cogs ?? null];
    for (const pb of pricebooks) row.push(p.prices.find((e) => e.pricebookId === pb.id)?.price ?? null);
    if (pricebooks.length === 0) row.push(null);
    ws.addRow(row);
  }
  ws.columns = headers.map((h, i) => ({ width: i === 1 ? 60 : 18 }));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

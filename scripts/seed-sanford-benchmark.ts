/**
 * Benchmark fixture for the PACR comparison (REQ-7628, account 0001583870).
 *
 *   npx tsx scripts/seed-sanford-benchmark.ts <SSXrefReport_REQ-7628.xlsx>
 *
 * Creates (idempotently) the account, its Vizient membership, the two local contracts
 * ("TROCAR - SANFORD HLTH", "ENDO - SANFORD HLTH"), the Vizient Tier-1 trocar GPO contract
 * and the HOSPITAL LIST PRICE book, and one PriceEntry per Medtronic SKU that the PACR
 * export priced — the price and book name come straight from the export, so the pricing
 * comparison runs under the same contract context PACR had. Nothing else is touched:
 * SKUs the export did not price get no entry (a missing price must stay missing, with a
 * reason, not be invented). Every row carries source "benchmark:REQ-7628" so the fixture
 * can be removed with `--clean`.
 */
import "dotenv/config";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/db";
import { getCompany } from "../src/lib/settings";
import { isPlaceholderSku } from "../src/lib/cfn";

export const SANFORD = {
  accountNumber: "0001583870",
  accountName: "Sanford Medical Center Fargo West",
  source: "benchmark:REQ-7628",
  books: {
    "TROCAR - SANFORD HLTH": { kind: "LOCAL", contractNumber: "SANFORD-TROCAR" },
    "ENDO - SANFORD HLTH": { kind: "LOCAL", contractNumber: "SANFORD-ENDO" },
    "VIZIENT TROCAR T1": { kind: "GPO", contractNumber: "VIZIENT-TROCAR-T1", gpo: "Vizient", tier: "T1" },
    "HOSPITAL LIST PRICE": { kind: "LIST" },
  } as Record<string, { kind: "LOCAL" | "GPO" | "LIST"; contractNumber?: string; gpo?: string; tier?: string }>,
};

export type PacrRow = { competitor: string; code: string; description: string; quantity: number; estPrice: number | null; ownSku: string | null; ownDescription: string | null; additional: string | null; pricebook: string | null; price: number | null; matchType: string };

/** Read the PACR export (sheet "Competitor Usage Xref (SS)", header row 3). The TOTAL row is not a line. */
export async function readPacrExport(file: string): Promise<{ account: string; rows: PacrRow[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(file) as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => /xref/i.test(w.name)) ?? wb.worksheets[0];
  const cell = (r: ExcelJS.Row, i: number) => { const v = r.getCell(i).value; if (v == null) return null; if (typeof v === "object" && "result" in v) return (v as { result: unknown }).result; if (typeof v === "object" && "richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join(""); return v; };
  const str = (v: unknown) => (v == null ? "" : String(v).trim());
  const num = (v: unknown) => { const n = typeof v === "number" ? v : Number(str(v)); return Number.isFinite(n) && str(v) !== "" ? n : null; };
  const account = str(cell(ws.getRow(2), 1)).replace(/^Account:\s*/i, "");
  const rows: PacrRow[] = [];
  ws.eachRow((r, n) => {
    if (n <= 3) return;
    const code = str(cell(r, 2));
    if (!code || str(cell(r, 1)).toUpperCase() === "TOTAL") return;
    const ownSkuRaw = str(cell(r, 7));
    rows.push({ competitor: str(cell(r, 1)), code, description: str(cell(r, 3)), quantity: num(cell(r, 4)) ?? 1, estPrice: num(cell(r, 5)), ownSku: ownSkuRaw && !isPlaceholderSku(ownSkuRaw) ? ownSkuRaw : null, ownDescription: str(cell(r, 8)) || null, additional: str(cell(r, 9)) || null, pricebook: str(cell(r, 12)) || null, price: num(cell(r, 13)), matchType: str(cell(r, 15)) });
  });
  return { account, rows };
}

export async function seedSanfordBenchmark(file: string, opts: { asOf?: Date } = {}) {
  const company = await getCompany();
  const { rows } = await readPacrExport(file);
  const from = opts.asOf ?? new Date("2026-01-01T00:00:00Z");
  const account = await prisma.account.upsert({ where: { accountNumber: SANFORD.accountNumber }, create: { accountNumber: SANFORD.accountNumber, name: SANFORD.accountName, type: "SOLD_TO", currency: "USD" }, update: { name: SANFORD.accountName } });
  const vizient = await prisma.gpo.upsert({ where: { name: "Vizient" }, create: { name: "Vizient" }, update: {} });
  const membership = await prisma.gpoMembership.findFirst({ where: { accountId: account.id, gpoId: vizient.id } });
  if (!membership) await prisma.gpoMembership.create({ data: { accountId: account.id, gpoId: vizient.id, tier: "T1", effectiveFrom: from, source: SANFORD.source } });
  else if (membership.tier !== "T1") await prisma.gpoMembership.update({ where: { id: membership.id }, data: { tier: "T1" } });

  // Distinct (SKU, book) → price. The export never prices one SKU two ways inside one book; if it did, we stop.
  const prices = new Map<string, { sku: string; book: string; price: number }>();
  for (const r of rows) {
    if (!r.ownSku || !r.pricebook || r.price == null || !(r.pricebook in SANFORD.books)) continue;
    const k = `${r.ownSku.toUpperCase()}|${r.pricebook}`;
    const prev = prices.get(k);
    if (prev && prev.price !== r.price) throw new Error(`PACR export prices ${r.ownSku} two ways in ${r.pricebook}: ${prev.price} vs ${r.price}`);
    prices.set(k, { sku: r.ownSku, book: r.pricebook, price: r.price });
  }
  const own = await prisma.ownProduct.findMany({ where: { companyId: company.id }, select: { id: true, sku: true } });
  const bySku = new Map(own.map((p) => [p.sku.toUpperCase(), p.id]));
  const summary: Record<string, { entries: number; missingSku: string[] }> = {};
  const containers: Record<string, { pricebookId?: string; contractId?: string }> = {};
  for (const [name, def] of Object.entries(SANFORD.books)) {
    if (def.kind === "LIST") { const pb = await prisma.pricebook.upsert({ where: { name }, create: { name, currency: "USD" }, update: {} }); containers[name] = { pricebookId: pb.id }; }
    else {
      const c = await prisma.contract.upsert({
        where: { contractNumber: def.contractNumber! },
        create: { contractNumber: def.contractNumber!, name, type: def.kind, status: "ACTIVE", accountId: def.kind === "LOCAL" ? account.id : null, gpoId: def.kind === "GPO" ? vizient.id : null, tier: def.tier ?? null, currency: "USD", effectiveFrom: from, sourceSystem: "import", notes: `${SANFORD.source}: prices as reported by the PACR export for account ${SANFORD.accountNumber}` },
        update: { name, status: "ACTIVE", effectiveFrom: from, effectiveTo: null },
      });
      containers[name] = { contractId: c.id };
    }
    summary[name] = { entries: 0, missingSku: [] };
  }
  // Replace this fixture's entries wholesale so re-running the seed converges.
  await prisma.priceEntry.deleteMany({ where: { source: SANFORD.source } });
  for (const p of prices.values()) {
    const productId = bySku.get(p.sku.toUpperCase());
    if (!productId) { summary[p.book].missingSku.push(p.sku); continue; }
    const c = containers[p.book];
    await prisma.priceEntry.create({ data: { pricebookId: c.pricebookId ?? null, contractId: c.contractId ?? null, accountId: c.contractId && SANFORD.books[p.book].kind === "LOCAL" ? account.id : null, gpoId: SANFORD.books[p.book].kind === "GPO" ? vizient.id : null, productId, price: p.price, currency: "USD", effectiveFrom: from, tier: SANFORD.books[p.book].tier ?? null, source: SANFORD.source, status: "ACTIVE", approvalState: "APPROVED" } });
    summary[p.book].entries++;
  }
  return { accountId: account.id, pricebookId: containers["HOSPITAL LIST PRICE"].pricebookId!, lines: rows.length, summary };
}

export async function cleanSanfordBenchmark() {
  await prisma.priceEntry.deleteMany({ where: { source: SANFORD.source } });
  await prisma.contract.deleteMany({ where: { contractNumber: { in: Object.values(SANFORD.books).map((b) => b.contractNumber).filter((x): x is string => Boolean(x)) } } });
  await prisma.gpoMembership.deleteMany({ where: { source: SANFORD.source } });
}

if (process.argv[1] && /seed-sanford-benchmark/.test(process.argv[1])) {
  (async () => {
    if (process.argv.includes("--clean")) { await cleanSanfordBenchmark(); console.log("benchmark fixture removed"); }
    else {
      const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
      if (!file) throw new Error("usage: seed-sanford-benchmark.ts <PACR export .xlsx> [--clean]");
      const r = await seedSanfordBenchmark(file);
      console.log(JSON.stringify(r, null, 2));
    }
    await prisma.$disconnect();
  })().catch((e) => { console.error(e); process.exit(1); });
}

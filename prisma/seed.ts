/**
 * Seed: the deployed company, its catalog (every MDT SKU in the curated
 * Endomechanical sheet) and the curated cross references themselves.
 * Idempotent — re-run any time.
 *
 *   npm run db:seed            # sheet only (fast, offline)
 *   npm run db:seed -- --gudid # also enrich own products from openFDA
 */
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/db";
import { normalizeCfn, isPlaceholderSku } from "../src/lib/cfn";
import { heuristicBin, FAMILIES } from "../src/lib/match/bin";

const SHEET = path.resolve(process.cwd(), "data/reference/Endomechanical.xlsx");
const COMPANY = process.env.COMPANY_NAME ?? "Medtronic";

type Row = { category: string; sku: string; description: string; matchType: string; competitorName: string; competitorCode: string; competitorDescription: string; reviewer: string; comment: string; sheet: string };

function txt(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "result" in v) return txt(v.result as ExcelJS.CellValue);
  return String(v).replace(/\s+/g, " ").trim();
}

async function main() {
  const withGudid = process.argv.includes("--gudid");
  if (!fs.existsSync(SHEET)) {
    // The reference sheets are not in git (customer / company data). Without them the app still
    // runs: the catalog just starts empty and grows via Catalog -> Add SKUs.
    console.log(`No curated cross-reference sheet at ${path.relative(process.cwd(), SHEET)}.`);
    console.log("Ask the project owner for data/reference/Endomechanical.xlsx (own SKUs + curated crosses) and, optionally,");
    console.log("SSXrefReport_REQ-7604.xlsx (hernia SKUs + list prices) and CrossReference_0001880967.xlsx (sample intake).");
    console.log("Seeding only the company record and the default pricebook; the catalog starts empty.");
    await prisma.company.upsert({ where: { name: COMPANY }, create: { name: COMPANY }, update: {} });
    await prisma.pricebook.upsert({ where: { name: "HOSPITAL LIST PRICE" }, create: { name: "HOSPITAL LIST PRICE" }, update: {} });
    return;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SHEET);

  const rows: Row[] = [];
  let skippedPlaceholders = 0;
  for (const ws of wb.worksheets) {
    // Skip "Delete" sheets — they are the reviewers' reject piles.
    if (/delete/i.test(ws.name)) continue;
    const header = ws.getRow(1);
    const h = (i: number) => txt(header.getCell(i).value).toLowerCase();
    // Expected: COT | MDT SKU | MDT SKU Description | MATCH TYPE | TO COMPANY | Comp Code | Comp Description | <reviewer cols…>
    if (!/sku/.test(h(2)) || !/match/.test(h(4))) continue;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      let sku = txt(row.getCell(2).value);
      const code = txt(row.getCell(6).value);
      if (!sku || !code) continue;
      // "No Match, SIG45AVCLOSESUB" — a reviewer's "nothing exact, but this is the closest" — is that SKU.
      const closest = sku.match(/^no\s*match[\s,;:/-]+([A-Z0-9][A-Z0-9-]{3,})\s*$/i);
      if (closest) sku = closest[1];
      // "No Match" / "N/A" in the SKU column is a curated non-cross, not a product; never let it into the catalog.
      if (isPlaceholderSku(sku) || isPlaceholderSku(code)) { skippedPlaceholders++; continue; }
      const reviewerCells: string[] = [];
      for (let c = 8; c <= Math.max(8, ws.columnCount); c++) {
        const v = txt(row.getCell(c).value);
        if (v) reviewerCells.push(v);
      }
      rows.push({
        category: txt(row.getCell(1).value),
        sku,
        description: txt(row.getCell(3).value),
        matchType: txt(row.getCell(4).value) || "Close Match",
        competitorName: txt(row.getCell(5).value) || "Unknown",
        competitorCode: code,
        competitorDescription: txt(row.getCell(7).value),
        reviewer: reviewerCells[0] ?? "",
        comment: reviewerCells.slice(1).join(" | "),
        sheet: ws.name,
      });
    }
  }
  console.log(`Read ${rows.length} curated rows from ${SHEET}${skippedPlaceholders ? ` (${skippedPlaceholders} placeholder rows skipped)` : ""}`);

  // Single tenant: if a company already exists under another name, the seed loads into IT rather than
  // creating a second row nobody is served from (COMPANY_NAME drift). Rename it in Settings if needed.
  const existing = await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing && existing.name !== COMPANY) console.warn(`Company "${existing.name}" already exists; seeding into it (COMPANY_NAME=${COMPANY} was not used to create a second company)`);
  const company = existing ?? await prisma.company.create({ data: { name: COMPANY, labelers: JSON.stringify(["Covidien", "Medtronic", "Sofradim"]) } });

  // Own products: every MDT SKU + every Medtronic "competitor" code (internal substitutes are also our SKUs)
  const own = new Map<string, { description: string; category: string }>();
  for (const r of rows) {
    const sku = normalizeCfn(r.sku);
    if (!own.has(sku) || (!own.get(sku)!.description && r.description)) own.set(sku, { description: r.description, category: r.category });
    if (/^medtronic$/i.test(r.competitorName)) {
      const c = normalizeCfn(r.competitorCode);
      if (!own.has(c)) own.set(c, { description: r.competitorDescription, category: r.category });
    }
  }
  let created = 0;
  for (const [sku, v] of own) {
    const bin = heuristicBin({ sku, description: v.description, category: v.category });
    await prisma.ownProduct.upsert({
      where: { companyId_sku: { companyId: company.id, sku } },
      create: { companyId: company.id, sku, description: v.description, category: v.category, binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date() },
      update: { description: v.description || undefined, category: v.category || undefined },
    });
    created++;
  }
  // Refresh heuristic bins for every product that has not been binned by the model
  // (rules improve over time; GUDID data may have arrived since).
  const { summarizeRecord } = await import("../src/lib/gudid/openfda");
  for (const p of await prisma.ownProduct.findMany({ where: { companyId: company.id, NOT: { binSource: "llm" } } })) {
    const raw = p.gudidJson ? JSON.parse(p.gudidJson) : null;
    const g = raw ? summarizeRecord(raw) : null;
    const bin = heuristicBin({ sku: p.sku, brand: p.brand, description: g ? `${p.description} ; ${g.description ?? ""}` : p.description, category: p.category, gmdnName: p.gmdnName, sizes: g?.sizes, singleUse: g?.singleUse, sterile: g?.sterile, implantable: g?.implantable });
    // Categories that were auto-derived (they equal a family name) follow the bin; curated sales categories are kept.
    const autoCategory = !p.category || FAMILIES.includes(p.category as (typeof FAMILIES)[number]);
    await prisma.ownProduct.update({ where: { id: p.id }, data: { binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date(), ...(autoCategory && bin.family !== "Other" ? { category: bin.family } : {}) } });
  }
  console.log(`Upserted ${created} own products for ${COMPANY}`);

  // Known crosses (skip Medtronic→Medtronic internal substitutes as "crosses"; keep them as products above)
  let crosses = 0;
  for (const r of rows) {
    if (/^medtronic$/i.test(r.competitorName)) continue;
    const preferred = r.reviewer && /^[A-Z0-9][A-Z0-9-]{3,}$/i.test(r.reviewer.split(/\s|\n/)[0]) && !/^(disc|delete|discontinued)$/i.test(r.reviewer) ? r.reviewer.split(/\s|\n/)[0].toUpperCase() : null;
    const additional = /reusable|disposable|handle|shell|adapter/i.test(r.reviewer) ? r.reviewer : null;
    await prisma.knownCross.upsert({
      where: { ownSku_competitorCodeNorm_source: { ownSku: normalizeCfn(r.sku), competitorCodeNorm: normalizeCfn(r.competitorCode), source: r.sheet } },
      create: {
        ownSku: normalizeCfn(r.sku),
        ownDescription: r.description,
        category: r.category,
        competitorName: r.competitorName,
        competitorCode: r.competitorCode,
        competitorCodeNorm: normalizeCfn(r.competitorCode),
        competitorDescription: r.competitorDescription,
        matchType: r.matchType,
        preferredOwnSku: preferred,
        additionalProducts: additional,
        notes: [r.reviewer && !preferred && !additional ? r.reviewer : "", r.comment].filter(Boolean).join(" | ") || null,
        source: r.sheet,
        isActive: !/discontinued|delete|remove from/i.test(r.reviewer + " " + r.comment),
      },
      update: { matchType: r.matchType, competitorDescription: r.competitorDescription, preferredOwnSku: preferred },
    });
    crosses++;
  }
  console.log(`Upserted ${crosses} known crosses`);

  await prisma.pricebook.upsert({ where: { name: "HOSPITAL LIST PRICE" }, create: { name: "HOSPITAL LIST PRICE" }, update: {} });

  // The legacy BAT report we were given names our hernia SKUs and their list prices — seed those too.
  const legacy = path.resolve(process.cwd(), "data/reference/SSXrefReport_REQ-7604.xlsx");
  if (fs.existsSync(legacy)) {
    const lwb = new ExcelJS.Workbook();
    await lwb.xlsx.readFile(legacy);
    const ws = lwb.worksheets[0];
    let n = 0;
    for (let r = 4; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const sku = normalizeCfn(txt(row.getCell(7).value));
      if (isPlaceholderSku(sku)) continue; // "No Match" rows and the TOTAL line (normalizeCfn strips the space: "NOMATCH")
      const description = txt(row.getCell(8).value);
      const category = txt(row.getCell(10).value);
      const pricebookName = txt(row.getCell(12).value);
      const price = Number(row.getCell(13).value);
      const bin = heuristicBin({ sku, description, category });
      const prod = await prisma.ownProduct.upsert({
        where: { companyId_sku: { companyId: company.id, sku } },
        create: { companyId: company.id, sku, description, category, binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date(), listPrice: Number.isFinite(price) && price > 0 ? price : null },
        update: { listPrice: Number.isFinite(price) && price > 0 ? price : undefined },
      });
      if (pricebookName && Number.isFinite(price) && price > 0) {
        const pb = await prisma.pricebook.upsert({ where: { name: pricebookName }, create: { name: pricebookName }, update: {} });
        const existing = await prisma.priceEntry.findFirst({ where: { pricebookId: pb.id, productId: prod.id, contractId: null } });
        if (existing) await prisma.priceEntry.update({ where: { id: existing.id }, data: { price } });
        else await prisma.priceEntry.create({ data: { pricebookId: pb.id, productId: prod.id, price, source: "legacy-report" } });
      }
      n++;
    }
    console.log(`Upserted ${n} own products + prices from the legacy BAT report`);
  }

  if (withGudid) {
    const { enrichOwnProducts } = await import("../src/lib/gudid/enrich");
    const res = await enrichOwnProducts(company.id, (m) => console.log(m));
    console.log(`GUDID enrichment: ${res.enriched} enriched, ${res.missing} not found`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

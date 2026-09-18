/**
 * Demo seed for a laptop without the reference spreadsheets (mac-demo branch).
 *
 * The main seed loads the curated Endomechanical sheet and the legacy BAT report when they are
 * present — they are company data and stay out of git, so a collaborator's clone starts with an
 * empty catalog and no crosses, and a demo run has nothing to match. This seed gives a fresh clone a
 * believable, self-contained catalog: ~40 own SKUs across the six families with list prices and
 * costs, and approved crosses for the competitor codes on the demo usage list
 * (data/demo/demo-usage-list.csv). It also warms the competitor cache from the recorded openFDA
 * responses, so the demo list resolves even with no internet.
 *
 * Idempotent: create-only upserts; a real catalog row (from the sheet or an import) is never
 * overwritten. Safe to run on top of a fully seeded database — it adds nothing that exists.
 *
 *   npx tsx prisma/seed-demo.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { heuristicBin } from "../src/lib/match/bin";
import { normalizeCfn } from "../src/lib/cfn";
import { equivalenceFromMatchType } from "../src/lib/xref/governance";

const COMPANY = process.env.COMPANY_NAME ?? "Medtronic";

// sku, description, category, list price, cost — realistic public-catalog descriptions, demo prices.
const CATALOG: [string, string, string, number, number][] = [
  // Hernia mesh
  ["PPM1106X3", "Parietene™ Macroporous Mesh 11 x 6 cm", "Synthetic Mesh", 48.34, 11.2],
  ["PPM1510X3", "Parietene™ Macroporous Mesh 15 x 10 cm", "Synthetic Mesh", 64.49, 14.8],
  ["PPM3020X3", "Parietene™ Macroporous Mesh 30 x 20 cm", "Synthetic Mesh", 168.0, 36.5],
  ["PPM4530", "Parietene™ Macroporous Mesh 45 x 30 cm", "Synthetic Mesh", 448.67, 92.0],
  ["PPDS12", "Parietene™ DS Composite Mesh, Round 12 cm", "Synthetic Mesh", 405.0, 88.0],
  ["PPDS15", "Parietene™ DS Composite Mesh, Round 15 cm", "Synthetic Mesh", 520.0, 110.0],
  ["PPDS1510", "Parietene™ DS Composite Mesh 15 x 10 cm", "Synthetic Mesh", 410.0, 90.0],
  ["PPDS2015", "Parietene™ DS Composite Mesh 20 x 15 cm", "Synthetic Mesh", 585.0, 126.0],
  ["PPDS3020", "Parietene™ DS Composite Mesh 30 x 20 cm", "Synthetic Mesh", 890.0, 190.0],
  ["PCO9X", "Parietex™ Optimized Composite Mesh, Skirted, Round 9 cm", "Hernia Mesh", 369.36, 80.0],
  ["PCO2015X", "Parietex™ Optimized Composite Mesh, Skirted, 20 x 15 cm", "Hernia Mesh", 795.0, 172.0],
  ["PCO2520X", "Parietex™ Optimized Composite Mesh, Skirted, 25 x 20 cm", "Hernia Mesh", 1040.0, 225.0],
  ["PCO3020X", "Parietex™ Optimized Composite Mesh, Skirted, 30 x 20 cm", "Hernia Mesh", 1190.0, 258.0],
  ["PMS1510", "Parietex™ ProGrip™ Self-Fixating Mesh 15 x 10 cm", "Synthetic Mesh", 298.0, 66.0],
  ["PMS3020", "Parietex™ ProGrip™ Self-Fixating Mesh 30 x 20 cm", "Synthetic Mesh", 612.0, 135.0],
  ["PGK1510", "Permacol™ Biologic Implant 15 x 10 cm", "Biologic Mesh", 2450.0, 610.0],
  // Fixation
  ["174006", "ProTack™ 5 mm Fixation Device, 30 tacks", "Fixation", 285.0, 61.0],
  ["ABSTACK30X", "AbsorbaTack™ 5 mm Absorbable Fixation Device, 30 tacks", "Fixation", 318.0, 70.0],
  ["ABSTACK15", "AbsorbaTack™ 5 mm Absorbable Fixation Device, 15 tacks", "Fixation", 205.0, 47.0],
  ["RELTACK30", "ReliaTack™ Articulating Reloadable Fixation Device, 30 tacks", "Fixation", 355.0, 78.0],
  // Stapling
  ["SIG60AMT", "Signia™ 60 mm Articulating Medium/Thick Reload, Tri-Staple™", "Surgical Stapling Products", 268.0, 58.0],
  ["SIG45AMT", "Signia™ 45 mm Articulating Medium/Thick Reload, Tri-Staple™", "Surgical Stapling Products", 246.0, 53.0],
  ["SIG60AVM", "Signia™ 60 mm Articulating Vascular/Medium Reload, Tri-Staple™", "Surgical Stapling Products", 268.0, 58.0],
  ["EGIA60AMT", "Endo GIA™ 60 mm Articulating Medium/Thick Reload, Tri-Staple™", "Surgical Stapling Products", 232.0, 50.0],
  ["EGIA45AVM", "Endo GIA™ 45 mm Articulating Vascular/Medium Reload, Tri-Staple™", "Surgical Stapling Products", 214.0, 46.0],
  ["EGIAUSTND", "Endo GIA™ Ultra Universal Stapler, Standard", "Surgical Stapling Products", 385.0, 84.0],
  ["EEA25", "EEA™ Circular Stapler 25 mm, 3.5 mm staples, Tri-Staple™", "Surgical Stapling Products", 495.0, 108.0],
  ["EEA28", "EEA™ Circular Stapler 28 mm, 4.8 mm staples, Tri-Staple™", "Surgical Stapling Products", 495.0, 108.0],
  // Trocars
  ["ONB5STF", "VersaOne™ Optical Trocar with Fixation Cannula, 5 mm x 100 mm", "Trocar Products", 42.0, 9.0],
  ["ONB12STF", "VersaOne™ Optical Trocar with Fixation Cannula, 12 mm x 100 mm", "Trocar Products", 58.0, 12.5],
  ["ONB12STS", "VersaOne™ Optical Trocar, Standard Cannula, 12 mm x 100 mm", "Trocar Products", 54.0, 11.5],
  ["ONB5SHF", "VersaOne™ Bladeless Trocar with Fixation Cannula, 5 mm x 100 mm", "Trocar Products", 44.0, 9.4],
  ["B5STF", "VersaOne™ Bladed Trocar, 5 mm x 100 mm", "Trocar Products", 36.0, 7.8],
  ["NB12STF", "VersaOne™ Bladeless Trocar, 12 mm x 100 mm", "Trocar Products", 52.0, 11.0],
  // Energy + hand instruments
  ["LF1937", "LigaSure™ Maryland Jaw Laparoscopic Sealer/Divider, 37 cm", "Energy", 598.0, 130.0],
  ["LF1944", "LigaSure™ Maryland Jaw Laparoscopic Sealer/Divider, 44 cm", "Energy", 612.0, 133.0],
  ["LF4318", "LigaSure™ Exact Dissector, 18 cm", "Energy", 540.0, 118.0],
  ["176644", "Endo Clip™ III 5 mm Clip Applier, 20 clips", "Laparoscopic Instruments (Hand)", 165.0, 36.0],
  ["173050G", "Endo Catch™ Gold 10 mm Specimen Retrieval Pouch", "Laparoscopic Instruments (Hand)", 118.0, 26.0],
  ["173049", "Endo Catch™ II 15 mm Specimen Retrieval Pouch", "Laparoscopic Instruments (Hand)", 132.0, 29.0],
];

// Approved crosses for the demo usage list: competitor code → our SKU (tier). Public catalog numbers.
const CROSSES: [string, string, string, string, string][] = [
  // code, competitor, competitor description, our SKU, match type
  ["1DLMC05", "W.L. Gore", "GORE DUALMESH Biomaterial 7.5 x 10 cm", "PPDS12", "Close Match"],
  ["1DLMC03", "W.L. Gore", "GORE DUALMESH Biomaterial 15 x 10 cm", "PPDS1510", "Close Match"],
  ["1410015010", "W.L. Gore", "GORE-TEX Soft Tissue Patch 10 x 15 cm", "PPM1510X3", "Close Match"],
  ["1315020020", "W.L. Gore", "GORE DUALMESH PLUS Biomaterial 20 x 15 cm", "PPDS2015", "Close Match"],
  ["SPMII", "Ethicon", "PROLENE Soft Polypropylene Mesh 15 x 15 cm", "PPM1510X3", "Exact Match"],
  ["SPMXXL", "Ethicon", "PROLENE Soft Polypropylene Mesh 30 x 30 cm", "PPM4530", "Close Match"],
  ["UPA31015", "Ethicon", "ULTRAPRO Advanced Partially Absorbable Mesh 10 x 15 cm", "PPM1510X3", "Close Match"],
  ["1190500", "BD - Bard", "Phasix Mesh 10 x 12 in", "PPM4530", "Alternative Match"],
  ["0112660", "BD - Bard", "Bard Soft Mesh 6 x 6 in", "PPM1510X3", "Close Match"],
  ["ECR60W", "Ethicon", "ECHELON 60 mm Reload, White", "SIG60AVM", "Exact Match"],
  ["GST60D", "Ethicon", "ECHELON 60 mm Reload, Gold", "EGIA60AMT", "Close Match"],
  ["ECS25", "Ethicon", "Proximate ILS Circular Stapler 25 mm", "EEA25", "Exact Match"],
  ["B12LT", "Ethicon", "ENDOPATH XCEL Bladeless Trocar 12 mm x 100 mm", "NB12STF", "Exact Match"],
  ["CFI12", "Applied Medical", "Kii Fios First Entry Trocar 12 mm", "ONB12STF", "Close Match"],
  ["CTN14", "Applied Medical", "Kii Balloon Blunt Tip 12 mm", "ONB12STS", "Close Match"],
  ["HAR36", "Ethicon", "HARMONIC ACE+7 Shears 36 cm", "LF1937", "Alternative Match"],
  ["CATCH10", "Applied Medical", "Inzii Retrieval System 10 mm", "173050G", "Close Match"],
];

async function main() {
  const company = (await prisma.company.findUnique({ where: { name: COMPANY } })) ?? (await prisma.company.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await prisma.company.create({ data: { name: COMPANY, labelers: JSON.stringify(["Covidien", "Medtronic", "Sofradim"]) } }));
  let products = 0;
  for (const [sku, description, category, listPrice, cogs] of CATALOG) {
    const bin = heuristicBin({ sku, description, category });
    const r = await prisma.ownProduct.upsert({ where: { companyId_sku: { companyId: company.id, sku } }, create: { companyId: company.id, sku, description, category, listPrice, cogs, binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date(), source: "seed" }, update: {} });
    if (r.listPrice === null) await prisma.ownProduct.update({ where: { id: r.id }, data: { listPrice } }); // a sheet row without a price gets the demo price
    if (r.cogs === null) await prisma.ownProduct.update({ where: { id: r.id }, data: { cogs } });
    products++;
  }
  console.log(`Demo catalog: ${products} SKUs ensured for ${company.name}`);

  const admin = await prisma.user.findUnique({ where: { email: "admin@crosswalk.dev" } });
  let crosses = 0;
  for (const [code, competitorName, competitorDescription, ownSku, matchType] of CROSSES) {
    const own = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku: ownSku } } });
    if (!own) continue;
    const norm = normalizeCfn(code);
    const existing = await prisma.knownCross.findFirst({ where: { competitorCodeNorm: norm, ownSku, approvalStatus: "APPROVED" } });
    if (existing) continue;
    await prisma.knownCross.upsert({
      where: { ownSku_competitorCodeNorm_source: { ownSku, competitorCodeNorm: norm, source: "demo" } },
      create: { ownSku, ownDescription: own.description, category: own.category, competitorName, competitorCode: code, competitorCodeNorm: norm, competitorDescription, matchType, source: "demo", approvalStatus: "APPROVED", clinicalReviewStatus: "APPROVED", marketingReviewStatus: "APPROVED", equivalenceLevel: equivalenceFromMatchType(matchType), justification: "Demo fixture — curated for the mac-demo branch", createdByUserId: admin?.id ?? null, approvedByUserId: admin?.id ?? null, approvedAt: new Date(), isActive: true },
      update: {},
    });
    crosses++;
  }
  console.log(`Demo crosses: ${crosses} added (existing approved crosses kept)`);

  // Warm the competitor cache from the recorded openFDA responses so the demo list resolves offline.
  const dir = path.resolve(process.cwd(), "tests/recorded/openfda");
  const indexFile = path.join(dir, "index.json");
  if (fs.existsSync(indexFile)) {
    const { setFetchForTests } = await import("../src/lib/gudid/http");
    const { resolveCfn } = await import("../src/lib/pipeline/resolve");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Record<string, string>;
    const strip = (url: string) => url.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "");
    setFetchForTests(async (url) => {
      const file = index[strip(url)];
      if (!file) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404, headers: { "content-type": "application/json" } });
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { status: number; body: string };
      return new Response(rec.body, { status: rec.status, headers: { "content-type": "application/json" } });
    });
    let warmed = 0;
    for (const code of ["1DLMC05", "SPMII", "1190500", "PPM1510X3", "1410015010"]) {
      const cached = await prisma.competitorProduct.findUnique({ where: { cfnNorm: code } });
      if (cached && cached.resolution !== "not-found") continue;
      const cp = await resolveCfn(code, { useLlm: false, strict: true }).catch(() => null);
      if (cp && cp.resolution !== "not-found") warmed++;
    }
    setFetchForTests(null);
    console.log(`Competitor cache: ${warmed} codes warmed from recorded openFDA responses`);
  }
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

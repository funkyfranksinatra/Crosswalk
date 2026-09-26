/**
 * Enterprise seed / backfill — idempotent, safe to re-run.
 *
 *   npx tsx prisma/seed-enterprise.ts            # backfill + demo commercial data
 *   npx tsx prisma/seed-enterprise.ts --no-demo  # backfill only (production-style)
 *
 * Backfill (always):
 *   - dev users for every role (development sign-in)
 *   - OwnProduct.cogs → StandardCost (global) where no dated cost exists
 *   - PriceEntry: currency / status defaults are schema defaults; nothing to touch
 *   - Requests with an account number → Account rows, linked
 *   - default "*" pricing policy + per-family policies (mesh commodity-ish, staplers differentiated)
 *   - crosswalk version 1 published from every active KnownCross (matchType → equivalence)
 *
 * Demo (unless --no-demo): the realistic deal fixture from docs/BUSINESS_RULES.md:
 *   Memorial Sloan Kettering belongs to GPO "Premier" Tier 2; a local contract overrides two
 *   mesh SKUs; competitor prices observed at three hospitals (one six months old); standard
 *   costs by plant; exchange rate row; dev integration fixtures.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { ROLES } from "../src/lib/auth/permissions";
import { publishVersion, equivalenceFromMatchType } from "../src/lib/xref/governance";
import { DEFAULT_POLICY } from "../src/lib/pricing/policy-model";
import { recordObservation } from "../src/lib/intelligence";
import { audit } from "../src/lib/audit";
import { normalizeCfn } from "../src/lib/cfn";
import { defaultCompanyName, defaultLabelers } from "../src/lib/tenancy";

const demo = !process.argv.includes("--no-demo");
const COMPANY = defaultCompanyName();

/** The served company, resolved as the app does (name → oldest row); created with OWN_LABELERS only on an empty database. */
async function resolveCompany() {
  return (await prisma.company.findUnique({ where: { name: COMPANY } })) ?? (await prisma.company.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await prisma.company.create({ data: { name: COMPANY, labelers: JSON.stringify(defaultLabelers()) } }));
}
const day = (s: string) => new Date(s + "T00:00:00Z");
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d; };

export const DEV_USERS: { email: string; name: string; roles: string[] }[] = [
  { email: "alex.rep@crosswalk.dev", name: "Alex Rivera (Sales Rep)", roles: ["SALES_REP"] },
  { email: "maria.manager@crosswalk.dev", name: "Maria Chen (Regional Manager)", roles: ["REGIONAL_MANAGER"] },
  { email: "sam.contracting@crosswalk.dev", name: "Sam Okafor (Contracting Manager)", roles: ["CONTRACTING_MANAGER"] },
  { email: "priya.analyst@crosswalk.dev", name: "Priya Nair (Pricing Analyst)", roles: ["PRICING_ANALYST"] },
  { email: "dana.director@crosswalk.dev", name: "Dana Whitfield (Pricing Director)", roles: ["PRICING_DIRECTOR"] },
  { email: "committee@crosswalk.dev", name: "Pricing Committee", roles: ["PRICING_COMMITTEE"] },
  { email: "lee.marketing@crosswalk.dev", name: "Lee Park (Product Marketing)", roles: ["PRODUCT_MARKETING"] },
  { email: "dr.clinical@crosswalk.dev", name: "Dr. Ana Souza (Clinical Reviewer)", roles: ["CLINICAL_REVIEWER"] },
  { email: "finance@crosswalk.dev", name: "Finance", roles: ["FINANCE"] },
  { email: "admin@crosswalk.dev", name: "Crosswalk Admin", roles: ["ADMIN"] },
  { email: "exec@crosswalk.dev", name: "Executive (read only)", roles: ["EXECUTIVE"] },
];

async function backfill() {
  for (const u of DEV_USERS) {
    const user = await prisma.user.upsert({ where: { email: u.email }, create: { email: u.email, name: u.name }, update: { name: u.name } });
    for (const role of u.roles) await prisma.userRole.upsert({ where: { userId_role: { userId: user.id, role } }, create: { userId: user.id, role }, update: {} });
  }
  console.log(`Users: ${DEV_USERS.length} dev users across ${ROLES.length} roles`);
  // Single tenant: load into the existing company whatever its name (never a second row).
  const company = await resolveCompany();

  // Legacy COGS → dated StandardCost (global), only where nothing exists.
  const withCogs = await prisma.ownProduct.findMany({ where: { companyId: company.id, cogs: { not: null } }, include: { costs: true } });
  let costs = 0;
  for (const p of withCogs) if (!p.costs.length) { await prisma.standardCost.create({ data: { productId: p.id, currency: p.currency, cost: p.cogs!, effectiveFrom: day("2025-01-01"), source: "backfill" } }); costs++; }
  console.log(`StandardCost backfilled from legacy COGS: ${costs}`);

  // Requests → Accounts
  const reqs = await prisma.request.findMany({ where: { accountId: null, accountNumber: { not: null } } });
  for (const r of reqs) {
    const acc = await prisma.account.upsert({ where: { accountNumber: r.accountNumber! }, create: { accountNumber: r.accountNumber!, name: r.accountName ?? r.accountNumber!, type: r.accountType?.toUpperCase().replace(/-/g, "_") ?? "SOLD_TO" }, update: {} });
    await prisma.request.update({ where: { id: r.id }, data: { accountId: acc.id } });
  }
  if (reqs.length) console.log(`Accounts created from ${reqs.length} request(s)`);

  // Policies
  const admin = await prisma.user.findUnique({ where: { email: "admin@crosswalk.dev" } });
  const families: { family: string; over: Partial<typeof DEFAULT_POLICY> & { name: string } }[] = [
    { family: "*", over: { name: "Default commercial policy" } },
    { family: "Synthetic Mesh", over: { name: "Synthetic mesh — commodity", classification: "COMMODITY", targetMarginPct: 0.55, minMarginPct: 0.35, defaultStrategy: "UNDERCUT_PCT", defaultAdjustmentPct: 0.025, strategicImportance: 2 } },
    { family: "Hernia Mesh", over: { name: "Hernia mesh (composite/barrier) — differentiated", classification: "DIFFERENTIATED", targetMarginPct: 0.6, minMarginPct: 0.4, defaultStrategy: "HOLD_PREMIUM", defaultAdjustmentPct: 0.03, strategicImportance: 4 } },
    { family: "Surgical Stapling Products", over: { name: "Stapling — strategic platform", classification: "DIFFERENTIATED", targetMarginPct: 0.62, minMarginPct: 0.45, defaultStrategy: "MATCH", strategicImportance: 5, approvalRules: [{ when: { belowFloor: true }, require: "PRICING_COMMITTEE", reason: "below floor" }, { when: { discountFromListOver: 0.3 }, require: "PRICING_DIRECTOR", reason: "stapling discount over 30%" }] } },
    { family: "Trocar Products", over: { name: "Trocars — commodity", classification: "COMMODITY", targetMarginPct: 0.5, minMarginPct: 0.3, defaultStrategy: "MATCH", strategicImportance: 3 } },
    { family: "Fixation", over: { name: "Fixation devices", targetMarginPct: 0.58, minMarginPct: 0.4, defaultStrategy: "MATCH", strategicImportance: 4 } },
  ];
  for (const f of families) {
    const existing = await prisma.pricingPolicy.findFirst({ where: { productFamily: f.family, status: "ACTIVE" } });
    if (existing) continue;
    const m = { ...DEFAULT_POLICY, ...f.over };
    await prisma.pricingPolicy.create({ data: { productFamily: f.family, version: 1, status: "ACTIVE", name: f.over.name, targetMarginPct: m.targetMarginPct, minMarginPct: m.minMarginPct, floorMethod: m.floorMethod, floorParamsJson: JSON.stringify(m.floorParams), defaultStrategy: m.defaultStrategy, defaultAdjustmentPct: m.defaultAdjustmentPct, classification: m.classification, strategicImportance: m.strategicImportance, authorityJson: JSON.stringify(m.authority), approvalRulesJson: JSON.stringify(m.approvalRules), createdByUserId: admin?.id ?? null } });
  }
  console.log(`Pricing policies: ${families.length} families ensured`);

  // Crosswalk governance: existing curated crosses are APPROVED (they came from the reviewed sheets); publish v1 if none exists.
  // One updateMany per match type (4 statements instead of thousands of row updates over the wire).
  for (const matchType of ["Exact Match", "Close Match", "Alternative Match", "US Downsell Match"]) {
    await prisma.knownCross.updateMany({ where: { source: { not: "rep" }, approvedAt: null, matchType }, data: { approvalStatus: "APPROVED", clinicalReviewStatus: "APPROVED", marketingReviewStatus: "APPROVED", equivalenceLevel: equivalenceFromMatchType(matchType), approvedAt: day("2026-09-01"), effectiveFrom: day("2026-09-01") } });
  }
  await prisma.knownCross.updateMany({ where: { source: { not: "rep" }, approvedAt: null }, data: { approvalStatus: "APPROVED", equivalenceLevel: "NONE", approvedAt: day("2026-09-01"), effectiveFrom: day("2026-09-01") } });
  const published = await prisma.crosswalkVersion.findFirst({ where: { status: "PUBLISHED" } });
  if (!published) { const v = await publishVersion(admin?.id ?? null, "Initial publish of the curated cross-reference sheets"); console.log(`Crosswalk v${v.version.number} published with ${v.entries} entries`); }
  else console.log(`Crosswalk v${published.number} already published`);
}

async function demoData() {
  const company = await resolveCompany();
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@crosswalk.dev" } });
  const rep = await prisma.user.findUniqueOrThrow({ where: { email: "alex.rep@crosswalk.dev" } });
  const premier = await prisma.gpo.upsert({ where: { name: "Premier" }, create: { name: "Premier", code: "PREM" }, update: {} });
  await prisma.gpo.upsert({ where: { name: "Vizient" }, create: { name: "Vizient", code: "VIZ" }, update: {} });

  // Accounts: MSK under an IDN parent; two peer hospitals for observations; hospitals A/C/D in the same GPO.
  const idn = await prisma.account.upsert({ where: { accountNumber: "IDN-NYC-001" }, create: { accountNumber: "IDN-NYC-001", name: "NYC Academic Health System (IDN)", type: "IDN", region: "US-East", segment: "Academic", currency: "USD" }, update: {} });
  const msk = await prisma.account.upsert({ where: { accountNumber: "0001880967" }, create: { accountNumber: "0001880967", name: "Memorial Sloan Kettering", type: "SOLD_TO", parentAccountId: idn.id, region: "US-East", segment: "Academic", isStrategic: true, currency: "USD", ownerUserId: rep.id }, update: { parentAccountId: idn.id, region: "US-East", segment: "Academic", isStrategic: true, ownerUserId: rep.id } });
  const peers = [] as { id: string }[];
  for (const [num, name] of [["0002000101", "Hospital A — Mount Vernon General"], ["0002000102", "Hospital C — Riverside Medical"], ["0002000103", "Hospital D — Lakeshore Regional"]]) {
    peers.push(await prisma.account.upsert({ where: { accountNumber: num }, create: { accountNumber: num, name, type: "SOLD_TO", region: "US-East", segment: "Community", currency: "USD" }, update: {} }));
  }
  for (const a of [msk, ...peers]) {
    const has = await prisma.gpoMembership.findFirst({ where: { accountId: a.id, gpoId: premier.id } });
    if (!has) await prisma.gpoMembership.create({ data: { accountId: a.id, gpoId: premier.id, tier: "Tier 2", effectiveFrom: day("2025-01-01"), source: "gpo-feed", verifiedAt: day("2026-08-01") } });
  }
  await prisma.request.updateMany({ where: { accountNumber: "0001880967" }, data: { accountId: msk.id } });
  await prisma.opportunity.upsert({ where: { externalCrmId: "006DEV0000MSK01" }, create: { accountId: msk.id, name: "MSK — Hernia & Endomechanical conversion FY27", stage: "Proposal", ownerUserId: rep.id, closeDate: day("2026-12-15"), amount: "450000", currency: "USD", externalCrmId: "006DEV0000MSK01" }, update: {} });

  // Products we price in the demo
  // NONB12STF (VersaOne bladeless, non-optical 12 × 100) is the evidence-based cross for the Ethicon B12LTH line the
  // e2e fixture prices (CW-DBG-0002); its demo list/cost mirror ONB12STF's — fixtures, not company figures.
  const skus = ["PPM1106X3", "PPM1510X3", "PPM4530", "PPDS12", "PPDS15", "PPDS1510", "PPDS2015", "PCO9X", "PCO2015X", "PCO2520X", "ABSTACK30X", "174006", "SIG60AMT", "SIG45AMT", "EGIA60AMT", "ONB12STF", "ONB5STF", "NONB12STF"];
  // Every SKU the demo prices is ensured to exist: the curated sheets carry most of them, but the demo
  // must stand on its own where they are absent (CI, a fresh clone, a customer deployment before its
  // catalog is loaded). Descriptions here are only a fallback — `create` never overwrites a real row.
  const ensure: Record<string, [string, string]> = {
    PPM1106X3: ["Parietene™ Macroporous Mesh 11 x 6 cm", "Synthetic Mesh"], PPM1510X3: ["Parietene™ Macroporous Mesh 15 x 10 cm", "Synthetic Mesh"], PPM4530: ["Parietene™ Macroporous Mesh 45 x 30 cm", "Synthetic Mesh"],
    PPDS12: ["Mesh Parietene DS Round 12 cm x 1", "Synthetic Mesh"], PPDS15: ["Mesh Parietene DS Round 15 cm x 1", "Synthetic Mesh"], PPDS1510: ["Mesh Parietene DS 15 x 10 cm x 1", "Synthetic Mesh"], PPDS2015: ["Mesh Parietene DS 20 x 15 cm x 1", "Synthetic Mesh"],
    PCO9X: ["Parietex — Optimized Composite Mesh, Skirted Polyester Mesh with Absorbable Collagen Film, 9 cm", "Hernia Mesh"], PCO2015X: ["Parietex — Optimized Composite Mesh, Skirted, 20 x 15 cm", "Hernia Mesh"], PCO2520X: ["Parietex — Optimized Composite Mesh, Polyester with Absorbable Collagen Film, 25 x 20 cm", "Hernia Mesh"],
    "174006": ["ProTack — Fixation Device", "Fixation"], ABSTACK30X: ["AbsorbaTack™ Fixation Device, 5 mm, single use, 30 tacks", "Fixation"],
    SIG60AMT: ["Signia™ 60 mm Articulating Medium/Thick Reload with Tri-Staple™ Technology", "Surgical Stapling Products"], SIG45AMT: ["Signia™ 45 mm Articulating Medium/Thick Reload with Tri-Staple™ Technology", "Surgical Stapling Products"], EGIA60AMT: ["Endo GIA™ 60 mm Articulating Medium/Thick SULU with Tri-Staple Technology", "Surgical Stapling Products"],
    ONB12STF: ["VersaOne™ Optical Trocar with Fixation Cannula; 12 mm x 100 mm", "Trocar Products"], ONB5STF: ["VersaOne™ Optical Trocar with Fixation Cannula; 5 mm x 100 mm", "Trocar Products"],
    NONB12STF: ["VersaOne™ Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", "Trocar Products"],
  };
  for (const [sku, [description, category]] of Object.entries(ensure)) await prisma.ownProduct.upsert({ where: { companyId_sku: { companyId: company.id, sku } }, create: { companyId: company.id, sku, description, category }, update: {} });
  const products = await prisma.ownProduct.findMany({ where: { companyId: company.id, sku: { in: skus } }, include: { costs: true } });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  // Standard costs by plant (Juarez) with a global fallback; list prices where the legacy report had none.
  const listAndCost: Record<string, [string, string]> = { PPM1106X3: ["63.61", "18.40"], PPM1510X3: ["99.74", "27.90"], PPM4530: ["590.36", "162.00"], PPDS12: ["512.00", "155.00"], PPDS15: ["640.00", "190.00"], PPDS1510: ["699.58", "205.00"], PPDS2015: ["1122.25", "318.00"], PCO9X: ["486.00", "148.00"], PCO2015X: ["812.00", "241.00"], PCO2520X: ["1015.00", "296.00"], ABSTACK30X: ["794.21", "212.00"], "174006": ["655.00", "171.00"], SIG60AMT: ["1240.00", "388.00"], SIG45AMT: ["1180.00", "366.00"], EGIA60AMT: ["1195.00", "372.00"], ONB12STF: ["112.00", "31.00"], ONB5STF: ["98.00", "27.00"], NONB12STF: ["112.00", "31.00"] /* demo values mirroring ONB12STF */ };
  for (const [sku, [list, cost]] of Object.entries(listAndCost)) {
    const p = bySku.get(sku);
    if (!p) continue;
    await prisma.ownProduct.update({ where: { id: p.id }, data: { listPrice: p.listPrice ?? list, cogs: p.cogs ?? cost } });
    if (!p.costs.some((c) => c.plant === "Juarez")) await prisma.standardCost.create({ data: { productId: p.id, plant: "Juarez", currency: "USD", cost, effectiveFrom: day("2026-01-01"), source: "erp" } });
    if (!p.costs.some((c) => !c.plant && !c.region)) await prisma.standardCost.create({ data: { productId: p.id, currency: "USD", cost: (Number(cost) * 1.04).toFixed(2), effectiveFrom: day("2026-01-01"), source: "erp" } });
  }

  // GPO Tier 2 contract (24 % off list) covering mesh + stapling; a LOCAL MSK override on two mesh SKUs; volume tiers on a stapler reload.
  const gpoC = await prisma.contract.upsert({ where: { contractNumber: "PREM-SURG-2025-T2" }, create: { contractNumber: "PREM-SURG-2025-T2", name: "Premier Surgical Tier 2", type: "GPO", status: "ACTIVE", gpoId: premier.id, tier: "Tier 2", currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: day("2027-12-31"), sourceSystem: "import", priceProtectionJson: JSON.stringify({ kind: "MAX_ANNUAL_PCT", maxAnnualPct: 0.03 }), renewalJson: JSON.stringify({ kind: "NEGOTIATED", termMonths: 36, noticeDays: 90 }) }, update: {} });
  const local = await prisma.contract.upsert({ where: { contractNumber: "MSK-LOCAL-2026" }, create: { contractNumber: "MSK-LOCAL-2026", name: "MSK local mesh agreement", type: "LOCAL", status: "ACTIVE", accountId: msk.id, currency: "USD", effectiveFrom: day("2026-03-01"), effectiveTo: day("2027-02-28"), sourceSystem: "crosswalk", committedValue: "60000", renewalJson: JSON.stringify({ kind: "AUTO", termMonths: 12, noticeDays: 60, increasePct: 0.02 }) }, update: {} });
  // GPO entries: ensure one per SKU (banded for the stapler reloads), idempotently.
  for (const [sku, [list]] of Object.entries(listAndCost)) {
      const p = bySku.get(sku); if (!p) continue;
      const have = await prisma.priceEntry.findMany({ where: { contractId: gpoC.id, productId: p.id } });
      const banded = sku === "SIG60AMT" || sku === "EGIA60AMT";
      if (have.length && (!banded || have.some((e) => e.minQty !== null))) continue;
      if (have.length) await prisma.priceEntry.deleteMany({ where: { id: { in: have.map((e) => e.id) } } });
      if (banded) {
        for (const [min, max, price, name] of [["0", "999", (Number(list) * 0.78).toFixed(2), "0–999"], ["1000", "4999", (Number(list) * 0.72).toFixed(2), "1,000–4,999"], ["5000", null, (Number(list) * 0.66).toFixed(2), "5,000+"]] as [string, string | null, string, string][])
          await prisma.priceEntry.create({ data: { contractId: gpoC.id, gpoId: premier.id, productId: p.id, productFamily: p.category, price, currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: day("2027-12-31"), tier: "Tier 2", minQty: min, maxQty: max, volumeTierName: name, source: "import" } });
      } else await prisma.priceEntry.create({ data: { contractId: gpoC.id, gpoId: premier.id, productId: p.id, productFamily: p.category, price: (Number(list) * 0.76).toFixed(2), currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: day("2027-12-31"), tier: "Tier 2", source: "import" } });
  }
  if (!(await prisma.contractScope.count({ where: { contractId: gpoC.id } }))) {
    await prisma.contractScope.createMany({ data: [{ contractId: gpoC.id, productFamily: "Synthetic Mesh" }, { contractId: gpoC.id, productFamily: "Hernia Mesh" }, { contractId: gpoC.id, productFamily: "Surgical Stapling Products" }, { contractId: gpoC.id, productFamily: "Fixation" }, { contractId: gpoC.id, productFamily: "Trocar Products" }] });
    await prisma.rebateSchedule.create({ data: { contractId: gpoC.id, type: "VOLUME", basis: "VALUE", tiersJson: JSON.stringify([{ threshold: 250000, rebatePct: 0.02 }, { threshold: 500000, rebatePct: 0.035 }]), periodMonths: 12 } });
  }
  if (!(await prisma.priceEntry.count({ where: { contractId: local.id } }))) {
    for (const [sku, price] of [["PPM1510X3", "72.50"], ["PPDS2015", "798.00"]]) {
      const p = bySku.get(sku);
      if (!p) { console.warn(`Demo: ${sku} is not in the catalog; skipping its local price entry.`); continue; }
      await prisma.priceEntry.create({ data: { contractId: local.id, accountId: msk.id, productId: p.id, productFamily: p.category, price, currency: "USD", effectiveFrom: day("2026-03-01"), effectiveTo: day("2027-02-28"), source: "manual" } });
    }
    await prisma.contractCommitment.create({ data: { contractId: local.id, productFamily: "Synthetic Mesh", committedValue: "60000", periodStart: day("2026-03-01"), periodEnd: day("2027-02-28") } });
    await prisma.bundleTerm.create({ data: { contractId: local.id, name: "Stapling award unlocks 5% on mesh", description: "If MSK awards ≥ 200 stapler reloads/yr, mesh lines get a further 5% off.", conditionJson: JSON.stringify({ productFamily: "Surgical Stapling Products", minUnits: 200 }), benefitJson: JSON.stringify({ productFamily: "Synthetic Mesh", pricePct: -0.05 }) } });
    // Some purchases against the local contract so compliance has data
    for (const [sku, qty, price, m] of [["PPM1510X3", "40", "72.50", 5], ["PPM1510X3", "35", "72.50", 3], ["PPDS2015", "12", "798.00", 4], ["PPDS2015", "9", "798.00", 1]] as [string, string, string, number][]) {
      const p = bySku.get(sku);
      if (!p) continue;
      await prisma.purchaseRecord.create({ data: { accountId: msk.id, productId: p.id, sku, quantity: qty, netPrice: price, currency: "USD", invoiceDate: monthsAgo(m), contractId: local.id, source: "import", externalId: `INV-${sku}-${m}` } });
    }
  }

  // Competitor price observations at three hospitals; one six months old; one anecdotal.
  if (!(await prisma.competitorPriceObservation.count())) {
    const obs: [string, string, string, string, number, string, string | null][] = [
      // competitor, sku, price, source, monthsAgo, description, accountNumber
      ["BD - Bard", "1190500", "1412.00", "CUSTOMER_INVOICE", 1, "Phasix 25.4 x 30.5", "0002000101"],
      ["BD - Bard", "1190500", "1465.00", "CUSTOMER_PO", 6, "Phasix 25.4 x 30.5", "0002000102"],
      ["BD - Bard", "1190500", "1380.00", "REP_OBSERVED", 2, "Phasix 25.4 x 30.5", "0002000103"],
      ["BD - Bard", "1190300", "745.00", "CUSTOMER_INVOICE", 1, "Phasix 15.2 x 20.3", "0002000101"],
      ["BD - Bard", "1190820", "455.00", "CUSTOMER_BID_FILE", 2, "Phasix 8 x 20", "0001880967"],
      ["BD - Bard", "1190816", "398.00", "CUSTOMER_INVOICE", 6, "Phasix 8 x 16", "0002000102"],
      ["BD - Bard", "1202025", "1690.00", "GPO_CONTRACT_FILE", 3, "Phasix ST 20 x 25", null],
      ["BD - Bard", "1201520", "1210.00", "GPO_CONTRACT_FILE", 3, "Phasix ST 15 x 20", null],
      ["BD - Bard", "1200710", "610.00", "GPO_CONTRACT_FILE", 3, "Phasix ST 7 x 10", null],
      ["BD - Bard", "112660", "212.00", "CUSTOMER_INVOICE", 1, "Bard Mesh 26 x 36", "0002000101"],
      ["BD - Bard", "112680", "88.00", "CUSTOMER_INVOICE", 1, "Bard Mesh 7.6 x 15", "0002000101"],
      ["BD - Bard", "112650", "62.00", "REP_OBSERVED", 4, "Bard Mesh 5 x 10", "0002000103"],
      ["BD - Bard", "113700", "96.00", "ANECDOTAL", 9, "Bard Mesh pre-shaped", null],
      ["W.L. Gore", "1DLMC03", "1180.00", "CUSTOMER_INVOICE", 2, "DUALMESH 10 x 15", "0002000102"],
      ["W.L. Gore", "1DLMC05", "820.00", "CUSTOMER_PO", 2, "DUALMESH 7.5 x 10", "0002000102"],
      ["W.L. Gore", "1410015010", "640.00", "CUSTOMER_INVOICE", 1, "Soft Tissue Patch 10 x 15", "0002000101"],
      ["Ethicon", "SPMII", "78.00", "CUSTOMER_INVOICE", 1, "Prolene soft mesh", "0002000101"],
      ["Ethicon", "SPMXXL", "410.00", "CUSTOMER_INVOICE", 1, "Prolene soft mesh XXL", "0002000101"],
      ["Ethicon", "UPA31015", "165.00", "CUSTOMER_BID_FILE", 2, "Ultrapro Advanced", "0001880967"],
    ];
    for (const [comp, sku, price, source, m, desc, accNum] of obs) {
      const acc = accNum ? await prisma.account.findUnique({ where: { accountNumber: accNum } }) : null;
      await recordObservation(admin.id, { competitorName: comp, competitorSku: sku, price, currency: "USD", accountId: acc?.id ?? null, gpoId: premier.id, region: "US-East", observedAt: monthsAgo(m), sourceType: source, sourceRef: `demo ${desc}`, notes: `Demo fixture — ${desc}` });
    }
    console.log(`Competitor price observations: ${obs.length}`);
  }
  await prisma.exchangeRate.upsert({ where: { fromCurrency_toCurrency_asOf_source: { fromCurrency: "EUR", toCurrency: "USD", asOf: day("2026-09-01"), source: "manual" } }, create: { fromCurrency: "EUR", toCurrency: "USD", rate: "1.0850", asOf: day("2026-09-01"), source: "manual" }, update: {} });
  await audit({ actorUserId: admin.id, entityType: "Seed", entityId: "enterprise", action: "DEMO_SEEDED" });
  console.log("Demo commercial data ready (MSK, Premier Tier 2, local override, 3-hospital price intelligence).");
  void normalizeCfn;
}

async function main() {
  await backfill();
  if (demo) await demoData();
}
main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

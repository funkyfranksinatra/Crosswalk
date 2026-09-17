/**
 * Enterprise commercial engine checks — pure functions, no database.
 * Run: npm run check:enterprise   (CI runs it on every push)
 *
 * Covers: money, waterfall resolution (precedence, dates, GPO vs local, currency,
 * volume bands), cost selection, rebates, bundles, competitor-price decay and
 * basis, recommendation strategies, discount authority, approval rules, RBAC.
 */
import assert from "node:assert/strict";
import { Decimal, D, money, marginPct, discountPct, priceForMargin, round, sum, times } from "../src/lib/money";
import { resolveFromInputs, pickEntry, type ContractInput, type EntryInput } from "../src/lib/contracts/resolve";
import { resolveCostFromInputs } from "../src/lib/catalog/cost";
import { effectiveNet, parseTiers, tierReached } from "../src/lib/contracts/rebates";
import { conditionMet, applyBenefit, parseBundle } from "../src/lib/contracts/bundles";
import { protectedCeiling } from "../src/lib/contracts/clauses";
import { summarize, weigh, type ObservationInput } from "../src/lib/intelligence/summarize";
import { recommend, floorFor, authorityForDiscount, approvalRequirements, economicsAt } from "../src/lib/pricing/recommend";
import { DEFAULT_POLICY, type Policy } from "../src/lib/pricing/policy-model";
import { permissionsFor, satisfiesAuthority, highestAuthority } from "../src/lib/auth/permissions";
import { rollup, type EconLine } from "../src/lib/proposals/economics";
import { requiredRoleFor, proposalStatusFrom, canFinalize } from "../src/lib/approvals/rules";

import { test, report } from "./lib/harness";
const d = (v: string | number) => new Decimal(v);
const day = (s: string) => new Date(s + "T00:00:00Z");

// ---- Money ---------------------------------------------------------------------
test("money is decimal: 0.1 + 0.2 = 0.3 and 63.61 × 6 = 381.66 exactly", () => {
  assert.equal(sum(["0.1", "0.2"]).toString(), "0.3");
  assert.equal(times("63.61", 6)!.toString(), "381.66");
  assert.equal(marginPct("100", "55")!.toString(), "0.45");
  assert.equal(discountPct("760", "1000")!.toString(), "0.24");
  assert.equal(priceForMargin("55", "0.45")!.toFixed(2), "100.00");
  assert.equal(round(d("2.345"), "USD").toString(), "2.34"); // banker's rounding
  assert.equal(round(d("2.355"), "USD").toString(), "2.36");
  assert.equal(money(null), null);
  assert.equal(money(NaN), null);
});

// ---- Waterfall -------------------------------------------------------------------
const P = { id: "p1", sku: "SIG60AMT", family: "Surgical Stapling Products", listPrice: "1000", currency: "USD" };
const entry = (over: Partial<EntryInput>): EntryInput => ({ id: "e", productId: "p1", price: "0", currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: null, tier: null, minQty: null, maxQty: null, volumeTierName: null, status: "ACTIVE", approvalState: "APPROVED", ...over });
const contract = (over: Partial<ContractInput>): ContractInput => ({ id: "c", contractNumber: "C-1", name: "c", type: "GPO", status: "ACTIVE", accountId: null, parentAccountId: null, gpoId: "gpoA", tier: "Tier 2", currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: null, precedence: 0, scopes: [], entries: [], ...over });
const acct = { id: "a1", parentAccountId: "idn1", currency: "USD" };
const memberA = [{ gpoId: "gpoA", tier: "Tier 2", effectiveFrom: day("2024-01-01"), effectiveTo: null }];
const gpo = contract({ id: "gpo", contractNumber: "GPO-A-T2", entries: [entry({ id: "eg", price: "760" })] });
const local = contract({ id: "loc", contractNumber: "MSK-LOCAL", type: "LOCAL", gpoId: null, tier: null, accountId: "a1", entries: [entry({ id: "el", price: "725" })] });

test("waterfall: list → GPO tier 2 → local account contract, local wins with full explanation", () => {
  const r = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo, local], asOf: day("2026-09-01"), quantity: d(10) });
  assert.equal(r.price!.toString(), "725");
  assert.equal(r.source, "LOCAL");
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps.map((s) => `${s.level}:${s.price}`), ["LIST:1000", "GPO:760", "LOCAL:725"]);
  assert.match(r.explanation, /LOCAL \(MSK-LOCAL\) applies at USD 725/);
  assert.match(r.explanation, /GPO GPO-A-T2: 760 — outranked/);
});
test("waterfall: no local contract → GPO applies; wrong tier or non-member → list", () => {
  assert.equal(resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo], asOf: day("2026-09-01"), quantity: d(1) }).source, "GPO");
  const t3 = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: [{ ...memberA[0], tier: "Tier 3" }], contracts: [gpo], asOf: day("2026-09-01"), quantity: d(1) });
  assert.equal(t3.source, "LIST");
  assert.match(t3.steps.find((s) => s.level === "GPO")!.reason, /tier/);
  const nonMember = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: [], contracts: [gpo], asOf: day("2026-09-01"), quantity: d(1) });
  assert.match(nonMember.steps.find((s) => s.level === "GPO")!.reason, /not an active member/);
});
test("waterfall: expired contract and future membership are ignored on the as-of date", () => {
  const expired = contract({ ...local, effectiveTo: day("2026-06-30") });
  const r = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo, expired], asOf: day("2026-09-01"), quantity: d(1) });
  assert.equal(r.source, "GPO");
  const beforeMembership = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: [{ ...memberA[0], effectiveFrom: day("2027-01-01") }], contracts: [gpo], asOf: day("2026-09-01"), quantity: d(1) });
  assert.equal(beforeMembership.source, "LIST");
  // On a date inside the local contract's life it still applies — history is reproducible.
  assert.equal(resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo, expired], asOf: day("2026-03-01"), quantity: d(1) }).source, "LOCAL");
});
test("waterfall: IDN contract applies through the parent; explicit precedence overrides natural order", () => {
  const idn = contract({ id: "idn", contractNumber: "IDN-1", type: "IDN", gpoId: null, tier: null, parentAccountId: "idn1", entries: [entry({ id: "ei", price: "740" })] });
  assert.equal(resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo, idn], asOf: day("2026-09-01"), quantity: d(1) }).source, "IDN");
  const gpoWins = { ...gpo, precedence: 5 };
  const r = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpoWins, local], asOf: day("2026-09-01"), quantity: d(1) });
  assert.equal(r.source, "GPO");
});
test("waterfall: currency mismatch is never converted silently; scope excludes other families", () => {
  const eur = contract({ ...local, id: "eur", contractNumber: "EUR", currency: "EUR", entries: [entry({ id: "ee", price: "600", currency: "EUR" })] });
  const r = resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo, eur], asOf: day("2026-09-01"), quantity: d(1) });
  assert.equal(r.source, "GPO");
  assert.match(r.steps.find((s) => s.contractNumber === "EUR")!.reason, /currency/);
  const scoped = contract({ ...local, id: "sc", scopes: [{ productFamily: "Hernia Mesh", productId: null }] });
  assert.equal(resolveFromInputs({ product: P, listEntries: [], account: acct, memberships: memberA, contracts: [gpo, scoped], asOf: day("2026-09-01"), quantity: d(1) }).source, "GPO");
});
test("volume bands: 0–999 → 100, 1000–4999 → 92, 5000+ → 85", () => {
  const es = [entry({ id: "b1", price: "100", minQty: "0", maxQty: "999", volumeTierName: "T1" }), entry({ id: "b2", price: "92", minQty: "1000", maxQty: "4999", volumeTierName: "T2" }), entry({ id: "b3", price: "85", minQty: "5000", volumeTierName: "T3" })];
  assert.equal(pickEntry(es, "p1", day("2026-01-01"), d(500), "USD").entry!.price, "100");
  assert.equal(pickEntry(es, "p1", day("2026-01-01"), d(1000), "USD").entry!.price, "92");
  assert.equal(pickEntry(es, "p1", day("2026-01-01"), d(12000), "USD").entry!.price, "85");
});
test("list falls back to a price-list entry when the catalog list price is missing", () => {
  const r = resolveFromInputs({ product: { ...P, listPrice: null }, listEntries: [entry({ id: "pl", price: "990", pricebookName: "HOSPITAL LIST PRICE" })], account: acct, memberships: [], contracts: [], asOf: day("2026-09-01"), quantity: d(1) });
  assert.equal(r.price!.toString(), "990");
  assert.match(r.steps[0].reason, /HOSPITAL LIST PRICE/);
});

// ---- Cost -------------------------------------------------------------------------
test("cost: plant beats region beats global; other plant never applies; legacy COGS last", () => {
  const costs = [
    { id: "g", plant: null, region: null, currency: "USD", costType: "STANDARD", cost: "50", effectiveFrom: day("2025-01-01"), effectiveTo: null, source: "erp" },
    { id: "r", plant: null, region: "US-East", currency: "USD", costType: "STANDARD", cost: "48", effectiveFrom: day("2025-01-01"), effectiveTo: null, source: "erp" },
    { id: "p", plant: "Juarez", region: null, currency: "USD", costType: "STANDARD", cost: "45", effectiveFrom: day("2025-01-01"), effectiveTo: null, source: "erp" },
  ];
  const base = { productId: "p1", fallbackCogs: "60", fallbackCurrency: "USD", costs, asOf: day("2026-01-01"), currency: "USD" };
  assert.equal(resolveCostFromInputs({ ...base, region: "US-East", plant: "Juarez" }).cost!.toString(), "45");
  assert.equal(resolveCostFromInputs({ ...base, region: "US-East", plant: null }).cost!.toString(), "48");
  assert.equal(resolveCostFromInputs({ ...base, region: "EU", plant: "Other" }).cost!.toString(), "50");
  assert.equal(resolveCostFromInputs({ ...base, costs: [], region: null, plant: null }).basis.kind, "LEGACY_COGS");
  assert.equal(resolveCostFromInputs({ ...base, costs: [], fallbackCurrency: "EUR", region: null, plant: null }).cost, null);
});

// ---- Rebates / bundles / clauses ---------------------------------------------------
test("rebate tiers: highest threshold met applies; effective net separates from invoice", () => {
  const tiers = parseTiers(JSON.stringify([{ threshold: 5000, rebatePct: 0.05 }, { threshold: 1000, rebatePct: 0.02 }]));
  assert.equal(tierReached(tiers, d(999)).tier, null);
  assert.equal(tierReached(tiers, d(1000)).tier!.rebatePct, 0.02);
  assert.equal(tierReached(tiers, d(6000)).tier!.rebatePct, 0.05);
  const r = effectiveNet({ invoiceSpend: d(100000), units: d(1200), rebate: { id: "r", type: "VOLUME", basis: "UNITS", productFamily: null, tiersJson: JSON.stringify(tiers), periodMonths: 12 }, measured: d(1200) });
  assert.equal(r.rebate.toString(), "2000");
  assert.equal(r.net.toString(), "98000");
  assert.equal(r.toNext!.toString(), "3800");
});
test("bundle: stapler discount contingent on trocar volume", () => {
  const b = parseBundle(JSON.stringify({ productFamily: "Trocar Products", minUnits: 5000 }), JSON.stringify({ productFamily: "Surgical Stapling Products", pricePct: -0.05 }))!;
  const lines = [{ productId: "t", productFamily: "Trocar Products", quantity: d(6000), extended: d(60000), included: true }, { productId: "s", productFamily: "Surgical Stapling Products", quantity: d(100), extended: d(50000), included: true }];
  assert.equal(conditionMet(lines, b.condition).met, true);
  assert.equal(conditionMet([{ ...lines[0], quantity: d(100) }], b.condition).met, false);
  assert.equal(applyBenefit(d(500), b.benefit).toString(), "475");
});
test("price protection: fixed years caps at base, max annual % compounds", () => {
  assert.equal(protectedCeiling(d(100), day("2025-01-01"), day("2026-06-01"), { kind: "FIXED_YEARS", years: 2 })!.toString(), "100");
  assert.equal(protectedCeiling(d(100), day("2025-01-01"), day("2027-06-01"), { kind: "FIXED_YEARS", years: 2 }), null);
  assert.equal(protectedCeiling(d(100), day("2024-01-01"), day("2026-06-01"), { kind: "MAX_ANNUAL_PCT", maxAnnualPct: 0.03 })!.toFixed(2), "106.09");
});

// ---- Competitive intelligence ------------------------------------------------------
const obs = (over: Partial<ObservationInput>): ObservationInput => ({ id: "o", competitorSku: "1190500", price: "450", currency: "USD", uom: "EA", accountId: null, gpoId: null, region: null, observedAt: day("2026-08-01"), sourceType: "CUSTOMER_INVOICE", rawConfidence: 1, verificationStatus: "VERIFIED", ...over });
const ctx = { accountId: "hospB", gpoId: "gpoA", region: "US-East", asOf: day("2026-09-01"), currency: "USD" };
test("intelligence: age decays confidence by source half-life, raw confidence untouched", () => {
  const fresh = weigh(obs({}), ctx);
  const sixMonths = weigh(obs({ observedAt: day("2026-03-01") }), ctx);
  const anecdotal = weigh(obs({ sourceType: "ANECDOTAL", rawConfidence: 0.35, observedAt: day("2026-03-01"), verificationStatus: "UNVERIFIED" }), ctx);
  assert.ok(fresh.currentConfidence > sixMonths.currentConfidence);
  assert.ok(sixMonths.currentConfidence > 0.6, `invoice 6 months old still strong: ${sixMonths.currentConfidence}`);
  assert.ok(anecdotal.currentConfidence < 0.15, `anecdotal 6 months old weak: ${anecdotal.currentConfidence}`);
  assert.equal(sixMonths.rawConfidence, 1);
});
test("intelligence: known account price beats market; hospital A's invoice informs hospital B as a market estimate", () => {
  const rows = [obs({ id: "a", accountId: "hospA", price: "453.85" }), obs({ id: "c", accountId: "hospC", price: "470", observedAt: day("2026-06-01"), sourceType: "CUSTOMER_PO", rawConfidence: 0.95 }), obs({ id: "d", accountId: "hospD", price: "440", observedAt: day("2026-03-01"), sourceType: "REP_OBSERVED", rawConfidence: 0.55, verificationStatus: "UNVERIFIED" })];
  const market = summarize(rows, ctx);
  assert.equal(market.basis, "MARKET_ESTIMATE");
  assert.equal(market.countUsed, 3);
  assert.ok(market.reference!.gte(440) && market.reference!.lte(470));
  const known = summarize([...rows, obs({ id: "b", accountId: "hospB", price: "455" })], ctx);
  assert.equal(known.basis, "KNOWN_ACCOUNT");
  assert.equal(known.reference!.toString(), "455");
  const weak = summarize([obs({ id: "w", sourceType: "ANECDOTAL", rawConfidence: 0.35, observedAt: day("2026-03-01"), verificationStatus: "UNVERIFIED" })], ctx);
  assert.equal(weak.basis, "WEAK");
  assert.equal(summarize([obs({ id: "dead", sourceType: "ANECDOTAL", rawConfidence: 0.35, observedAt: day("2024-09-01"), verificationStatus: "UNVERIFIED" })], ctx).basis, "NONE");
  assert.equal(summarize([obs({ currency: "EUR" })], ctx).basis, "NONE");
});

// ---- Recommendation ----------------------------------------------------------------
const policy: Policy = { id: "pol", productFamily: "Hernia Mesh", version: 1, status: "ACTIVE", ...DEFAULT_POLICY };
const base = { currency: "USD", quantity: d(100), listPrice: d(1000), contractPrice: d(760), contractSource: "GPO", cost: d(233.55), competitorPrice: d("453.85"), competitorConfidence: 0.9, competitorBasis: "KNOWN_ACCOUNT" as const, policy };
test("recommendation: undercut 2.5% → $442.50, margin 47.2%, above floor, needs manager (55.8% off list)", () => {
  const r = recommend({ ...base, strategy: "UNDERCUT_PCT", adjustmentPct: 0.025 });
  assert.equal(r.recommendedPrice!.toFixed(2), "442.50");
  assert.equal(r.marginPct!.times(100).toFixed(1), "47.2");
  assert.equal(r.floorPrice!.toFixed(2), "333.64"); // 233.55 / 0.7
  assert.equal(r.belowFloor, false);
  assert.equal(r.requiredAuthority, "PRICING_COMMITTEE"); // 55.75% off list exceeds director's 40%
  assert.match(r.explanation, /Recommend \$442\.50/);
  assert.match(r.explanation, /47\.2%/);
});
test("recommendation: MATCH uses the competitor; weak intelligence falls back to target margin; floor is never breached", () => {
  assert.equal(recommend({ ...base, strategy: "MATCH" }).recommendedPrice!.toFixed(2), "453.85");
  const weak = recommend({ ...base, strategy: "MATCH", competitorBasis: "WEAK", competitorConfidence: 0.2 });
  assert.equal(weak.recommendedPrice!.toFixed(2), "424.64"); // 233.55 / 0.55
  assert.match(weak.explanation, /too weak to anchor/);
  const deep = recommend({ ...base, strategy: "UNDERCUT_AMOUNT", adjustmentAmount: 200 });
  assert.equal(deep.recommendedPrice!.toFixed(2), "333.64");
  assert.match(deep.explanation, /raised to the floor/);
});
test("recommendation: preserve contract, hold premium, penetration", () => {
  assert.equal(recommend({ ...base, strategy: "PRESERVE_CONTRACT" }).recommendedPrice!.toFixed(2), "760.00");
  const prem = recommend({ ...base, strategy: "HOLD_PREMIUM", adjustmentPct: 0.05, justification: "barrier construction" });
  assert.equal(prem.recommendedPrice!.toFixed(2), "476.54");
  assert.match(prem.explanation, /barrier construction/);
  assert.equal(recommend({ ...base, strategy: "PENETRATION" }).recommendedPrice!.toFixed(2), "340.32");
});
test("authority: discount bands map to the lowest role that covers them; below floor → committee via rules", () => {
  assert.equal(authorityForDiscount(policy, d(0.1)), null);
  assert.equal(authorityForDiscount(policy, d(0.2)), "REGIONAL_MANAGER");
  assert.equal(authorityForDiscount(policy, d(0.28)), "CONTRACTING_MANAGER");
  assert.equal(authorityForDiscount(policy, d(0.35)), "PRICING_DIRECTOR");
  assert.equal(authorityForDiscount(policy, d(0.5)), "PRICING_COMMITTEE");
  const req = approvalRequirements(policy, { belowFloor: true, belowTargetMargin: true, marginPct: d(0.2), discountFromList: d(0.1), discountFromContract: null, dealValue: null, lineValue: d(1000), strategicAccount: false, contractMonths: null });
  assert.equal(req.role, "PRICING_COMMITTEE");
  const econ = economicsAt(d(300), { ...base }, floorFor(policy, base.cost, base.listPrice));
  assert.equal(econ.belowFloor, true);
  assert.equal(econ.requiredAuthority, "PRICING_COMMITTEE");
});

// ---- Deal economics ------------------------------------------------------------------
test("deal economics: blended margin, savings, share of wallet, per-family rollup", () => {
  const lines: EconLine[] = [
    { id: "1", included: true, family: "Hernia Mesh", quantity: d(100), proposedPrice: d(440), competitorPrice: d(450), listPrice: d(1000), contractPrice: d(760), cost: d(233.55), currency: "USD", approvalState: "NOT_REQUIRED" },
    { id: "2", included: true, family: "Surgical Stapling Products", quantity: d(50), proposedPrice: d(900), competitorPrice: d(950), listPrice: d(1200), contractPrice: null, cost: d(300), currency: "USD", approvalState: "PENDING" },
    { id: "3", included: false, family: "Trocar Products", quantity: d(10), proposedPrice: d(100), competitorPrice: d(90), listPrice: d(120), contractPrice: null, cost: d(40), currency: "USD", approvalState: "NOT_REQUIRED" },
    { id: "4", included: true, family: "Trocar Products", quantity: d(10), proposedPrice: null, competitorPrice: d(90), listPrice: d(120), contractPrice: null, cost: d(40), currency: "USD", approvalState: "NOT_REQUIRED" },
  ];
  const e = rollup(lines, "USD");
  assert.equal(e.revenue.toString(), "89000"); // 44000 + 45000
  assert.equal(e.grossProfit.toString(), "50645"); // (440-233.55)*100 + (900-300)*50
  assert.equal(e.blendedMarginPct!.toFixed(4), "0.5690");
  assert.equal(e.competitorSpend.toString(), "93400"); // 45000 + 47500 + unpriced line 4 (10 × 90)
  assert.equal(e.customerSavings.toString(), "3500"); // priced lines only: 45000+47500 − 89000
  assert.equal(e.linesProposed, 2);
  assert.equal(e.linesTotal, 3);
  assert.equal(e.shareOfWalletPct!.toFixed(4), "0.9904"); // 92500 / 93400
  assert.equal(e.byFamily.length, 2);
  assert.equal(e.approvalsPending, 1);
});

// ---- Approval routing / locking ------------------------------------------------------
test("approval: required role vs actor roles; proposal status derives from requests; export blocked while pending", () => {
  assert.equal(requiredRoleFor(policy, { discountFromList: d(0.2), belowFloor: false, marginPct: d(0.5), lineValue: d(1000), dealValue: d(1000), strategicAccount: false, contractMonths: null, discountFromContract: null }), "REGIONAL_MANAGER");
  assert.equal(proposalStatusFrom([{ status: "PENDING" }, { status: "APPROVED" }]), "PARTIALLY_APPROVED");
  assert.equal(proposalStatusFrom([{ status: "APPROVED" }, { status: "APPROVED" }]), "APPROVED");
  assert.equal(proposalStatusFrom([{ status: "REJECTED" }, { status: "APPROVED" }]), "REJECTED");
  assert.equal(proposalStatusFrom([{ status: "CHANGES_REQUESTED" }]), "CHANGES_REQUESTED");
  assert.equal(proposalStatusFrom([]), "APPROVED");
  assert.equal(canFinalize({ status: "APPROVED", lines: [{ included: true, approvalState: "APPROVED", proposedPrice: d(1) }] }).ok, true);
  assert.equal(canFinalize({ status: "SUBMITTED", lines: [{ included: true, approvalState: "PENDING", proposedPrice: d(1) }] }).ok, false);
  // An approved quote past its valid-through date cannot be exported, pushed or won; a WON deal is history and stays finalisable.
  assert.match(canFinalize({ status: "APPROVED", validThrough: new Date("2026-01-01"), asOf: new Date("2026-02-01"), lines: [{ included: true, approvalState: "APPROVED", proposedPrice: d(1) }] }).reason, /expired/);
  assert.equal(canFinalize({ status: "WON", validThrough: new Date("2026-01-01"), asOf: new Date("2026-02-01"), lines: [{ included: true, approvalState: "APPROVED", proposedPrice: d(1) }] }).ok, true);
  assert.equal(canFinalize({ status: "APPROVED", validThrough: new Date("2026-03-01"), asOf: new Date("2026-02-01"), lines: [{ included: true, approvalState: "APPROVED", proposedPrice: d(1) }] }).ok, true);
  assert.equal(canFinalize({ status: "DRAFT", lines: [{ included: true, approvalState: "NOT_REQUIRED", proposedPrice: null }] }).ok, false);
});

// ---- RBAC ----------------------------------------------------------------------------
test("RBAC: reps cannot see cost; directors approve below floor; authority ordering", () => {
  assert.equal(permissionsFor(["SALES_REP"]).has("view_cost"), false);
  assert.equal(permissionsFor(["SALES_REP"]).has("edit_proposed_pricing"), true);
  assert.equal(permissionsFor(["PRICING_DIRECTOR"]).has("approve_below_floor"), true);
  assert.equal(permissionsFor(["REGIONAL_MANAGER"]).has("approve_below_floor"), false);
  assert.equal(satisfiesAuthority(["REGIONAL_MANAGER"], "REGIONAL_MANAGER"), true);
  assert.equal(satisfiesAuthority(["REGIONAL_MANAGER"], "PRICING_DIRECTOR"), false);
  assert.equal(satisfiesAuthority(["ADMIN"], "PRICING_COMMITTEE"), true);
  assert.equal(highestAuthority(["SALES_REP", "PRICING_DIRECTOR", "FINANCE"]), "PRICING_DIRECTOR");
});

report();

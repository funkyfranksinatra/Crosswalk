/**
 * End-to-end commercial workflow against the database (the deal fixture from
 * docs/BUSINESS_RULES.md). Requires `prisma/seed.ts` and `prisma/seed-enterprise.ts`
 * to have run, plus network access to openFDA for the cross-reference step.
 *
 *   npx tsx scripts/test-enterprise.ts
 *
 * Scenario: MSK (Premier Tier 2, local mesh overrides) sends a competitor list with mesh,
 * a stapler reload and trocars. The rep imports it, cross-references it, creates a
 * proposal, prices a stapler line below floor and a mesh line deep, submits; a manager
 * cannot approve those lines; the director and the committee can; the proposal locks,
 * exports, pushes to CRM, is marked won, becomes a local contract, and conversion is
 * measured from purchases. Governance: a rep-proposed cross never reaches a rep until
 * published. Idempotent: prior test artefacts are removed first.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { getCompany } from "../src/lib/settings";
import { nextReference } from "../src/lib/requests";
import { parseIntake } from "../src/lib/excel/intake";
import { runRequest } from "../src/lib/pipeline/run";
import { permissionsFor } from "../src/lib/auth/permissions";
import { type Actor, AuthError } from "../src/lib/auth";
import { Decimal, money, round } from "../src/lib/money";
import { createFromRequest, setProposedPrice, setLineIncluded, refreshEconomics, createScenario, scenarioEconomics, applyScenario, newVersion, assertEditable } from "../src/lib/proposals/service";
import { submitForApproval, decide, finalizeCheck, queueFor } from "../src/lib/approvals/service";
import { recordOutcome } from "../src/lib/proposals/outcome";
import { loadPricingContext } from "../src/lib/contracts/context";
import { pushQuote, syncCrmAccounts, syncGpoMemberships, crmAdapter } from "../src/lib/integrations/sync";
import os from "node:os";
import { contractPerformance, proposalConversion } from "../src/lib/compliance";
import { winLoss, pricingEffectiveness, conversion, crossReferenceAccuracy } from "../src/lib/analytics";
import { proposeCross, setReview, publishVersion, approvedCross } from "../src/lib/xref/governance";
import { summaryFor } from "../src/lib/intelligence";
import { gatherHits, resolveCfn } from "../src/lib/pipeline/resolve";
import { adoptRecords, localHits } from "../src/lib/gudid/library";

let passed = 0; const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failures.push(`${name}\n    ${e instanceof Error ? e.message.replace(/\n/g, "\n    ") : String(e)}`); console.log(`  ✗ ${name}`); }
}
async function actor(email: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { roles: true } });
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}
const d = (v: unknown) => money(v as never)!;

async function cleanup() {
  const old = await prisma.request.findMany({ where: { sourceFileName: "e2e-fixture" } });
  for (const r of old) {
    const props = await prisma.proposal.findMany({ where: { requestId: r.id } });
    for (const p of props) {
      await prisma.purchaseRecord.deleteMany({ where: { proposalId: p.id } });
      await prisma.contract.deleteMany({ where: { externalId: p.id } });
      await prisma.competitorPriceObservation.deleteMany({ where: { proposalLineId: { in: (await prisma.proposalLine.findMany({ where: { proposalId: p.id }, select: { id: true } })).map((l) => l.id) } } });
      await prisma.matchDecision.deleteMany({ where: { proposalLineId: { in: (await prisma.proposalLine.findMany({ where: { proposalId: p.id }, select: { id: true } })).map((l) => l.id) } } });
    }
    await prisma.proposal.deleteMany({ where: { requestId: r.id } });
    await prisma.matchDecision.deleteMany({ where: { requestLineId: { in: (await prisma.requestLine.findMany({ where: { requestId: r.id }, select: { id: true } })).map((l) => l.id) } } });
    await prisma.request.delete({ where: { id: r.id } });
  }
  await prisma.proposal.deleteMany({ where: { reference: { contains: "-v" }, request: { sourceFileName: "e2e-fixture" } } });
  await prisma.crosswalkVersionEntry.deleteMany({ where: { competitorCodeNorm: "E2E-TEST-CODE" } });
  await prisma.knownCross.deleteMany({ where: { competitorCodeNorm: "E2E-TEST-CODE" } }); // whatever source/status the test left it in
  await prisma.externalRef.deleteMany({ where: { system: "dev", entityType: "Proposal" } });
  await prisma.externalRef.deleteMany({ where: { system: "file" } });
  await prisma.syncLog.deleteMany({ where: { system: "file" } });
  const fileAcc = await prisma.account.findUnique({ where: { accountNumber: "E2E-FILE-0001" } });
  if (fileAcc) { await prisma.gpoMembership.deleteMany({ where: { accountId: fileAcc.id } }); await prisma.account.delete({ where: { id: fileAcc.id } }); }
  await prisma.competitorProduct.deleteMany({ where: { cfnNorm: { in: ["E2E-LIB-9001", "E2ELIB9001"] } } });
  await prisma.gudidDevice.deleteMany({ where: { recordKey: { startsWith: "e2e-lib-" } } });
  // A real run since the last pass may have matched the fixture SKU: drop those candidates before the product.
  await prisma.matchCandidate.deleteMany({ where: { ownProduct: { sku: "E2E-OWN-7001", source: "gudid-import" } } });
  await prisma.ownProduct.deleteMany({ where: { sku: "E2E-OWN-7001", source: "gudid-import" } });
  await prisma.gudidImport.deleteMany({ where: { query: "E2E fixture" } });
}

async function main() {
  await cleanup();
  const rep = await actor("alex.rep@crosswalk.dev");
  const manager = await actor("maria.manager@crosswalk.dev");
  const director = await actor("dana.director@crosswalk.dev");
  const committee = await actor("committee@crosswalk.dev");
  const marketing = await actor("lee.marketing@crosswalk.dev");
  const company = await getCompany();
  const msk = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });

  // ---- 1. Import + cross-reference ------------------------------------------------------
  const file = path.resolve("data/reference/CrossReference_0001880967.xlsx");
  const intake = await parseIntake(fs.readFileSync(file));
  const extra = [{ rawCode: "GST60D", cfnNorm: "GST60D", quantity: 240 }, { rawCode: "B12LTH", cfnNorm: "B12LTH", quantity: 600 }, { rawCode: "2B5LT", cfnNorm: "2B5LT", quantity: 900 }];
  const request = await prisma.request.create({ data: { companyId: company.id, reference: await nextReference(), accountNumber: msk.accountNumber, accountName: msk.name, accountType: "Sold-To", accountId: msk.id, sourceFileName: "e2e-fixture", status: "queued", useLlm: false, lines: { create: [...intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity })), ...extra.map((l, i) => ({ lineNo: intake.lines.length + i + 1, ...l }))] } } });
  console.log(`Request ${request.reference}: ${intake.lines.length + extra.length} lines — running cross-reference (openFDA)…`);
  await runRequest(request.id);
  await step("cross-reference resolves the list and matches the stapler/trocar lines through the published crosswalk", async () => {
    const lines = await prisma.requestLine.findMany({ where: { requestId: request.id }, include: { candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } });
    const resolved = lines.filter((l) => l.resolutionStatus === "resolved").length;
    assert.ok(resolved >= 30, `resolved ${resolved}`);
    const stapler = lines.find((l) => l.cfnNorm === "GST60D")!;
    assert.equal(stapler.candidates[0]?.ownProduct.sku, "EGIA60AMT");
    assert.equal(lines.find((l) => l.cfnNorm === "B12LTH")!.candidates[0]?.ownProduct.sku, "ONB12STF");
  });

  // ---- 2. Proposal creation: waterfall, cost, intelligence, recommendation snapshots ----
  const proposal = await createFromRequest(rep, request.id, { accountId: msk.id, validDays: 45, objectives: "Win the hernia portfolio; protect stapling margin" });
  const lines = await prisma.proposalLine.findMany({ where: { proposalId: proposal.id }, orderBy: { lineNo: "asc" } });
  const by = (sku: string) => lines.find((l) => l.sku === sku)!;
  const byCode = (code: string) => lines.find((l) => l.competitorCode === code)!;
  await step("proposal pins the published crosswalk version and the policy versions it used", async () => {
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id }, include: { crosswalkVersion: true } });
    assert.equal(p.crosswalkVersion?.status, "PUBLISHED");
    assert.ok(Object.keys(JSON.parse(p.policyVersionsJson)).length >= 1);
    assert.equal(p.gpoNameSnapshot, "Premier · Tier 2");
  });
  await step("waterfall: local override beats GPO tier beats list, with explanation; volume tier applies to the stapler quantity", async () => {
    const ppm = by("PPM1510X3");
    assert.equal(ppm.contractPriceSource, "LOCAL");
    assert.equal(d(ppm.contractPrice).toFixed(2), "72.50");
    const wf = JSON.parse(ppm.waterfallJson!);
    assert.match(wf.explanation, /LOCAL \(MSK-LOCAL-2026\) applies/);
    assert.ok(wf.steps.some((s: { level: string; price: string | null }) => s.level === "GPO" && s.price !== null), "GPO step present but outranked");
    const ppm4530 = by("PPM4530");
    assert.equal(ppm4530.contractPriceSource, "GPO");
    assert.equal(d(ppm4530.contractPrice).toFixed(2), (590.36 * 0.76).toFixed(2));
    const reload = by("EGIA60AMT");
    assert.equal(reload.contractPriceSource, "GPO");
    const step = JSON.parse(reload.waterfallJson!).steps.find((s: { level: string }) => s.level === "GPO");
    assert.equal(step.volumeTier, "0–999"); // qty 240
  });
  await step("competitor intelligence: MSK's own bid file → KNOWN_ACCOUNT; three-hospital invoices → MARKET_ESTIMATE; 9-month anecdote → WEAK", async () => {
    assert.equal(byCode("1190820").competitorPriceBasis, "KNOWN_ACCOUNT");
    assert.equal(d(byCode("1190820").competitorPrice).toFixed(2), "455.00");
    assert.equal(byCode("1190500").competitorPriceBasis, "MARKET_ESTIMATE");
    assert.ok(byCode("1190500").competitorPriceConfidence! > 0.4);
    assert.equal(byCode("113700").competitorPriceBasis, "WEAK");
    const s = await summaryFor("1190500", { accountId: msk.id, gpoId: null, region: "US-East", asOf: new Date(), currency: "USD" });
    assert.equal(s.countUsed, 3);
  });
  await step("cost basis and recommendation are snapshotted and explainable on every priced line", async () => {
    const l = byCode("1190820");
    assert.equal(JSON.parse(l.costBasisJson!).kind, "STANDARD_COST");
    const rec = JSON.parse(l.recommendationJson!);
    assert.match(rec.explanation, /^Recommend \$/);
    assert.ok(d(l.proposedPrice).eq(d(l.recommendedPrice)));
    assert.ok(d(l.floorPrice).gt(0) && d(l.marginPct).gt(0));
  });
  await step("deal economics rollup exists with blended margin, savings and share of wallet", async () => {
    const e = await refreshEconomics(proposal.id);
    assert.ok(e.revenue.gt(0));
    assert.ok(e.blendedMarginPct!.gt(0.3), `blended margin ${e.blendedMarginPct}`);
    assert.ok(e.byFamily.length >= 2);
    assert.ok(e.shareOfWalletPct !== null);
  });

  // ---- 3. Rep prices the deal: one stapler line below floor, mesh deep, trocar within authority -------
  const reload = by("EGIA60AMT");
  const meshLine = by("PPM4530");
  const trocar = by("ONB12STF");
  await step("pricing a stapler line below floor requires the pricing committee; a deep mesh discount needs the director; a 10% trocar discount is within rep authority; every change is audited", async () => {
    const belowFloor = d(reload.floorPrice).times(0.9);
    const l1 = await setProposedPrice(rep, reload.id, belowFloor, "customer demands parity with Ethicon GST pricing");
    assert.equal(l1.requiredAuthority, "PRICING_COMMITTEE");
    assert.equal(l1.approvalState, "REQUIRED");
    // Authority is incremental: measured below the price the customer already pays under contract.
    const l2 = await setProposedPrice(rep, meshLine.id, d(meshLine.contractPrice).times(0.66), "win the mesh volume");
    assert.equal(l2.requiredAuthority, "PRICING_DIRECTOR"); // 34% below the GPO price
    const l3 = await setProposedPrice(rep, trocar.id, d(trocar.contractPrice).times(0.95));
    assert.equal(l3.requiredAuthority, null); // 5% below contract: within rep authority
    const events = await prisma.auditEvent.findMany({ where: { entityType: "ProposalLine", entityId: reload.id, action: "PRICE_CHANGED" } });
    assert.equal(events.length, 1);
    const ctx = JSON.parse(events[0].contextJson!);
    assert.ok(ctx.floorPrice && ctx.recommendedPrice && ctx.marginPct && ctx.policyId);
    const e = await refreshEconomics(proposal.id);
    assert.ok(e.blendedMarginPct!.gt(0.3), "portfolio stays highly profitable despite the below-floor line");
  });

  // ---- 4. Scenarios never touch the proposal ------------------------------------------------
  await step("what-if scenario changes the numbers without touching the proposal's prices", async () => {
    const s = await createScenario(rep, proposal.id, "AGGRESSIVE");
    const se = await scenarioEconomics(s.id);
    const pe = await refreshEconomics(proposal.id);
    assert.notEqual(se.economics.revenue, pe.revenue.toString());
    const l = await prisma.proposalLine.findUniqueOrThrow({ where: { id: meshLine.id } });
    assert.ok(d(l.proposedPrice).eq(round(d(meshLine.contractPrice).times(0.66))), "stored price is the entered price rounded to cents");
  });

  // ---- 5. Submit → route → decide ----------------------------------------------------------
  await step("submission routes below-authority lines, locks the proposal, and blocks export", async () => {
    // A rep excludes lines the engine could not price (no list/cost/competitor data) rather than quoting blind.
    for (const l of await prisma.proposalLine.findMany({ where: { proposalId: proposal.id, included: true, proposedPrice: null } })) await setLineIncluded(rep, l.id, false);
    const r = await submitForApproval(rep, proposal.id, "Q4 conversion deal");
    assert.ok(r.routed >= 2, `routed ${r.routed}`);
    assert.equal(r.status, "SUBMITTED");
    await assert.rejects(assertEditable(proposal.id), /locked/);
    await assert.rejects(setProposedPrice(rep, trocar.id, d(1)), /locked/);
    const f = await finalizeCheck(proposal.id);
    assert.equal(f.ok, false);
  });
  await step("a regional manager cannot decide director- or committee-level lines; the director and committee can; approval unlocks export", async () => {
    const pending = await prisma.approvalRequest.findMany({ where: { proposalId: proposal.id, status: "PENDING" } });
    const committeeReq = pending.find((r) => r.requiredRole === "PRICING_COMMITTEE")!;
    const directorReq = pending.find((r) => r.requiredRole === "PRICING_DIRECTOR")!;
    assert.ok(committeeReq && directorReq);
    await assert.rejects(decide(manager, directorReq.id, "APPROVED"), AuthError);
    await assert.rejects(decide(director, committeeReq.id, "APPROVED"), AuthError);
    assert.ok((await queueFor(director)).some((r) => r.id === directorReq.id));
    await decide(director, directorReq.id, "APPROVED", "strategic account, volume justifies");
    let p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    assert.equal(p.status, "PARTIALLY_APPROVED");
    for (const r of pending.filter((x) => x.requiredRole === "PRICING_COMMITTEE")) await decide(committee, r.id, "APPROVED", "one-time exception for GST parity");
    for (const r of pending.filter((x) => !["PRICING_COMMITTEE", "PRICING_DIRECTOR"].includes(x.requiredRole))) await decide(director, r.id, "APPROVED");
    p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    assert.equal(p.status, "APPROVED");
    assert.equal((await finalizeCheck(proposal.id)).ok, true);
    await assert.rejects(applyScenario(rep, (await prisma.scenario.findFirstOrThrow({ where: { proposalId: proposal.id } })).id), /locked/);
  });

  await step("CRITICAL SCENARIO: the exported quote equals the approved prices, totals equal the line sum, history reconstructs every price, nothing moved after approval", async () => {
    const { buildQuote } = await import("../src/lib/proposals/export");
    const { parseCsv } = await import("../src/lib/sheets/csv");
    const lines = await prisma.proposalLine.findMany({ where: { proposalId: proposal.id, included: true }, orderBy: { lineNo: "asc" } });
    const q = await buildQuote(rep, proposal.id, "csv");
    const rows = parseCsv(q.buffer.toString("utf8"));
    for (const l of lines) {
      const row = rows.find((r) => String(r[0]) === l.competitorCode);
      assert.ok(row, `exported quote lacks ${l.competitorCode}`);
      assert.ok(row!.some((c) => Number(c) === Number(l.proposedPrice)), `${l.competitorCode}: export shows ${row} but approved price is ${l.proposedPrice}`);
      assert.ok(row!.some((c) => Number(c) === Number(l.quantity)), `${l.competitorCode}: quantity missing from export`);
    }
    // Totals: deal revenue equals the line sum, exactly.
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id }, include: { crosswalkVersion: true } });
    const econ = JSON.parse(p.economicsJson!);
    const revenue = lines.reduce((s, l) => s.plus(d(l.proposedPrice).times(d(l.quantity))), d(0));
    assert.equal(String(econ.revenue), revenue.toString(), "economics.revenue ≠ Σ price×qty");
    // Every included line that needed approval has an APPROVED or AUTO_APPROVED event carrying the price, floor, margin and policy it was judged at.
    for (const l of lines.filter((x) => x.requiredAuthority)) {
      const reqs = await prisma.approvalRequest.findMany({ where: { proposalLineId: l.id, status: "APPROVED" } });
      const auto = await prisma.auditEvent.findFirst({ where: { entityType: "ProposalLine", entityId: l.id, action: "AUTO_APPROVED" } });
      assert.ok(reqs.length || auto, `${l.competitorCode}: no approval record`);
      const ctx = reqs[0] ? JSON.parse(reqs[0].snapshotJson!) : JSON.parse(auto!.contextJson!);
      assert.equal(String(ctx.proposedPrice), d(l.proposedPrice).toString(), `${l.competitorCode}: approved at ${ctx.proposedPrice}, line now ${l.proposedPrice}`);
      assert.ok("floorPrice" in ctx && "marginPct" in ctx && "policyId" in ctx, "approval snapshot must carry floor, margin and policy");
    }
    // The crosswalk version is pinned and the account/contract context is on the proposal.
    assert.ok(p.crosswalkVersionId && p.crosswalkVersion?.status === "PUBLISHED");
    assert.equal(p.accountId, msk.id);
    // Nothing can move now.
    await assert.rejects(setProposedPrice(rep, lines[0].id, d(1)), /locked/);
    await assert.rejects(setLineIncluded(rep, lines[0].id, false), /locked/);
    // Unauthorized roles: no cost, no export.
    const clinical = await actor("dr.clinical@crosswalk.dev");
    await assert.rejects(buildQuote(clinical, proposal.id, "csv"), /permission/i);
    const { redactForActor } = await import("../src/lib/auth");
    const red = redactForActor(rep, lines[0] as unknown as Record<string, unknown>);
    assert.equal(red.cost, null); assert.equal(red.floorPrice, null); assert.equal(red.marginPct, null);
  });

  // ---- 6. CRM push, win, contract, compliance ---------------------------------------------
  await step("approved quote pushes to CRM idempotently (dev adapter) and syncs are logged", async () => {
    const crm = await syncCrmAccounts(rep.id);
    assert.equal(crm.failed, 0, `CRM sync failures: ${crm.errors.join("; ")}`);
    // The seeded MSK account and the CRM fixture are the same hospital: linked by account number, never duplicated.
    assert.equal(await prisma.account.count({ where: { accountNumber: "0001880967" } }), 1);
    assert.equal((await prisma.account.findUnique({ where: { accountNumber: "0001880967" } }))?.externalCrmId, "001DEV0000MSK001");
    const first = await pushQuote(rep.id, proposal.id);
    const second = await pushQuote(rep.id, proposal.id);
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.ok((await prisma.syncLog.count({ where: { entityType: "Proposal", entityId: proposal.id } })) >= 2);
  });
  await step("won deal becomes a LOCAL contract; the waterfall now resolves to the approved price; conversion is measured from purchases", async () => {
    const { contract } = await recordOutcome(rep, proposal.id, { outcome: "WON", contractMonths: 12 });
    assert.ok(contract);
    const ctx = await loadPricingContext({ accountId: msk.id });
    const prod = await prisma.ownProduct.findFirstOrThrow({ where: { sku: "ONB12STF" }, include: { prices: { include: { pricebook: true } } } });
    const r = ctx.resolvePrice({ ...prod, prices: prod.prices.map((e) => ({ ...e, pricebook: e.pricebook ? { name: e.pricebook.name } : null })) }, new Decimal(600));
    assert.equal(r.source, "LOCAL");
    assert.ok(r.price!.eq(round(d(trocar.contractPrice).times(0.95))), `contract price ${r.price} ≠ approved ${round(d(trocar.contractPrice).times(0.95))}`);
    await prisma.purchaseRecord.create({ data: { accountId: msk.id, productId: prod.id, sku: "ONB12STF", quantity: "120", netPrice: r.price!.toFixed(4), currency: "USD", invoiceDate: new Date(), contractId: contract!.id, proposalId: proposal.id, source: "import", externalId: `E2E-${proposal.id}` } });
    const conv = await proposalConversion(proposal.id);
    assert.equal(conv.linesConverted, 1);
    const perf = await contractPerformance(contract!.id);
    assert.ok(perf.commitments.length > 0);
    const local = await prisma.contract.findUniqueOrThrow({ where: { contractNumber: "MSK-LOCAL-2026" } });
    const lp = await contractPerformance(local.id);
    assert.ok(lp.commitments[0].actualValue !== "0");
  });
  await step("a new version of a closed proposal is an editable draft carrying every snapshot", async () => {
    const v2 = await newVersion(rep, proposal.id);
    assert.equal(v2.status, "DRAFT");
    assert.equal(v2.version, 2);
    const l = await prisma.proposalLine.findFirstOrThrow({ where: { proposalId: v2.id, sku: "PPM1510X3" } });
    assert.equal(l.contractPriceSource, "LOCAL");
    await setProposedPrice(rep, l.id, d(70), "v2 test");
  });

  // ---- 7. Governance ----------------------------------------------------------------------
  await step("a rep-proposed cross is DRAFT, invisible to reps until reviewed and published; older proposals keep their version", async () => {
    const cross = await proposeCross(rep.id, { ownSku: "PPM1106X3", competitorName: "Ethicon", competitorCode: "E2E-TEST-CODE", matchType: "Close Match" });
    assert.equal(cross.approvalStatus, "DRAFT");
    assert.equal((await approvedCross("E2E-TEST-CODE")).entries.length, 0);
    await setReview(marketing.id, cross.id, { approvalStatus: "APPROVED", clinicalReviewStatus: "APPROVED", marketingReviewStatus: "APPROVED", equivalenceLevel: "FUNCTIONAL" });
    assert.equal((await approvedCross("E2E-TEST-CODE")).entries.length, 0, "approved but not yet published");
    const before = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    const v = await publishVersion(marketing.id, "e2e publish");
    assert.equal((await approvedCross("E2E-TEST-CODE")).entries.length, 1);
    const after = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    assert.equal(after.crosswalkVersionId, before.crosswalkVersionId);
    assert.notEqual(after.crosswalkVersionId, v.version.id);
  });

  // ---- 8. Analytics -------------------------------------------------------------------------
  await step("analytics read models produce win/loss, pricing, conversion and acceptance figures", async () => {
    const wl = await winLoss(); assert.ok(wl.won >= 1);
    const pe = await pricingEffectiveness(); assert.ok(pe.linesWon >= 1);
    const cv = await conversion(); assert.ok(cv.converted >= 1);
    const acc = await crossReferenceAccuracy(); assert.ok(acc.decisions >= 30 && acc.top1AcceptanceRate !== null);
  });

  await step("file feed: CSV exports in INTEGRATION_FEED_DIR sync accounts and GPO memberships through the same idempotent path; existing accounts are linked, not duplicated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosswalk-feed-"));
    fs.writeFileSync(path.join(dir, "crm-accounts.csv"), [
      "externalId,name,accountNumber,type,region,isStrategic,gpoName,gpoTier,extraColumn",
      "001DEV0000MSK001,Memorial Sloan Kettering,0001880967,SOLD_TO,US-East,yes,Premier,Tier 2,ignored",
      "001FILE0000NEW001,E2E File Hospital,E2E-FILE-0001,SOLD_TO,US-West,no,,,",
      "001FILE0000DUPE01,Someone Else's MSK,0001880967,SOLD_TO,US-East,no,,,",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "gpo-memberships.csv"), "gpoName,gpoCode,accountNumber,tier,effectiveFrom\nVizient,VIZ,E2E-FILE-0001,Tier 1,2026-01-01\n");
    const before = await prisma.account.count();
    process.env.INTEGRATION_FEED_DIR = dir;
    try {
      assert.equal(crmAdapter().system, "file");
      const rep1 = await syncCrmAccounts(null);
      assert.equal(rep1.created + rep1.updated, 2, rep1.errors.join("; "));
      assert.equal(await prisma.account.count(), before + 1, "MSK must be linked to the file record, not duplicated");
      // A number already bound to a different CRM record is refused loudly — never silently re-pointed.
      assert.equal(rep1.failed, 1);
      assert.match(rep1.errors[0], /already linked to CRM record 001DEV0000MSK001/);
      assert.equal((await prisma.account.findUnique({ where: { accountNumber: "0001880967" } }))?.externalCrmId, "001DEV0000MSK001");
      const rep2 = await syncCrmAccounts(null);
      assert.equal(rep2.skipped, 2, "second sync of unchanged rows is a no-op");
      const gpo = await syncGpoMemberships(null);
      assert.equal(gpo.created, 1);
      const m = await prisma.gpoMembership.findFirst({ where: { account: { accountNumber: "E2E-FILE-0001" } }, include: { gpo: true } });
      assert.ok(m && m.gpo.name === "Vizient" && m.tier === "Tier 1");
    } finally {
      delete process.env.INTEGRATION_FEED_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await step("GUDID library: a bulk-imported labeler catalog resolves codes without openFDA, and library records can join our catalog", async () => {
    const company = await getCompany();
    const ownLabeler = (JSON.parse(company.labelers || "[]") as string[])[0] ?? "Covidien";
    const imp = await prisma.gudidImport.create({ data: { query: "E2E fixture", kind: "COMPETITOR", status: "DONE", fetched: 2, created: 2, finishedAt: new Date() } });
    const rec = (key: string, company_name: string, code: string, desc: string) => ({ public_device_record_key: key, company_name, brand_name: "E2E BRAND", catalog_number: code, version_or_model_number: code, device_description: desc, commercial_distribution_status: "In Commercial Distribution", identifiers: [{ id: `0${key.replace(/\D/g, "")}`.padEnd(14, "0"), type: "Primary" }], gmdn_terms: [{ code: "35386", name: "Polypropylene surgical mesh, non-bioabsorbable" }], device_sizes: [{ type: "Width", value: "10", unit: "Centimeter" }, { type: "Length", value: "15", unit: "Centimeter" }], public_version_date: "2026-01-01" });
    const { toDeviceRow } = await import("../src/lib/gudid/library-model");
    const rows = [rec("e2e-lib-1", "ETHICON, LLC", "E2E-LIB-9001", "E2E Mesh 10 cm x 15 cm"), rec("e2e-lib-2", ownLabeler.toUpperCase() + " LP", "E2E-OWN-7001", "E2E Own Mesh 10 cm x 15 cm")].map(toDeviceRow);
    await prisma.gudidDevice.createMany({ data: rows.map((r) => ({ ...r, importId: imp.id })) });

    // Library answers the exact and punctuation-free variants; nothing here exists in openFDA.
    assert.equal((await localHits("E2E-LIB-9001", false)).length, 1);
    assert.equal((await localHits("E2ELIB9001", false)).length, 1);
    assert.equal((await localHits("*LIB9001*", true)).length, 1);
    const hits = await gatherHits("E2E-LIB-9001", undefined, true);
    assert.ok(hits.length >= 1 && hits[0].fromLibrary === true, "resolver should take the library hit");
    const cp = await resolveCfn("E2E-LIB-9001", { useLlm: false, strict: true });
    assert.ok(cp && cp.resolution === "openfda" && cp.manufacturer === "Ethicon" && /GUDID library exact hit/.test(cp.resolutionNote ?? ""), `resolved as ${cp?.resolution}: ${cp?.resolutionNote}`);
    assert.ok((cp.confidence ?? 0) >= 0.75);

    // Adoption into our catalog: only our labeler's record becomes an OwnProduct; idempotent.
    assert.equal(await adoptRecords(["e2e-lib-2", "e2e-lib-2"]), 1);
    assert.equal(await adoptRecords(["e2e-lib-2"]), 0);
    const own = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku: "E2E-OWN-7001" } } });
    assert.ok(own && own.source === "gudid-import" && own.category === "Hernia Mesh" && own.gudidDi && own.binJson);

    // Authorization: the import is a catalog-management action.
    assert.equal(permissionsFor(["SALES_REP"]).has("manage_catalog"), false);
    assert.equal(permissionsFor(["PRODUCT_MARKETING"]).has("manage_catalog"), true);
    assert.equal(permissionsFor(["PRICING_ANALYST"]).has("manage_catalog"), true);
    // Leave the library as we found it (the fixture rows would otherwise show up in the UI).
    await prisma.gudidDevice.deleteMany({ where: { recordKey: { startsWith: "e2e-lib-" } } });
    await prisma.gudidImport.delete({ where: { id: imp.id } });
  });

  // Leave nothing behind: an approved E2E-TEST-CODE cross in a dev database would otherwise be
  // sampled by the model eval as if it were curated truth.
  await cleanup().catch((e) => console.log(`  (cleanup after run failed: ${e instanceof Error ? e.message : String(e)})`));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  await prisma.$disconnect();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

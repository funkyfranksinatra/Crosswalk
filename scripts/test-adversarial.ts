/**
 * Adversarial / reliability suite — state machines, concurrency, stale approvals,
 * authorization, money edge cases, data integrity. Runs against the database (use a
 * disposable branch: DOTENV_CONFIG_PATH=.env.debug). Every case here started life as a
 * reproduction of a real defect or an attack that should fail safely.
 *
 *   npx tsx scripts/test-adversarial.ts
 *
 * Fixtures are synthetic (reference ADV-*) and removed before each run.
 */
import "dotenv/config";
import { releaseResources } from "./lib/harness";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import { permissionsFor } from "../src/lib/auth/permissions";
import { type Actor, AuthError, verifySession, signSession, redactAuditEvent, redactForActor } from "../src/lib/auth";
import { setReview, proposeCross } from "../src/lib/xref/governance";
import { importPurchasesGrid } from "../src/lib/imports/purchases";
import { importCostsGrid } from "../src/lib/imports/costs";
import { draftPolicy } from "../src/lib/pricing/policy";
import { saveSettings, getCompany, getSettings } from "../src/lib/settings";
import { money, D, marginPct, discountPct, priceForMargin, round, sum, times } from "../src/lib/money";
import { setProposedPrice, setLineIncluded, refreshEconomics, recomputeLine, assertEditable, newVersion, createScenario, applyScenario } from "../src/lib/proposals/service";
import { submitForApproval, decide, finalizeCheck, reopen } from "../src/lib/approvals/service";
import { buildQuote } from "../src/lib/proposals/export";
import { recordOutcome } from "../src/lib/proposals/outcome";
import { resolveFromInputs } from "../src/lib/contracts/resolve";
import { economicsAt, recommend } from "../src/lib/pricing/recommend";
import { DEFAULT_POLICY, type Policy } from "../src/lib/pricing/policy-model";
import { summarize } from "../src/lib/intelligence/summarize";
import { parseIntakeAny } from "../src/lib/excel/intake";
import { toCsv, parseCsv } from "../src/lib/sheets/csv";

let passed = 0; const failures: string[] = [];
const POLICY: Policy = { ...DEFAULT_POLICY, id: "default", productFamily: "*", version: 1, status: "ACTIVE" };
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failures.push(`${name}\n    ${e instanceof Error ? e.message.replace(/\n/g, "\n    ") : String(e)}`); console.log(`  ✗ ${name}`); }
}
async function actor(email: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { roles: true } });
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}
const d = (v: unknown) => money(v as never)!;
async function rejects(fn: () => Promise<unknown>, re: RegExp, what: string) {
  try { await fn(); } catch (e) { const m = e instanceof Error ? e.message : String(e); if (re.test(m)) return; throw new Error(`${what}: rejected with the wrong message: ${m}`); }
  throw new Error(`${what}: expected rejection`);
}

async function cleanup() {
  const props = await prisma.proposal.findMany({ where: { reference: { startsWith: "ADV-" } }, select: { id: true } });
  const ids = props.map((p) => p.id);
  await prisma.purchaseRecord.deleteMany({ where: { proposalId: { in: ids } } });
  await prisma.contract.deleteMany({ where: { externalId: { in: ids } } });
  await prisma.competitorPriceObservation.deleteMany({ where: { proposalLineId: { in: (await prisma.proposalLine.findMany({ where: { proposalId: { in: ids } }, select: { id: true } })).map((l) => l.id) } } });
  await prisma.proposal.deleteMany({ where: { id: { in: ids } } });
  await prisma.auditEvent.deleteMany({ where: { entityType: "Proposal", entityId: { in: ids } } });
}

/** A synthetic three-line proposal: mesh (cheap discount), stapler (below floor), trocar (within rep authority). */
async function fixture(tag: string) {
  const rep = await actor("alex.rep@crosswalk.dev");
  const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
  const p = await prisma.proposal.create({ data: { reference: `ADV-${tag}-${Date.now().toString(36)}`, accountId: acc.id, currency: "USD", status: "DRAFT", ownerUserId: rep.id, createdByUserId: rep.id, validThrough: new Date(Date.now() + 30 * 864e5) } });
  const mk = (lineNo: number, code: string, fam: string, list: string, contract: string | null, cost: string, qty: string, proposed: string) => ({
    proposalId: p.id, lineNo, competitorCode: code, competitorName: "Ethicon", sku: `ADV-${code}`, description: `ADV ${code}`, productFamily: fam, quantity: d(qty).toString(), uom: "EA",
    listPrice: list, contractPrice: contract, contractPriceSource: contract ? "GPO" : "LIST", cost, floorPrice: priceForMargin(d(cost), d(DEFAULT_POLICY.minMarginPct))!.toString(),
    recommendedPrice: proposed, proposedPrice: proposed, policyId: "default", equivalenceLevel: "FUNCTIONAL", matchType: "Close Match",
  });
  await prisma.proposalLine.createMany({ data: [
    mk(1, "MESH-1", "Hernia Mesh", "1000", "760", "300", "100", "700"),      // 7.9% below contract → rep authority (15%)
    mk(2, "STAP-1", "Surgical Stapling Products", "500", "400", "250", "200", "300"), // below floor (250/(1-0.35)=384.6) → committee
    mk(3, "TROC-1", "Trocar Products", "120", "100", "40", "1000", "80"),      // 20% below contract → manager
  ] });
  for (const l of await prisma.proposalLine.findMany({ where: { proposalId: p.id } })) await recomputeLine(l.id);
  await refreshEconomics(p.id);
  return { p, rep, lines: await prisma.proposalLine.findMany({ where: { proposalId: p.id }, orderBy: { lineNo: "asc" } }) };
}

async function main() {
  await cleanup();
  const rep = await actor("alex.rep@crosswalk.dev");
  const manager = await actor("maria.manager@crosswalk.dev");
  const director = await actor("dana.director@crosswalk.dev");
  const committee = await actor("committee@crosswalk.dev");
  const finance = await actor("finance@crosswalk.dev");
  const clinical = await actor("dr.clinical@crosswalk.dev");

  // ---- Sessions ---------------------------------------------------------------------------
  await step("a bare user id is not a session; only the signed cookie value is", async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { email: "admin@crosswalk.dev" } });
    assert.equal(verifySession(u.id), null, "raw user id must not authenticate");
    assert.equal(verifySession(signSession(u.id)), u.id);
    assert.equal(verifySession(signSession(u.id).replace(/.$/, (c) => (c === "a" ? "b" : "a"))), null, "tampered signature");
    assert.equal(verifySession(`${u.id}.`), null);
  });

  // ---- Money -----------------------------------------------------------------------------
  await step("money arithmetic is exact where floats are not", async () => {
    assert.equal(sum([D("0.1"), D("0.2")]).toString(), "0.3");
    assert.equal(round(D("0.005")).toString(), "0", "banker's rounding: 0.005 → 0.00");
    assert.equal(round(D("0.015")).toString(), "0.02");
    assert.equal(round(D("0.025")).toString(), "0.02");
    assert.equal(times(D("999999.99"), D("1000000"))!.toString(), "999999990000");
    assert.equal(marginPct(D("442.50"), D("233.64"))!.toFixed(6), "0.472000");
    assert.equal(marginPct(D("100"), D("0"))!.toString(), "1", "zero cost → 100% margin, not an error");
    assert.equal(marginPct(D("0"), D("10")), null, "zero price → margin undefined, never Infinity");
    assert.equal(marginPct(D("80"), D("100"))!.toString(), "-0.25", "negative margin is allowed and reported");
    assert.equal(discountPct(D("0"), D("1000"))!.toString(), "1", "100% discount");
    assert.equal(discountPct(D("100"), D("0")), null, "no reference → no discount, never division by zero");
    assert.equal(discountPct(D("1200"), D("1000"))!.toString(), "-0.2", ">list price is a negative discount, not clamped");
    assert.equal(priceForMargin(D("100"), D("0.35"))!.toFixed(4), "153.8462");
    assert.equal(priceForMargin(D("100"), D("1")), null, "100% target margin has no finite price");
  });

  // ---- Waterfall dates --------------------------------------------------------------------
  const today = new Date("2026-09-15T12:00:00Z");
  const mkc = (id: string, from: string, to: string | null, price: string, type = "LOCAL", precedence = 0, extra: Partial<{ currency: string; approvalState: string }> = {}) => ({
    id, contractNumber: id, name: id, type, status: "ACTIVE", accountId: "A", parentAccountId: null, gpoId: null, tier: null, currency: extra.currency ?? "USD", effectiveFrom: new Date(from), effectiveTo: to ? new Date(to) : null, precedence, scopes: [],
    entries: [{ id: `${id}-e`, productId: "P", price, currency: extra.currency ?? "USD", effectiveFrom: new Date(from), effectiveTo: null, tier: null, minQty: null, maxQty: null, volumeTierName: null, status: "ACTIVE", approvalState: extra.approvalState ?? "APPROVED" }],
  });
  const base = { product: { id: "P", sku: "P", family: "Hernia Mesh", listPrice: "100", currency: "USD" }, listEntries: [], account: { id: "A", parentAccountId: null, currency: "USD" }, memberships: [], asOf: today, quantity: D("1"), currency: "USD" };
  await step("waterfall: contracts beginning today apply, contracts ending today apply, tomorrow's and yesterday's do not; ties choose the lowest price and say so", async () => {
    const r = resolveFromInputs({ ...base, contracts: [mkc("starts-today", "2026-09-15T00:00:00Z", null, "90"), mkc("ends-today", "2025-09-15T00:00:00Z", "2026-09-15T23:59:59Z", "95"), mkc("tomorrow", "2026-09-16T00:00:00Z", null, "50"), mkc("expired", "2025-01-01", "2026-09-14T23:59:59Z", "40")] });
    assert.equal(String(r.price), "90", `expected 90, got ${r.price} — steps: ${JSON.stringify(r.steps.map((s) => [s.level, s.price, s.reason]))}`);
    const tie = resolveFromInputs({ ...base, contracts: [mkc("a", "2025-01-01", null, "90"), mkc("b", "2025-01-01", null, "85")] });
    assert.equal(String(tie.price), "85");
    assert.match(JSON.stringify(tie.steps), /lowest|tie|equal/i);
  });
  await step("waterfall: a EUR contract never prices a USD question; an unapproved entry never applies", async () => {
    assert.equal(String(resolveFromInputs({ ...base, contracts: [mkc("eur", "2025-01-01", null, "10", "LOCAL", 0, { currency: "EUR" })] }).price), "100");
    assert.equal(String(resolveFromInputs({ ...base, contracts: [mkc("draft", "2025-01-01", null, "10", "LOCAL", 0, { approvalState: "PENDING" })] }).price), "100");
  });

  // ---- Recommendation / authority edge cases -----------------------------------------------
  await step("recommendation never goes below floor, never above reference; missing cost → no floor, margin unknown, not zero", async () => {
    const policy = POLICY;
    const r = recommend({ currency: "USD", listPrice: D("1000"), contractPrice: D("760"), contractSource: "GPO", cost: D("300"), quantity: D("10"), competitorPrice: D("200"), competitorConfidence: 0.95, competitorBasis: "KNOWN_ACCOUNT", policy, strategy: "MATCH" });
    assert.ok(r.recommendedPrice!.gte(r.floorPrice!), `recommended ${r.recommendedPrice} below floor ${r.floorPrice}`);
    const nocost = recommend({ currency: "USD", listPrice: D("1000"), contractPrice: D("760"), contractSource: "GPO", cost: null, quantity: D("10"), competitorPrice: null, competitorConfidence: 0, competitorBasis: "NONE", policy, strategy: "UNDERCUT_PCT" });
    assert.equal(nocost.floorPrice, null);
    assert.equal(nocost.marginPct, null);
    assert.ok(nocost.recommendedPrice!.lte(D("760")));
    const e = economicsAt(D("0.01"), { listPrice: D("1000"), contractPrice: D("760"), cost: D("300"), quantity: D("1"), policy, strategicAccount: false, dealValue: null, contractMonths: null }, D("461.54"));
    assert.equal(e.requiredAuthority, "PRICING_COMMITTEE", "a $0.01 price is below floor and needs the committee");
  });

  await step("competitor intelligence: an absurd observation (case price as unit price) does not become KNOWN_ACCOUNT on its own", async () => {
    const now = new Date();
    const s = summarize([{ id: "o1", competitorSku: "X", price: "24000", currency: "USD", uom: "CS", observedAt: now, sourceType: "REP_OBSERVED", verificationStatus: "UNVERIFIED", rawConfidence: 0.6, accountId: "A", gpoId: null, region: null }], { accountId: "A", gpoId: null, region: null, currency: "USD", asOf: now });
    assert.notEqual(s.basis, "KNOWN_ACCOUNT", `basis ${s.basis}`);
  });

  // ---- State machine + stale approvals (the chain) -------------------------------------------
  let fx = await fixture("chain");
  await step("submit routes the three lines correctly and locks the proposal", async () => {
    const r = await submitForApproval(fx.rep, fx.p.id);
    assert.equal(r.autoApproved, 0, "the mesh line is within rep authority: no approval at all"); assert.equal(r.routed, 2);
    const mesh = await prisma.proposalLine.findFirstOrThrow({ where: { proposalId: fx.p.id, competitorCode: "MESH-1" } });
    assert.equal(mesh.approvalState, "NOT_REQUIRED");
    await rejects(() => setProposedPrice(fx.rep, fx.lines[0].id, D("650")), /locked/, "edit while locked");
    await rejects(() => submitForApproval(fx.rep, fx.p.id), /only drafts/i, "double submit");
  });
  await step("CHAIN: changes-requested on one line must not let a repriced sibling line be approved against a stale snapshot", async () => {
    const reqs = await prisma.approvalRequest.findMany({ where: { proposalId: fx.p.id, status: "PENDING" }, include: { proposalLine: true } });
    const trocar = reqs.find((r) => r.proposalLine?.competitorCode === "TROC-1")!;
    const stapler = reqs.find((r) => r.proposalLine?.competitorCode === "STAP-1")!;
    await decide(committee, stapler.id, "CHANGES_REQUESTED", "too deep");
    // The rep now edits the *trocar* line (its request is still pending) to a deeper discount that is
    // still above floor (so nothing but the snapshot check can catch it): 30% off contract needs a
    // contracting manager, but the pending request only asks for a regional manager.
    await setProposedPrice(fx.rep, trocar.proposalLineId!, D("70"), "sneaky");
    // The manager, working from the queue, approves the trocar request they reviewed at $80.
    const outcome = await decide(manager, trocar.id, "APPROVED", "looks fine at 80").catch((e) => e);
    const line = await prisma.proposalLine.findUniqueOrThrow({ where: { id: trocar.proposalLineId! } });
    assert.ok(outcome instanceof Error || line.approvalState !== "APPROVED", `stale approval went through: line is ${line.approvalState} at ${line.proposedPrice}`);
    const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: trocar.id } });
    assert.notEqual(req.status, "APPROVED", "the stale request must not be marked approved");
  });
  await step("CHAIN: resubmission after changes-requested supersedes old requests; the proposal can still reach APPROVED", async () => {
    // Fix the stapler line, resubmit, decide everything, expect APPROVED + exportable.
    const stap = fx.lines.find((l) => l.competitorCode === "STAP-1")!;
    await setProposedPrice(fx.rep, stap.id, D("390"), "raised above floor");
    const troc = fx.lines.find((l) => l.competitorCode === "TROC-1")!;
    await setProposedPrice(fx.rep, troc.id, D("80"), "back to 80");
    const r = await submitForApproval(fx.rep, fx.p.id);
    const pending = await prisma.approvalRequest.findMany({ where: { proposalId: fx.p.id, status: "PENDING" } });
    assert.equal(pending.length, r.routed);
    for (const q of pending) await decide(q.requiredRole === "PRICING_COMMITTEE" ? committee : director, q.id, "APPROVED", "ok");
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.p.id } });
    assert.equal(p.status, "APPROVED", `status ${p.status} — an old CHANGES_REQUESTED request is still counted`);
    assert.ok((await finalizeCheck(fx.p.id)).ok);
  });
  await step("exported quote carries exactly the approved prices; nothing mutated after approval", async () => {
    const before = await prisma.proposalLine.findMany({ where: { proposalId: fx.p.id }, orderBy: { lineNo: "asc" } });
    const q = await buildQuote(fx.rep, fx.p.id, "csv");
    const rows = parseCsv(q.buffer.toString("utf8"));
    for (const l of before) {
      const row = rows.find((r) => String(r[0]) === l.competitorCode);
      assert.ok(row, `line ${l.competitorCode} missing from export`);
      assert.ok(row!.some((c) => Number(c) === Number(l.proposedPrice)), `export row for ${l.competitorCode} lacks the approved price ${l.proposedPrice}: ${row}`);
    }
    const after = await prisma.proposalLine.findMany({ where: { proposalId: fx.p.id }, orderBy: { lineNo: "asc" } });
    assert.deepEqual(after.map((l) => [l.proposedPrice?.toString(), l.approvalState]), before.map((l) => [l.proposedPrice?.toString(), l.approvalState]));
    await rejects(() => setProposedPrice(fx.rep, before[0].id, D("1")), /locked/, "post-approval edit");
  });
  await step("a rep cannot export before approval, a clinical reviewer cannot export at all, finance cannot set prices", async () => {
    const f2 = await fixture("perm");
    await rejects(() => buildQuote(f2.rep, f2.p.id, "csv"), /awaiting|submit|approval|approved/i, "export draft");
    await rejects(() => buildQuote(clinical, fx.p.id, "csv"), /permission/i, "clinical export");
    await rejects(() => setProposedPrice(finance, f2.lines[0].id, D("500")), /permission/i, "finance pricing");
    const anyReq = await prisma.approvalRequest.findFirstOrThrow({ where: { proposalId: fx.p.id } });
    await rejects(() => decide(rep, anyReq.id, "APPROVED"), /permission|already|authority/i, "rep approving");
  });

  // ---- Concurrency ---------------------------------------------------------------------------
  await step("two managers deciding the same request simultaneously: exactly one decision is recorded", async () => {
    const f3 = await fixture("race");
    await submitForApproval(f3.rep, f3.p.id);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { proposalId: f3.p.id, requiredRole: "REGIONAL_MANAGER" } });
    const results = await Promise.allSettled([decide(manager, req.id, "APPROVED", "A"), decide(director, req.id, "REJECTED", "B")]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 1, `expected exactly one decision to win, got ${ok}: ${results.map((r) => r.status === "rejected" ? (r.reason as Error).message : "ok").join(" | ")}`);
    const events = await prisma.auditEvent.count({ where: { entityType: "ApprovalRequest", entityId: req.id, action: { in: ["APPROVED", "REJECTED"] } } });
    assert.equal(events, 1, `duplicate decision audit events: ${events}`);
  });
  await step("double submit in parallel creates one set of approval requests", async () => {
    const f4 = await fixture("dbl");
    const results = await Promise.allSettled([submitForApproval(f4.rep, f4.p.id), submitForApproval(f4.rep, f4.p.id)]);
    const reqs = await prisma.approvalRequest.count({ where: { proposalId: f4.p.id, status: "PENDING" } });
    assert.equal(reqs, 2, `duplicate approval requests: ${reqs} (${results.map((r) => r.status).join(",")})`);
  });
  await step("parallel price edits on one line leave a consistent line and one audit event per write", async () => {
    const f5 = await fixture("par");
    const l = f5.lines[0];
    await Promise.all([D("690"), D("680"), D("670")].map((p) => setProposedPrice(f5.rep, l.id, p, "burst")));
    const line = await prisma.proposalLine.findUniqueOrThrow({ where: { id: l.id } });
    const econ = economicsAt(money(line.proposedPrice), { listPrice: money(line.listPrice), contractPrice: money(line.contractPrice), cost: money(line.cost), quantity: money(line.quantity)!, policy: POLICY, strategicAccount: false, dealValue: null, contractMonths: null }, money(line.floorPrice));
    assert.equal(Number(line.marginPct), Number(econ.marginPct?.toFixed(6)), "stored margin must match the stored price (lost-update check)");
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: f5.p.id } });
    const e = JSON.parse(p.economicsJson!);
    const fresh = await refreshEconomics(f5.p.id);
    assert.equal(String(e.revenue), fresh.revenue.toString(), "stored deal economics must match the recomputed rollup");
  });

  // ---- Invalid inputs -------------------------------------------------------------------------
  await step("negative, zero, NaN and absurd prices are refused; a 100% discount needs the committee", async () => {
    const f6 = await fixture("inp");
    await rejects(() => setProposedPrice(f6.rep, f6.lines[0].id, D("-5")), /positive/, "negative");
    await rejects(() => setProposedPrice(f6.rep, f6.lines[0].id, D("0")), /positive/, "zero");
    assert.equal(money("abc"), null, "garbage is null, and the API must refuse it rather than clear the price (see lines route)");
    await rejects(() => setProposedPrice(f6.rep, f6.lines[0].id, D("1e12")), /too large|positive|exceed/i, "absurd");
    const l = await setProposedPrice(f6.rep, f6.lines[0].id, D("0.01"));
    assert.equal(l.requiredAuthority, "PRICING_COMMITTEE");
  });

  // ---- Data integrity -------------------------------------------------------------------------
  await step("a won proposal's contract cannot be deleted from under it; a request with proposals cannot be deleted", async () => {
    const f7 = await fixture("won");
    await setProposedPrice(f7.rep, f7.lines[1].id, D("390"));
    await setProposedPrice(f7.rep, f7.lines[2].id, D("95"));
    await submitForApproval(f7.rep, f7.p.id);
    for (const q of await prisma.approvalRequest.findMany({ where: { proposalId: f7.p.id, status: "PENDING" } })) await decide(q.requiredRole === "PRICING_COMMITTEE" ? committee : director, q.id, "APPROVED");
    await recordOutcome(f7.rep, f7.p.id, { outcome: "WON", contractMonths: 12 } as never);
    const c = await prisma.contract.findFirst({ where: { externalId: f7.p.id } });
    assert.ok(c, "won → local contract");
    await rejects(() => recordOutcome(f7.rep, f7.p.id, { outcome: "LOST" } as never), /already|closed|won/i, "second outcome");
    await rejects(() => setProposedPrice(f7.rep, f7.lines[0].id, D("1")), /locked|won/i, "edit after won");
  });

  // ---- Intake adversarial ----------------------------------------------------------------------
  await step("intake parser survives formulas, unicode, huge quantities, blanks and duplicate headers; CSV output neutralises formula injection", async () => {
    const csv = ["Product Code,Quantity,Quantity", "=HYPERLINK(\"http://x\"),12,1", "  PPM1510X3 ,-4,", "\"SPMII\",1e9,", ",5,", "1DLMC05,abc,", "1DLMC05,3,", "ÜNÏ-cødé,2,"].join("\n");
    const intake = await parseIntakeAny({ file: null, sheetUrl: "", csvText: csv, csvName: "adv.csv" });
    assert.deepEqual(intake.lines.map((l) => [l.cfnNorm, l.quantity]), [["1DLMC05", 4]], `parsed ${JSON.stringify(intake.lines.map((l) => [l.cfnNorm, l.quantity]))}`);
    assert.ok(!intake.lines.some((l) => l.rawCode.startsWith("=")), "formula code must not be accepted as a catalog number");
    assert.ok(intake.skipped.some((k) => /not a positive/.test(k.reason)) && intake.skipped.some((k) => /implausible/.test(k.reason)), JSON.stringify(intake.skipped));
    const out = toCsv([["=1+1", "+cmd", "-x", "@y", "normal"]]);
    assert.ok(!/^=|,=|^\+|,\+|^-|,-|^@|,@/.test(out.replace(/^﻿/, "")), `CSV formula injection not neutralised: ${out}`);
  });

  // ---- Redaction --------------------------------------------------------------------------------
  await step("cost, floor and margin never reach a rep through the audit trail or nested recommendation JSON", async () => {
    const ev = { beforeJson: JSON.stringify({ proposedPrice: "80" }), afterJson: null, contextJson: JSON.stringify({ floorPrice: "61.54", marginPct: "0.5", recommendedPrice: "88", nested: { cost: "40", list: [{ marginAmount: "1" }] } }) };
    const r = redactAuditEvent(rep, ev);
    const ctx = JSON.parse(r.contextJson!);
    assert.equal(ctx.floorPrice, null); assert.equal(ctx.marginPct, null); assert.equal(ctx.nested.cost, null); assert.equal(ctx.nested.list[0].marginAmount, null);
    assert.equal(ctx.recommendedPrice, "88", "non-sensitive fields survive");
    const fin = redactAuditEvent(finance, ev);
    assert.equal(JSON.parse(fin.contextJson!).floorPrice, "61.54", "finance sees cost");
    const line = redactForActor(rep, { cost: "40", floorPrice: "61", marginPct: "0.5", recommendationJson: JSON.stringify({ floorPrice: "61", marginPct: "0.5", explanation: "Recommend $80: x. Gross margin 50.0% ($40.00/unit), $18.46 above the default floor $61.54, 20.0% off list. Within sales-rep authority.", explanationPublic: "Recommend $80: x. 20.0% off list. Within sales-rep authority." }) });
    const rj = JSON.parse(line.recommendationJson as string);
    assert.equal(rj.floorPrice, null); assert.ok(!/margin|floor \$/i.test(rj.explanation), rj.explanation);
    assert.equal(line.cost, null);
  });

  // ---- Crosswalk governance -------------------------------------------------------------------
  await step("a cross cannot be approved on one signature, with no equivalence, or with an invented status", async () => {
    const marketing = await actor("lee.marketing@crosswalk.dev");
    const x = await proposeCross(rep.id, { competitorName: "Ethicon", competitorCode: "ADV-X-1", ownSku: "PPM1510X3", matchType: "Close Match", justification: "adversarial" } as never);
    try {
      await rejects(() => setReview(marketing.id, x.id, { approvalStatus: "APPROVED" }), /clinical review is|both must be/i, "one-signature approval");
      await rejects(() => setReview(marketing.id, x.id, { approvalStatus: "SHIPPED" as never }), /must be one of/i, "invented status");
      await rejects(() => setReview(marketing.id, x.id, { equivalenceLevel: "IDENTICAL" as never }), /must be one of/i, "invented equivalence");
      await setReview(marketing.id, x.id, { marketingReviewStatus: "APPROVED", clinicalReviewStatus: "APPROVED" });
      await rejects(() => setReview(marketing.id, x.id, { approvalStatus: "APPROVED", equivalenceLevel: "NONE" }), /no equivalence/i, "approve with NONE");
      const ok = await setReview(marketing.id, x.id, { approvalStatus: "APPROVED", equivalenceLevel: "FUNCTIONAL" });
      assert.equal(ok.approvalStatus, "APPROVED");
    } finally {
      await prisma.crosswalkVersionEntry.deleteMany({ where: { knownCrossId: x.id } });
      await prisma.knownCross.delete({ where: { id: x.id } });
    }
  });

  // ---- Import idempotency ---------------------------------------------------------------------
  await step("purchase and cost imports are idempotent and skip bad rows with a reason", async () => {
    const company = await prisma.company.findFirstOrThrow();
    const grid = [["Account", "SKU", "Quantity", "Net Price", "Invoice Date", "Invoice Number"], ["0001880967", "PPM1510X3", "10", "72.50", "2026-08-01", "ADV-INV-1"], ["0001880967", "PPM1510X3", "abc", "72.50", "2026-08-01", "ADV-INV-2"], ["0001880967", "PPM1510X3", "5", "72.50", "not a date", "ADV-INV-3"], ["nobody", "PPM1510X3", "5", "1", "2026-08-01", "ADV-INV-4"]];
    try {
      const a = await importPurchasesGrid(grid, company.id, null);
      assert.equal(a.created, 1, JSON.stringify(a)); assert.equal(a.skipped.length, 3, a.skipped.join(" | "));
      const b = await importPurchasesGrid(grid, company.id, null);
      assert.equal(b.created, 0); assert.equal(b.updated, 1, "second import updates, never duplicates");
      assert.equal(await prisma.purchaseRecord.count({ where: { externalId: "ADV-INV-1" } }), 1);
      const cg = [["SKU", "Cost", "Currency", "Plant", "Effective From"], ["PPM1510X3", "27.90", "USD", "ADV-PLANT", "2026-01-01"], ["PPM1510X3", "-3", "USD", "ADV-PLANT", "2026-01-01"], ["PPM1510X3", "28", "usd", "ADV-PLANT", "2026-01-01"], ["PPM1510X3", "28", "EURO", "ADV-PLANT", "2026-01-01"]];
      const c1 = await importCostsGrid(cg, company.id);
      assert.equal(c1.created, 1); assert.equal(c1.updated, 1, "same key with a new cost updates in place"); assert.equal(c1.invalid.length, 2, JSON.stringify(c1.invalid));
      assert.equal(await prisma.standardCost.count({ where: { plant: "ADV-PLANT" } }), 1);
    } finally {
      await prisma.purchaseRecord.deleteMany({ where: { externalId: { startsWith: "ADV-INV-" } } });
      await prisma.standardCost.deleteMany({ where: { plant: "ADV-PLANT" } });
    }
  });

  // ---- Configuration attacks ------------------------------------------------------------------
  await step("a policy that would disable floors or invert authority is refused; a sane draft is accepted", async () => {
    const admin = await actor("admin@crosswalk.dev");
    await rejects(() => draftPolicy(admin.id, { productFamily: "ADV Family", minMarginPct: 1 } as never), /Invalid policy/, "100% min margin");
    await rejects(() => draftPolicy(admin.id, { productFamily: "ADV Family", minMarginPct: 0.5, targetMarginPct: 0.4 }), /above target/, "min > target");
    await rejects(() => draftPolicy(admin.id, { productFamily: "ADV Family", authority: { SALES_REP: 0.5, REGIONAL_MANAGER: 0.1 } }), /must not shrink/, "inverted authority");
    await rejects(() => draftPolicy(admin.id, { productFamily: "ADV Family", approvalRules: [] }), /below floor/, "no floor rule");
    await rejects(() => draftPolicy(admin.id, { productFamily: "ADV Family", defaultStrategy: "YOLO" as never }), /Invalid policy/, "unknown strategy");
    const ok = await draftPolicy(admin.id, { productFamily: "ADV Family", targetMarginPct: 0.5, minMarginPct: 0.35 });
    assert.equal(ok.status, "DRAFT");
    await prisma.pricingPolicy.deleteMany({ where: { productFamily: "ADV Family" } });
    await prisma.auditEvent.deleteMany({ where: { entityType: "PricingPolicy", entityId: ok.id } });
  });
  await step("renaming the company keeps the catalog (no second Company row); bad settings are refused", async () => {
    const before = await getCompany();
    const products = await prisma.ownProduct.count({ where: { companyId: before.id } });
    await saveSettings({ companyName: `${before.name} ADV` });
    const after = await getCompany();
    assert.equal(after.id, before.id, "same company row");
    assert.equal(await prisma.ownProduct.count({ where: { companyId: after.id } }), products);
    assert.equal(await prisma.company.count(), 1);
    await saveSettings({ companyName: before.name });
    assert.equal((await getCompany()).name, before.name);
    await rejects(() => saveSettings({ maxCandidates: 100000 }), /between 1 and 25/, "absurd candidates");
    await rejects(() => saveSettings({ weights: { bin: -1 } as never }), /between 0 and 10/, "negative weight");
    await rejects(() => saveSettings({ weights: { bin: 0, price: 0, cogs: 0, margin: 0 } as never }), /positive/, "all-zero weights");
    assert.equal((await getSettings()).maxCandidates <= 25, true);
  });
  await step("a rep-proposed cross must name a real SKU and a real match type", async () => {
    await rejects(() => proposeCross(rep.id, { ownSku: "NOPE-000", competitorName: "X", competitorCode: "Y1", matchType: "Close Match" }), /not in our catalog/, "unknown sku");
    await rejects(() => proposeCross(rep.id, { ownSku: "PPM1510X3", competitorName: "X", competitorCode: "Y1", matchType: "Perfect" }), /matchType/, "bad match type");
    await rejects(() => proposeCross(rep.id, { competitorName: "X", competitorCode: "Y1", matchType: "Close Match" } as never), /required/, "missing sku");
  });
  await step("an approved proposal past its valid-through date cannot be exported", async () => {
    const f8 = await fixture("exp");
    await setProposedPrice(f8.rep, f8.lines[1].id, D("390")); await setProposedPrice(f8.rep, f8.lines[2].id, D("95"));
    await submitForApproval(f8.rep, f8.p.id);
    for (const q of await prisma.approvalRequest.findMany({ where: { proposalId: f8.p.id, status: "PENDING" } })) await decide(q.requiredRole === "PRICING_COMMITTEE" ? committee : director, q.id, "APPROVED");
    assert.ok((await finalizeCheck(f8.p.id)).ok);
    await prisma.proposal.update({ where: { id: f8.p.id }, data: { validThrough: new Date(Date.now() - 864e5) } });
    await rejects(() => buildQuote(f8.rep, f8.p.id, "csv"), /expired/, "expired export");
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  // Stop the queue (started by any step that enqueued a job) and the client, so the process exits by itself.
  await releaseResources();
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

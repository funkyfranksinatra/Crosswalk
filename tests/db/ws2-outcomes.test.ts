/**
 * WS2 — finalisation and outcomes: canFinalize (each failure alone and combined), WON as one
 * atomic, idempotent close (LOCAL contract + ACTIVE/APPROVED entries + commitments + outcome),
 * simultaneous closes, LOST / NO_DECISION, one outcome per proposal; compliance statuses, rebate
 * tiers per basis, bundle qualification, renewal flags vs the 180-day pipeline, conversion.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { D, money, ZERO } from "@/lib/money";
import { canFinalize } from "@/lib/approvals/rules";
import { submitForApproval, finalizeCheck } from "@/lib/approvals/service";
import { setProposedPrice } from "@/lib/proposals/service";
import { recordOutcome, contractFromProposal, contractNumberFor } from "@/lib/proposals/outcome";
import { loadPricingContext } from "@/lib/contracts/context";
import { contractPerformance, proposalConversion, renewalPipeline } from "@/lib/compliance";
import { effectiveNet, tierReached, parseTiers, rebateBasisValue } from "@/lib/contracts/rebates";
import { conditionMet, benefitApplies, applyBenefit, parseBundle } from "@/lib/contracts/bundles";
import { RUN, day, mkUser, mkProduct, mkAccount, mkContract, mkProposal, mkPolicy, linesOf, cleanupRun, withTxFailure } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("WS2 canFinalize (pure)", () => {
  const line = (over: Partial<{ included: boolean; approvalState: string; proposedPrice: ReturnType<typeof D> | null }> = {}) => ({ included: true, approvalState: "APPROVED", proposedPrice: D("10"), ...over });
  const ok = { status: "APPROVED", validThrough: day("2027-01-01"), asOf: day("2026-06-01"), lines: [line()] };
  test("each failure alone, in precedence order, then combined", () => {
    expect(canFinalize(ok)).toEqual({ ok: true, reason: "all included lines priced and approved" });
    expect(canFinalize({ ...ok, validThrough: day("2026-05-31") })).toMatchObject({ ok: false, reason: "proposal expired on 2026-05-31; create a new version" });
    expect(canFinalize({ ...ok, validThrough: day("2026-05-31"), status: "WON" }).ok).toBe(true); // WON is never "expired"
    expect(canFinalize({ ...ok, lines: [] })).toMatchObject({ ok: false, reason: "no lines included" });
    expect(canFinalize({ ...ok, lines: [line({ included: false })] })).toMatchObject({ ok: false, reason: "no lines included" });
    expect(canFinalize({ ...ok, lines: [line(), line({ proposedPrice: null })] })).toMatchObject({ ok: false, reason: "1 included line(s) have no proposed price" });
    for (const st of ["REQUIRED", "PENDING", "REJECTED"]) expect(canFinalize({ ...ok, lines: [line({ approvalState: st })] })).toMatchObject({ ok: false, reason: "1 line(s) awaiting or denied approval" });
    expect(canFinalize({ ...ok, lines: [line({ approvalState: "NOT_REQUIRED" })] }).ok).toBe(true);
    for (const st of ["DRAFT", "SUBMITTED", "PARTIALLY_APPROVED", "CHANGES_REQUESTED", "REJECTED", "LOST"]) expect(canFinalize({ ...ok, status: st })).toMatchObject({ ok: false, reason: `proposal is ${st.toLowerCase().replace(/_/g, " ")}; submit it for approval first` });
    expect(canFinalize({ ...ok, status: "WON" }).ok).toBe(true);
    // Combined: the first failing check in order wins — expiry, then lines, then prices, then approvals, then status.
    expect(canFinalize({ ...ok, status: "DRAFT", validThrough: day("2020-01-01"), lines: [line({ proposedPrice: null, approvalState: "PENDING" })] }).reason).toMatch(/expired/);
    expect(canFinalize({ ...ok, status: "DRAFT", lines: [line({ proposedPrice: null, approvalState: "PENDING" })] }).reason).toMatch(/no proposed price/);
    expect(canFinalize({ ...ok, status: "DRAFT", lines: [line({ approvalState: "PENDING" })] }).reason).toMatch(/awaiting or denied/);
    expect(canFinalize({ ...ok, status: "DRAFT" }).reason).toMatch(/proposal is draft/);
    // Excluded lines never block.
    expect(canFinalize({ ...ok, lines: [line(), line({ included: false, proposedPrice: null, approvalState: "REJECTED" })] }).ok).toBe(true);
  });
});

describe("WS2 rebates and bundles (pure)", () => {
  const tiers = JSON.stringify([{ threshold: 1000, rebatePct: 0.05 }, { threshold: 500, rebatePct: 0.02 }, { threshold: 2000, rebateAmount: 1.5 }]);
  test("tiers sort ascending; the highest satisfied threshold applies, non-cumulative; next tier and distance reported", () => {
    const t = parseTiers(tiers);
    expect(t.map((x) => x.threshold)).toEqual([500, 1000, 2000]);
    expect(tierReached(t, D(499))).toEqual({ tier: null, next: t[0] });
    expect(tierReached(t, D(500))).toEqual({ tier: t[0], next: t[1] });
    expect(tierReached(t, D(1999))).toEqual({ tier: t[1], next: t[2] });
    expect(tierReached(t, D(5000))).toEqual({ tier: t[2], next: null });
    expect(parseTiers("not json")).toEqual([]);
    expect(parseTiers(JSON.stringify([{ threshold: -1 }]))).toEqual([]);
    const r = { id: "r", type: "VOLUME", basis: "UNITS", productFamily: null, tiersJson: tiers, periodMonths: 12 };
    const e = effectiveNet({ invoiceSpend: D("12000"), units: D("1200"), rebate: r, measured: D("1200") });
    expect(e.rebate.toString()).toBe("600"); // 5 % of spend at the 1000 tier, not 2 % + 5 %
    expect(e.net.toString()).toBe("11400");
    expect(e.toNext!.toString()).toBe("800");
    const amt = effectiveNet({ invoiceSpend: D("30000"), units: D("2500"), rebate: r, measured: D("2500") });
    expect(amt.rebate.toString()).toBe("3750"); // 2500 units × 1.5
    expect(amt.next).toBeNull();
    expect(effectiveNet({ invoiceSpend: D("100"), units: D("10"), rebate: r, measured: D("10") }).rebate.toString()).toBe("0");
  });
  test("basis values: UNITS / VALUE / COMPLIANCE_PCT / GROWTH_PCT (missing percentages count as 0)", () => {
    expect(rebateBasisValue("UNITS", D(7), D(70), null, null).toString()).toBe("7");
    expect(rebateBasisValue("VALUE", D(7), D(70), null, null).toString()).toBe("70");
    expect(rebateBasisValue("COMPLIANCE_PCT", D(7), D(70), D("0.9"), null).toString()).toBe("0.9");
    expect(rebateBasisValue("COMPLIANCE_PCT", D(7), D(70), null, null).toString()).toBe("0");
    expect(rebateBasisValue("GROWTH_PCT", D(7), D(70), null, D("0.12")).toString()).toBe("0.12");
    // A COMPLIANCE_PCT schedule: 95 % delivered vs a 90 % tier → tier reached; 80 % → not.
    const pct = { id: "c", type: "COMPLIANCE", basis: "COMPLIANCE_PCT", productFamily: null, tiersJson: JSON.stringify([{ threshold: 0.9, rebatePct: 0.03 }]), periodMonths: 12 };
    expect(effectiveNet({ invoiceSpend: D("1000"), units: D("10"), rebate: pct, measured: D("0.95") }).rebate.toString()).toBe("30");
    expect(effectiveNet({ invoiceSpend: D("1000"), units: D("10"), rebate: pct, measured: D("0.8") }).rebate.toString()).toBe("0");
  });
  test("bundle qualification: condition on one family (units / value / awarded), benefit on another", () => {
    const lines = [
      { productId: "t1", productFamily: "Trocar Products", quantity: D(600), extended: D("30000"), included: true },
      { productId: "t2", productFamily: "Trocar Products", quantity: D(500), extended: D("20000"), included: false }, // excluded lines never count
      { productId: "s1", productFamily: "Surgical Stapling Products", quantity: D(100), extended: D("50000"), included: true },
    ];
    expect(conditionMet(lines, { productFamily: "trocar products", minUnits: 600 })).toMatchObject({ met: true, units: D(600), value: D("30000") });
    expect(conditionMet(lines, { productFamily: "Trocar Products", minUnits: 601 })).toMatchObject({ met: false, reason: "600 units < 601 required" });
    expect(conditionMet(lines, { productFamily: "Trocar Products", minValue: 30001 })).toMatchObject({ met: false, reason: "30000 value < 30001 required" });
    expect(conditionMet(lines, { productFamily: "Hernia Mesh", awarded: true })).toMatchObject({ met: false, reason: "condition family/SKU not on the proposal" });
    expect(conditionMet(lines, { productId: "s1", awarded: true }).met).toBe(true);
    expect(conditionMet(lines, {}).met).toBe(true); // no condition = met
    const benefit = { productFamily: "Surgical Stapling Products", pricePct: -0.1 };
    expect(benefitApplies(lines[2], benefit)).toBe(true);
    expect(benefitApplies(lines[0], benefit)).toBe(false);
    expect(applyBenefit(D("500"), benefit).toString()).toBe("450");
    expect(applyBenefit(D("500"), { priceAmount: -25 }).toString()).toBe("475");
    expect(applyBenefit(D("500"), { pricePct: -0.1, priceAmount: -5 }).toString()).toBe("445");
    expect(parseBundle("{bad", "{}")).toBeNull();
    expect(parseBundle(JSON.stringify({ minUnits: -1 }), "{}")).toBeNull();
    expect(parseBundle(JSON.stringify({ productFamily: "A", minUnits: 1 }), JSON.stringify({ productFamily: "B", pricePct: -0.05 }))).toEqual({ condition: { productFamily: "A", minUnits: 1 }, benefit: { productFamily: "B", pricePct: -0.05 } });
  });
});

describe.skipIf(!hasDb)("WS2 outcomes — database", () => {
  let rep: Awaited<ReturnType<typeof mkUser>>, dir: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let p1: Awaited<ReturnType<typeof mkProduct>>, p2: Awaited<ReturnType<typeof mkProduct>>;

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rep", ["SALES_REP"]); dir = await mkUser("dir", ["PRICING_DIRECTOR"]);
    await mkPolicy();
    acct = await mkAccount({ name: "outcome acct" });
    p1 = await mkProduct({ sku: "O1", listPrice: "100", cogs: "40" });
    p2 = await mkProduct({ sku: "O2", listPrice: "50", cogs: "20" });
  });
  afterAll(async () => { await cleanupRun(); });

  async function approved(actor = dir) {
    const fx = await mkProposal(actor.actor, { accountId: acct.id, lines: [{ code: `${RUN}W1`, qty: 120, productId: p1.id }, { code: `${RUN}W2`, qty: 60, productId: p2.id }, { code: `${RUN}W3`, qty: 5, productId: null }] });
    await setProposedPrice(actor.actor, fx.lines[0].id, D("90"));
    await setProposedPrice(actor.actor, fx.lines[1].id, D("45"));
    expect((await submitForApproval(actor.actor, fx.proposal.id)).status).toBe("APPROVED");
    fx.lines = await linesOf(fx.proposal.id);
    return fx;
  }

  test("WON: refused until finalisable; then one transaction creates the LOCAL contract (ACTIVE/APPROVED entries, commitments), the outcome and the status; the waterfall now resolves to the won prices", async () => {
    const draft = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}D1`, qty: 1, productId: p1.id }] });
    await expect(recordOutcome(rep.actor, draft.proposal.id, { outcome: "WON" })).rejects.toThrow(/Cannot mark as won: 1 line\(s\) awaiting or denied approval/);
    await expect(recordOutcome(rep.actor, draft.proposal.id, { outcome: "MAYBE" as never })).rejects.toThrow(/outcome must be WON, LOST or NO_DECISION/);
    await expect(recordOutcome(rep.actor, draft.proposal.id, { outcome: "LOST" })).rejects.toThrow(/Cannot mark a draft proposal as lost/);
    const fx = await approved();
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON", contractMonths: 0 })).rejects.toThrow(/between 1 and 120/);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON", contractMonths: 121 })).rejects.toThrow(/between 1 and 120/);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON", contractMonths: 1.5 })).rejects.toThrow(/whole number/);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON", finalValue: "abc" })).rejects.toThrow(/finalValue must be a non-negative number/);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON", finalValue: "-1" })).rejects.toThrow(/non-negative/);
    expect(await prisma.contract.count({ where: { externalId: fx.proposal.id } })).toBe(0); // nothing created by the refusals
    const r = await recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON", contractMonths: 24 });
    expect(r.contract!.contractNumber).toBe(contractNumberFor({ reference: fx.proposal.reference, account: { accountNumber: acct.accountNumber, id: acct.id } }));
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: r.contract!.id }, include: { entries: true, commitments: true } });
    expect(c).toMatchObject({ type: "LOCAL", status: "ACTIVE", accountId: acct.id, currency: "USD", sourceSystem: "crosswalk", externalId: fx.proposal.id });
    const months = (c.effectiveTo!.getFullYear() - c.effectiveFrom.getFullYear()) * 12 + c.effectiveTo!.getMonth() - c.effectiveFrom.getMonth();
    expect(months).toBe(24);
    expect(c.entries.map((e) => `${e.productId === p1.id ? "O1" : "O2"}:${e.price}:${e.status}:${e.approvalState}:${e.source}`).sort()).toEqual(["O1:90:ACTIVE:APPROVED:proposal", "O2:45:ACTIVE:APPROVED:proposal"]);
    expect(c.commitments.map((k) => `${k.productId === p1.id ? "O1" : "O2"}:${k.committedUnits}:${k.committedValue}`).sort()).toEqual(["O1:120:10800", "O2:60:2700"]);
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id }, include: { outcome: true } });
    expect(p.status).toBe("WON");
    expect(p.lockedAt).not.toBeNull();
    expect(p.outcome).toMatchObject({ outcome: "WON", finalValue: expect.anything() });
    expect(money(p.outcome!.finalValue)!.toString()).toBe("13500"); // economics revenue: 90×120 + 45×60
    expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: fx.proposal.id, action: "OUTCOME_WON" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityType: "Contract", entityId: c.id, action: "CREATED_FROM_PROPOSAL" } })).toBe(1);
    // The waterfall for this account now resolves to the won price.
    const ctx = await loadPricingContext({ accountId: acct.id });
    const res = ctx.resolvePrice({ id: p1.id, sku: p1.sku, category: p1.category, listPrice: p1.listPrice, currency: "USD", prices: [] }, D(1));
    expect(res).toMatchObject({ source: "LOCAL", contractId: c.id });
    expect(res.price!.toString()).toBe("90");
    // Repeat requests: the proposal is closed; contractFromProposal itself is idempotent.
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" })).rejects.toThrow(/already won/);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "LOST" })).rejects.toThrow(/already won/);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "NO_DECISION" })).rejects.toThrow(/already won/);
    expect((await contractFromProposal(rep.actor, fx.proposal.id, 12)).id).toBe(c.id);
    expect(await prisma.contract.count({ where: { externalId: fx.proposal.id } })).toBe(1);
    expect(await prisma.dealOutcome.count({ where: { proposalId: fx.proposal.id } })).toBe(1);
    expect((await finalizeCheck(fx.proposal.id)).ok).toBe(true);
  });

  test("WON is atomic: a failure after the contract is created rolls the contract, its entries and the status back", async () => {
    const fx = await approved();
    const r = await withTxFailure({ model: "dealOutcome", method: "upsert" }, () => recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" }));
    expect(r.error?.message).toMatch(/injected failure/);
    expect(r.calls).toBe(1);
    expect(await prisma.contract.count({ where: { externalId: fx.proposal.id } })).toBe(0);
    expect(await prisma.priceEntry.count({ where: { contract: { externalId: fx.proposal.id } } })).toBe(0);
    expect(await prisma.dealOutcome.count({ where: { proposalId: fx.proposal.id } })).toBe(0);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } })).status).toBe("APPROVED");
    expect(await prisma.auditEvent.count({ where: { entityId: fx.proposal.id, action: "OUTCOME_WON" } })).toBe(0);
    // A failure on the contract entries likewise leaves no contract behind.
    const r2 = await withTxFailure({ model: "priceEntry", method: "createMany" }, () => recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" }));
    expect(r2.error?.message).toMatch(/injected failure/);
    expect(await prisma.contract.count({ where: { externalId: fx.proposal.id } })).toBe(0);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } })).status).toBe("APPROVED");
    // And then the close succeeds normally.
    expect((await recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" })).contract).not.toBeNull();
  });

  test("simultaneous closes (WON + WON, WON + LOST) → exactly one wins; one contract, one outcome", async () => {
    for (const second of ["WON", "LOST"] as const) {
      const fx = await approved();
      const results = await Promise.allSettled([recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" }), recordOutcome(rep.actor, fx.proposal.id, { outcome: second, competitorName: `${RUN} Rival` })]);
      expect(results.filter((x) => x.status === "fulfilled").length, second).toBe(1);
      const loser = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason.message).toMatch(/already (won|lost|closed)/);
      const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id }, include: { outcome: true } });
      expect(["WON", "LOST"]).toContain(p.status);
      expect(p.outcome!.outcome).toBe(p.status);
      expect(await prisma.contract.count({ where: { externalId: fx.proposal.id } })).toBe(p.status === "WON" ? 1 : 0);
      expect(await prisma.dealOutcome.count({ where: { proposalId: fx.proposal.id } })).toBe(1);
    }
  });

  test("LOST records the competitor's winning prices as WIN_LOSS_RECORD observations and withdraws pending requests; NO_DECISION leaves the proposal open; one outcome row per proposal", async () => {
    const fx = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}L1`, qty: 10, productId: p1.id }, { code: `${RUN}L2`, qty: 10, productId: p2.id }] });
    await setProposedPrice(rep.actor, fx.lines[0].id, D("60")); // 40 % off → director: routed
    await setProposedPrice(rep.actor, fx.lines[1].id, D("45"));
    expect((await submitForApproval(rep.actor, fx.proposal.id)).status).toBe("SUBMITTED");
    // NO_DECISION: an outcome row, status unchanged, still open.
    const nd = await recordOutcome(rep.actor, fx.proposal.id, { outcome: "NO_DECISION", notes: "budget frozen" });
    expect(nd.outcome.outcome).toBe("NO_DECISION");
    expect(nd.contract).toBeNull();
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } })).status).toBe("SUBMITTED");
    // LOST with winning prices.
    const before = await prisma.competitorPriceObservation.count({ where: { sourceType: "WIN_LOSS_RECORD", accountId: acct.id } });
    const lost = await recordOutcome(rep.actor, fx.proposal.id, { outcome: "LOST", competitorName: `${RUN} Rival`, priceReason: "undercut", competitorWinningPrices: [{ competitorCode: `${RUN}L1`, price: "55" }, { competitorCode: `${RUN}L2`, price: "40" }] });
    expect(lost.outcome.outcome).toBe("LOST");
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id }, include: { outcome: true, approvals: true } });
    expect(p.status).toBe("LOST");
    expect(p.outcome!.outcome).toBe("LOST"); // the NO_DECISION row was updated, not duplicated
    expect(await prisma.dealOutcome.count({ where: { proposalId: fx.proposal.id } })).toBe(1);
    expect(p.approvals.map((a) => a.status)).toEqual(["WITHDRAWN"]);
    const obs = await prisma.competitorPriceObservation.findMany({ where: { sourceType: "WIN_LOSS_RECORD", accountId: acct.id }, orderBy: { price: "asc" } });
    expect(obs.length - before).toBe(2);
    expect(obs.map((o) => `${o.competitorSku}:${o.price}:${o.sourceRef}`)).toEqual([`${RUN}L2:40:${fx.proposal.reference} lost`.toUpperCase().replace(" LOST", " lost"), `${RUN}L1:55:${fx.proposal.reference} lost`.toUpperCase().replace(" LOST", " lost")]);
    expect(obs[0].proposalLineId).toBe(fx.lines[1].id);
    expect(await prisma.contract.count({ where: { externalId: fx.proposal.id } })).toBe(0);
    await expect(recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" })).rejects.toThrow(/already lost/);
    // A positive price is required for an observation; a bad winning price fails after the close (append-only intelligence, logged in the audit trail as the LOST outcome).
    expect(await prisma.auditEvent.count({ where: { entityId: fx.proposal.id, action: "OUTCOME_LOST" } })).toBe(1);
  });

  test("compliance: ON_TRACK / AT_RISK (< 0.8 × elapsed share) / MISSED / MET / NOT_STARTED from purchase records at, below and above the thresholds", async () => {
    const start = day("2026-01-01"), end = day("2027-01-01"); // 365 days
    const c = await mkContract({ number: "CP-1", type: "LOCAL", accountId: acct.id, effectiveFrom: start, effectiveTo: end });
    const k = await prisma.contractCommitment.create({ data: { contractId: c.id, productId: p1.id, committedUnits: "1200", committedValue: "108000", periodStart: start, periodEnd: end } });
    const half = new Date(start.getTime() + 182.5 * 86_400_000); // elapsed exactly 0.5 → AT_RISK below 0.4 delivered
    const buy = async (units: string) => { await prisma.purchaseRecord.deleteMany({ where: { contractId: c.id } }); if (units !== "0") await prisma.purchaseRecord.create({ data: { accountId: acct.id, productId: p1.id, sku: p1.sku, quantity: units, netPrice: "90", invoiceDate: day("2026-03-01"), contractId: c.id } }); };
    const statusAt = async (asOf: Date) => (await contractPerformance(c.id, asOf)).commitments.find((x) => x.commitmentId === k.id)!;
    await buy("480"); expect((await statusAt(half))).toMatchObject({ status: "ON_TRACK", unitsPct: "0.4", elapsedPct: "0.5" }); // exactly 0.8 × 0.5: not behind
    await buy("479"); expect((await statusAt(half)).status).toBe("AT_RISK");
    await buy("481"); expect((await statusAt(half)).status).toBe("ON_TRACK");
    await buy("1200"); expect((await statusAt(half)).status).toBe("MET");
    await buy("1199"); expect((await statusAt(end)).status).toBe("MISSED");
    await buy("1200"); expect((await statusAt(end)).status).toBe("MET");
    await buy("0"); expect((await statusAt(new Date(start.getTime() + 30 * 86_400_000))).status).toBe("NOT_STARTED"); // 8 % elapsed
    await buy("0"); expect((await statusAt(half)).status).toBe("AT_RISK"); // 0 delivered halfway through
    const perf = await contractPerformance(c.id, half);
    expect(perf.flags).toContain("Commitment " + p1.id + " at risk: 0% delivered with 50% of the period elapsed");
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).performanceJson).not.toBeNull(); // cached snapshot
    // A commitment with no target at all is NOT_STARTED whatever was bought.
    const none = await prisma.contractCommitment.create({ data: { contractId: c.id, productFamily: `${RUN} Family`, periodStart: start, periodEnd: end } });
    await buy("100");
    expect((await contractPerformance(c.id, half)).commitments.find((x) => x.commitmentId === none.id)!.status).toBe("NOT_STARTED");
    await prisma.contractCommitment.delete({ where: { id: none.id } });
  });

  test("rebates in performance: highest satisfied tier per basis (UNITS, VALUE, COMPLIANCE_PCT); 'within 10 %' flag; renewal within 90 days flag vs the 180-day pipeline", async () => {
    const start = day("2026-01-01"), end = day("2027-01-01");
    const c = await mkContract({ number: "RB-1", type: "LOCAL", accountId: acct.id, effectiveFrom: start, effectiveTo: end });
    await prisma.contractCommitment.create({ data: { contractId: c.id, productId: p1.id, committedUnits: "1000", periodStart: start, periodEnd: end } });
    const units = await prisma.rebateSchedule.create({ data: { contractId: c.id, type: "VOLUME", basis: "UNITS", tiersJson: JSON.stringify([{ threshold: 500, rebatePct: 0.02 }, { threshold: 1000, rebatePct: 0.05 }]) } });
    const value = await prisma.rebateSchedule.create({ data: { contractId: c.id, type: "VOLUME", basis: "VALUE", tiersJson: JSON.stringify([{ threshold: 40000, rebateAmount: 1 }]) } });
    const compliance = await prisma.rebateSchedule.create({ data: { contractId: c.id, type: "COMPLIANCE", basis: "COMPLIANCE_PCT", tiersJson: JSON.stringify([{ threshold: 0.9, rebatePct: 0.03 }]) } });
    const growth = await prisma.rebateSchedule.create({ data: { contractId: c.id, type: "GROWTH", basis: "GROWTH_PCT", tiersJson: JSON.stringify([{ threshold: 0.1, rebatePct: 0.01 }]) } });
    const buy = async (n: string) => { await prisma.purchaseRecord.deleteMany({ where: { contractId: c.id } }); await prisma.purchaseRecord.create({ data: { accountId: acct.id, productId: p1.id, sku: p1.sku, quantity: n, netPrice: "90", invoiceDate: day("2026-04-01"), contractId: c.id } }); };
    await buy("480"); // spend 43,200
    let perf = await contractPerformance(c.id, day("2026-06-01"));
    const by = (id: string) => perf.rebates.find((r) => r.rebateId === id)!;
    expect(by(units.id)).toMatchObject({ measured: "480", tier: null, toNext: "20", rebate: "0", net: "43200" });
    expect(perf.flags.some((f) => f.startsWith("Rebate tier approaching: 20 more units"))).toBe(true); // 20 ≤ 10 % of 480
    expect(by(value.id)).toMatchObject({ measured: "43200", rebate: "480", net: "42720" }); // 480 units × $1 at the 40,000 tier
    expect(by(compliance.id)).toMatchObject({ measured: "0.48", rebate: "0" }); // 480 / 1000 delivered — below the 90 % tier
    expect(by(growth.id)).toMatchObject({ measured: "0", rebate: "0" }); // no prior-period baseline: documented gap
    await buy("950");
    perf = await contractPerformance(c.id, day("2026-06-01"));
    expect(by(units.id)).toMatchObject({ measured: "950", rebate: "1710", toNext: "50" }); // 2 % of 85,500; 50 ≤ 95 → approaching
    expect(by(compliance.id)).toMatchObject({ measured: "0.95", rebate: "2565" }); // 3 % of 85,500
    expect(perf.flags.filter((f) => f.startsWith("Rebate tier approaching")).length).toBe(1);
    await buy("400"); // 36,000: 100 to the 500 tier is 25 % of 400 — not "approaching"
    perf = await contractPerformance(c.id, day("2026-06-01"));
    expect(perf.flags.filter((f) => f.startsWith("Rebate tier approaching")).length).toBe(0);
    // Renewal: flagged by performance only within 90 days of expiry; the pipeline default window is 180 days.
    expect((await contractPerformance(c.id, day("2026-09-01"))).flags.some((f) => f.includes("renewal due"))).toBe(false); // 122 days out
    expect((await contractPerformance(c.id, day("2026-10-15"))).flags.some((f) => f.includes("Contract expires 2027-01-01 — renewal due"))).toBe(true); // 78 days out
    const pipeline180 = await renewalPipeline(180, { contractNumber: { startsWith: `${RUN}-` } });
    expect(pipeline180.map((r) => r.contractNumber)).toContain(c.contractNumber);
    expect(pipeline180.find((r) => r.contractNumber === c.contractNumber)!.flags.some((f) => f.includes("renewal due"))).toBe(true); // last cached snapshot (2026-10-15)
    const pipeline30 = await renewalPipeline(30, { contractNumber: { startsWith: `${RUN}-` } });
    expect(pipeline30.map((r) => r.contractNumber)).not.toContain(c.contractNumber);
  });

  test("proposal conversion: annual quantities pro-rated to the elapsed months since the decision, per line and per family", async () => {
    const fx = await approved();
    const r = await recordOutcome(rep.actor, fx.proposal.id, { outcome: "WON" });
    const decided = (await prisma.dealOutcome.findUniqueOrThrow({ where: { proposalId: fx.proposal.id } })).decidedAt;
    const asOf = new Date(decided.getTime() + 3 * 30.44 * 86_400_000); // 3 months later
    await prisma.purchaseRecord.createMany({ data: [
      { accountId: acct.id, productId: p1.id, sku: p1.sku, quantity: "15", netPrice: "90", invoiceDate: new Date(decided.getTime() + 86_400_000), contractId: r.contract!.id, proposalId: fx.proposal.id },
      { accountId: acct.id, productId: p1.id, sku: p1.sku.toLowerCase(), quantity: "15", netPrice: "90", invoiceDate: new Date(decided.getTime() + 2 * 86_400_000), contractId: r.contract!.id, proposalId: fx.proposal.id }, // SKU match is case-insensitive
      { accountId: acct.id, productId: p2.id, sku: p2.sku, quantity: "5", netPrice: "45", invoiceDate: new Date(decided.getTime() - 86_400_000), proposalId: fx.proposal.id }, // before the decision: not counted
    ] });
    const cv = await proposalConversion(fx.proposal.id, asOf);
    expect(cv.monthsElapsed).toBeCloseTo(3, 6);
    const l1 = cv.lines.find((l) => l.sku === p1.sku)!, l2 = cv.lines.find((l) => l.sku === p2.sku)!;
    expect(l1.expectedUnitsToDate).toBe("30"); // 120 × 3 / 12
    expect(l1.actualUnits).toBe("30");
    expect(l1.conversionPct).toBe("1");
    expect(l1.expectedRevenue).toBe("2700");
    expect(l1.actualRevenue).toBe("2700");
    expect(l1.expectedMargin).toBe("1500"); // 30 × (90 − 40)
    expect(l1.actualMargin).toBe("1500");
    expect(l1.converted).toBe(true);
    expect(l2.expectedUnitsToDate).toBe("15");
    expect(l2.actualUnits).toBe("0");
    expect(l2.converted).toBe(false);
    expect(cv.conversionPct).toBe(D("30").div("45").toString());
    expect(cv.linesConverted).toBe(1);
    expect(cv.linesTotal).toBe(2);
    expect(cv.byFamily).toEqual([{ family: `${RUN} Family`, expectedUnits: "45", actualUnits: "30", conversionPct: D("30").div("45").toString() }]);
    // Beyond 12 months the expectation caps at the annual quantity.
    const late = await proposalConversion(fx.proposal.id, new Date(decided.getTime() + 20 * 30.44 * 86_400_000));
    expect(late.lines.find((l) => l.sku === p1.sku)!.expectedUnitsToDate).toBe("120");
    expect(ZERO.isZero()).toBe(true);
  });
});

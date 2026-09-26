/**
 * WS2 — context drift (every trigger reported; refresh only an unlocked draft; approved proposals
 * never change) and quote-level freight / tax (modes, bounds, the AvaTax fake, the staleness
 * fingerprint, totals, margins untouched, the fresh-tax gate on export).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { D, money, round } from "@/lib/money";
import { driftFor, refreshContext } from "@/lib/proposals/drift";
import { setProposedPrice, setLineIncluded, refreshEconomics } from "@/lib/proposals/service";
import { submitForApproval, finalizeCheck } from "@/lib/approvals/service";
import { setProposalLogistics, calculateProposalTax, quoteTotals, taxFingerprint, computeFreight, parseAddress } from "@/lib/tax";
import { setAvataxFetchForTests } from "@/lib/tax/avatax";
import { buildQuote } from "@/lib/proposals/export";
import { buildQuotePdf } from "@/lib/pdf";
import { RUN, day, mkUser, mkProduct, mkAccount, mkGpo, mkMembership, mkContract, mkProposal, mkPolicy, linesOf, cleanupRun } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const fields = (d: Awaited<ReturnType<typeof driftFor>>) => ({ proposal: d.proposal.map((c) => `${c.field}:${c.note ?? ""}`), lines: Object.fromEntries(d.lines.map((l) => [l.competitorCode, l.changes.map((c) => c.field).sort()])) });

describe.skipIf(!hasDb)("WS2 drift — every trigger is reported, only an unlocked draft is refreshed", () => {
  let rep: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let g: Awaited<ReturnType<typeof mkGpo>>;
  let prod: Awaited<ReturnType<typeof mkProduct>>;
  let fx: Awaited<ReturnType<typeof mkProposal>>;
  let gpoContract: Awaited<ReturnType<typeof mkContract>>;
  const CODE = `${RUN}D1`.toUpperCase();

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rep", ["SALES_REP"]);
    await mkPolicy();
    acct = await mkAccount({ name: "drift acct" });
    g = await mkGpo("drift gpo");
    await mkMembership(acct.id, g.id, "Tier 1", day("2024-01-01"));
    prod = await mkProduct({ sku: "DR1", listPrice: "1000", cogs: "400" });
    gpoContract = await mkContract({ number: "DR-GPO", type: "GPO", gpoId: g.id, tier: "Tier 1", entries: [{ productId: prod.id, price: "800" }] });
    fx = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: CODE, qty: 10, productId: prod.id }] });
    expect(fx.lines[0].contractPriceSource).toBe("GPO");
    expect(money(fx.lines[0].contractPrice)!.toString()).toBe("800");
  });
  afterAll(async () => { await cleanupRun(); });

  test("a fresh draft has no drift", async () => {
    const d = await driftFor(fx.proposal.id);
    expect(d.editable).toBe(true);
    expect(d.proposal).toEqual([]);
    expect(d.lines).toEqual([]);
    expect(d.summary).toEqual({ lines: 1, drifted: 0, byField: {}, belowNewFloor: 0 });
  });

  test("membership change → GPO snapshot drift and the line's contract price drift; the snapshot itself is untouched", async () => {
    const m = await prisma.gpoMembership.findFirstOrThrow({ where: { accountId: acct.id } });
    await prisma.gpoMembership.update({ where: { id: m.id }, data: { effectiveTo: day("2026-01-01") } });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(fields(d).proposal).toEqual(["policy:GPO membership changed"]);
      expect(fields(d).lines[CODE]).toEqual(["contractPrice"]);
      expect(d.lines[0].changes[0]).toMatchObject({ field: "contractPrice", from: "800", to: null, note: "no contract price applies now" });
      expect(money((await linesOf(fx.proposal.id))[0].contractPrice)!.toString()).toBe("800");
    } finally { await prisma.gpoMembership.update({ where: { id: m.id }, data: { effectiveTo: null } }); }
  });

  test("a new LOCAL contract → proposal contract drift and a line contract price drift with the new source", async () => {
    const loc = await mkContract({ number: "DR-LOC", type: "LOCAL", accountId: acct.id, entries: [{ productId: prod.id, price: "750" }] });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(fields(d).proposal).toEqual(["contractPriceSource:account's local contract changed"]);
      expect(d.lines[0].changes).toEqual([{ field: "contractPrice", from: "800", to: "750", note: "now from LOCAL" }]);
    } finally { await prisma.contract.delete({ where: { id: loc.id } }); }
  });

  test("a contract price change (superseding entry) → contract price drift; a list price change → list price drift and floor unchanged", async () => {
    const e = gpoContract.entries[0];
    await prisma.priceEntry.update({ where: { id: e.id }, data: { price: "790" } });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(d.lines[0].changes).toEqual([{ field: "contractPrice", from: "800", to: "790", note: "now from GPO" }]);
    } finally { await prisma.priceEntry.update({ where: { id: e.id }, data: { price: "800" } }); }
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { listPrice: "1100" } });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(fields(d).lines[CODE]).toEqual(["listPrice"]);
      expect(d.lines[0].changes[0]).toMatchObject({ from: "1000", to: "1100" });
    } finally { await prisma.ownProduct.update({ where: { id: prod.id }, data: { listPrice: "1000" } }); }
  });

  test("a cost change → cost and floor drift, with the below-new-floor count", async () => {
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { cogs: "700" } }); // floor 700/0.7 = 1000 > proposed
    try {
      const d = await driftFor(fx.proposal.id);
      expect(fields(d).lines[CODE]).toEqual(["cost", "floorPrice"]);
      expect(d.lines[0].changes.find((c) => c.field === "floorPrice")).toMatchObject({ from: "571.43", to: "1000" });
      expect(d.summary.belowNewFloor).toBe(1);
    } finally { await prisma.ownProduct.update({ where: { id: prod.id }, data: { cogs: "400" } }); }
  });

  test("a policy activation → policy drift (and a floor drift when the minimum margin moved)", async () => {
    const old = await prisma.pricingPolicy.findFirstOrThrow({ where: { productFamily: `${RUN} Family`, status: "ACTIVE" } });
    const v2 = await mkPolicy(`${RUN} Family`, { minMarginPct: 0.4 });
    await prisma.pricingPolicy.update({ where: { id: old.id }, data: { status: "SUPERSEDED" } });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(fields(d).lines[CODE]).toEqual(["floorPrice", "policy"]);
      expect(d.lines[0].changes.find((c) => c.field === "policy")).toMatchObject({ from: old.id, to: v2.id });
      expect(d.lines[0].changes.find((c) => c.field === "floorPrice")).toMatchObject({ from: "571.43", to: "666.67" }); // 400/0.6
    } finally { await prisma.pricingPolicy.delete({ where: { id: v2.id } }); await prisma.pricingPolicy.update({ where: { id: old.id }, data: { status: "ACTIVE" } }); }
  });

  test("a crosswalk publication → proposal version drift; a published equivalence for the pair → line equivalence drift", async () => {
    const current = await prisma.crosswalkVersion.findFirstOrThrow({ where: { status: "PUBLISHED" } });
    const max = await prisma.crosswalkVersion.aggregate({ _max: { number: true } });
    const next = await prisma.crosswalkVersion.create({ data: { number: (max._max.number ?? 0) + 1, status: "PUBLISHED", publishedAt: new Date(), notes: `${RUN} test` } });
    await prisma.crosswalkVersion.update({ where: { id: current.id }, data: { status: "SUPERSEDED" } });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(fields(d).proposal).toEqual([`equivalence:crosswalk v${next.number} is now published`]);
      expect(d.lines).toEqual([]); // the pair is not in the new version either: still NONE
      await prisma.crosswalkVersionEntry.create({ data: { versionId: next.id, knownCrossId: `${RUN}-kc`, ownSku: prod.sku, competitorName: "Rival", competitorCodeNorm: CODE, matchType: "Exact Match", equivalenceLevel: "EXACT" } });
      const d2 = await driftFor(fx.proposal.id);
      expect(fields(d2).lines[CODE]).toEqual(["equivalence"]);
      expect(d2.lines[0].changes[0]).toMatchObject({ from: "NONE", to: "EXACT", note: "published cross changed" });
    } finally {
      await prisma.crosswalkVersion.delete({ where: { id: next.id } });
      await prisma.crosswalkVersion.update({ where: { id: current.id }, data: { status: "PUBLISHED" } });
    }
  });

  test("product retirement → product drift; refresh excludes the line and says why", async () => {
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { status: "Not in Commercial Distribution" } });
    try {
      const d = await driftFor(fx.proposal.id);
      expect(d.lines[0].changes).toEqual([{ field: "product", from: "active", to: "not in commercial distribution", note: "SKU can no longer be quoted" }]);
    } finally { await prisma.ownProduct.update({ where: { id: prod.id }, data: { status: "In Commercial Distribution" } }); }
  });

  test("refreshContext re-snapshots an unlocked draft (proposed price kept, economics and approval state recomputed, audited); a locked or approved proposal is only reported on", async () => {
    await setProposedPrice(rep.actor, fx.lines[0].id, D("790"));
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { cogs: "700" } }); // floor → 1000: 790 is now below floor
    const r = await refreshContext(rep.actor, fx.proposal.id);
    expect(r.refreshed).toBe(1);
    const l = (await linesOf(fx.proposal.id))[0];
    expect(money(l.proposedPrice)!.toString()).toBe("790"); // the rep's price is kept
    expect(money(l.cost)!.toString()).toBe("700");
    expect(money(l.floorPrice)!.toString()).toBe("1000");
    expect(l.approvalState).toBe("REQUIRED");
    expect(l.requiredAuthority).toBe("PRICING_COMMITTEE");
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } });
    expect(p.lockedAt).toBeNull();
    const econ = JSON.parse(p.economicsJson!);
    expect(econ.approvalsRequired).toBe(1); // the stored rollup reflects the recomputed line states
    expect(econ.cogs).toBe("7000");
    const ev = await prisma.auditEvent.findFirst({ where: { entityType: "Proposal", entityId: fx.proposal.id, action: "CONTEXT_REFRESHED" } });
    expect(ev).not.toBeNull();
    expect(JSON.parse(ev!.beforeJson!).lines[0].changes.map((c: { field: string }) => c.field).sort()).toEqual(["cost", "floorPrice"]);
    expect((await driftFor(fx.proposal.id)).lines).toEqual([]);
    expect(await refreshContext(rep.actor, fx.proposal.id)).toMatchObject({ refreshed: 0 }); // nothing to do

    // Submitted (locked): reported, never refreshed.
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { cogs: "400" } });
    expect((await refreshContext(rep.actor, fx.proposal.id)).refreshed).toBe(1); // cost back to 400, floor 571.43
    await setProposedPrice(rep.actor, fx.lines[0].id, D("780"));
    const sub = await submitForApproval(rep.actor, fx.proposal.id);
    expect(sub.status).toBe("APPROVED"); // 780 is 2.5 % below the GPO price: rep authority
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { cogs: "700" } });
    const d = await driftFor(fx.proposal.id);
    expect(d.editable).toBe(false);
    expect(d.status).toBe("APPROVED");
    expect(fields(d).lines[CODE]).toEqual(["cost", "floorPrice"]);
    await expect(refreshContext(rep.actor, fx.proposal.id)).rejects.toThrow(/only an unlocked draft can be refreshed/);
    const after = (await linesOf(fx.proposal.id))[0];
    expect(money(after.cost)!.toString()).toBe("400");
    expect(money(after.proposedPrice)!.toString()).toBe("780");
    expect(after.approvalState).toBe("NOT_REQUIRED"); // within rep authority: nothing to approve, nothing re-derived
    await prisma.ownProduct.update({ where: { id: prod.id }, data: { cogs: "400" } });
  });
});

describe.skipIf(!hasDb)("WS2 tax & freight — modes, fingerprint, totals, AvaTax fake, export gate", () => {
  let director: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let fx: Awaited<ReturnType<typeof mkProposal>>;
  let prod: Awaited<ReturnType<typeof mkProduct>>;
  const env: Record<string, string | undefined> = {};
  const avataxCalls: { url: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    await cleanupRun();
    director = await mkUser("dir", ["PRICING_DIRECTOR"]);
    await mkPolicy();
    acct = await mkAccount({ name: "tax acct", shipToJson: JSON.stringify({ line1: "9 Account Rd", city: "Austin", region: "TX", postalCode: "78701", country: "US" }) });
    prod = await mkProduct({ sku: "TX1", listPrice: "100", cogs: "40" });
    const prod2 = await mkProduct({ sku: "TX2", listPrice: "50", cogs: "20" });
    fx = await mkProposal(director.actor, { accountId: acct.id, lines: [{ code: `${RUN}T1`, qty: 10, productId: prod.id }, { code: `${RUN}T2`, qty: 4, productId: prod2.id }] });
    await setProposedPrice(director.actor, fx.lines[0].id, D("90"));
    await setProposedPrice(director.actor, fx.lines[1].id, D("45"));
    for (const k of ["AVATAX_ACCOUNT_ID", "AVATAX_LICENSE_KEY", "AVATAX_COMPANY_CODE", "AVATAX_ENV", "TAX_DRY_RUN", "TAX_FREIGHT"]) env[k] = process.env[k];
    process.env.AVATAX_ACCOUNT_ID = "acct-test"; process.env.AVATAX_LICENSE_KEY = "key-test"; process.env.AVATAX_COMPANY_CODE = "CROSSWALK"; process.env.AVATAX_ENV = "sandbox"; delete process.env.TAX_DRY_RUN; delete process.env.TAX_FREIGHT;
    setAvataxFetchForTests(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      avataxCalls.push({ url, body });
      const lines = (body.lines as { number: string; amount: number }[]).map((l) => ({ lineNumber: l.number, tax: Math.round(l.amount * 8.25) / 100, taxableAmount: l.amount, details: [{ rate: 0.0625 }, { rate: 0.02 }] }));
      const totalTax = lines.reduce((s, l) => s + l.tax, 0);
      return new Response(JSON.stringify({ id: 1, code: "Q1", status: "Temporary", totalTax, totalTaxable: lines.reduce((s, l) => s + l.taxableAmount, 0), totalExempt: 0, totalAmount: 0, lines, summary: [{ jurisName: "TEXAS", taxName: "TX STATE TAX", rate: 0.0625, tax: totalTax }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
  });
  afterAll(async () => {
    setAvataxFetchForTests(null);
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanupRun();
  });

  test("freight: NONE / FLAT / PCT (≤ 100 %), bounds, and the total = subtotal + freight (+ tax)", async () => {
    let t = await quoteTotals(fx.proposal.id);
    expect(t.subtotal.toString()).toBe("1080"); // 90×10 + 45×4
    expect(t.freight.toString()).toBe("0");
    expect(t.tax).toBeNull();
    expect(t.total.toString()).toBe("1080");
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "FLAT", freightValue: "25.555" });
    t = await quoteTotals(fx.proposal.id);
    expect(t.freight.toString()).toBe("25.56"); // rounded half-even at the minor unit (5 odd → up)
    expect(t.total.toString()).toBe("1105.56");
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "PCT", freightValue: "2.5" });
    t = await quoteTotals(fx.proposal.id);
    expect(t.freight.toString()).toBe("27"); // 2.5 % of 1080
    expect(t.total.toString()).toBe("1107");
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { freightValue: "100.01" })).rejects.toThrow(/freight percent must be 0–100/);
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "PCT", freightValue: "-1" })).rejects.toThrow(/non-negative/);
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { freightValue: "NaN" })).rejects.toThrow(/non-negative number/);
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "AIR" })).rejects.toThrow(/freightMode must be one of NONE, FLAT, PCT/);
    // A FLAT 5000 switched to PCT is refused: 5000 % is not a freight charge.
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "FLAT", freightValue: "5000" });
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "PCT" })).rejects.toThrow(/freight percent must be 0–100/);
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "NONE" });
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } })).freightValue).toBeNull();
    expect(computeFreight(D("1000"), "PCT", D("100"), "USD").toString()).toBe("1000");
    expect(computeFreight(D("1000"), "FLAT", null, "USD").toString()).toBe("0");
  });

  test("tax modes: NONE → no figure; EXEMPT → 0 with a note; MANUAL rate ≤ 0.5 and decimal arithmetic; PROVIDER needs configuration", async () => {
    await expect(calculateProposalTax(director.actor, fx.proposal.id)).rejects.toThrow(/Tax mode is NONE/);
    await setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "EXEMPT", taxExemptionNo: "TX-EX-123" });
    let t = await quoteTotals(fx.proposal.id);
    expect(t.tax!.toString()).toBe("0");
    expect(t.taxStale).toBe(false);
    expect(t.total.toString()).toBe("1080");
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "MANUAL", taxRate: "0.51" })).rejects.toThrow(/taxRate is a fraction between 0 and 0.5/);
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "MANUAL", taxRate: "-0.1" })).rejects.toThrow(/between 0 and 0.5/);
    await expect(setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "VAT" })).rejects.toThrow(/taxMode must be one of NONE, EXEMPT, MANUAL, PROVIDER/);
    await setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "MANUAL", taxRate: "0.0825", taxExemptionNo: null });
    t = await quoteTotals(fx.proposal.id);
    expect(t.taxStale).toBe(true); // a mode change drops the old figure: recalculate before quoting
    expect(t.tax).toBeNull();
    const { result } = await calculateProposalTax(director.actor, fx.proposal.id);
    expect(result.provider).toBe("manual");
    // 900 × 0.0825 = 74.25; 180 × 0.0825 = 14.85 → 89.10 (per-line rounding, exact here)
    expect(result.totalTax).toBe("89.1");
    t = await quoteTotals(fx.proposal.id);
    expect(t.tax!.toString()).toBe("89.1");
    expect(t.taxStale).toBe(false);
    expect(t.total.toString()).toBe("1169.1");
    const ev = await prisma.auditEvent.findFirst({ where: { entityType: "Proposal", entityId: fx.proposal.id, action: "TAX_CALCULATED" }, orderBy: { at: "desc" } });
    expect(JSON.parse(ev!.afterJson!)).toMatchObject({ provider: "manual", taxAmount: "89.1", subtotal: "1080" });
    // PROVIDER mode is refused when AvaTax is not configured.
    const saved = process.env.AVATAX_LICENSE_KEY; delete process.env.AVATAX_LICENSE_KEY;
    try { await expect(setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "PROVIDER" })).rejects.toThrow(/PROVIDER mode needs a configured tax service/); } finally { process.env.AVATAX_LICENSE_KEY = saved; }
  });

  test("tax and freight never enter line economics or margin", async () => {
    const before = await refreshEconomics(fx.proposal.id);
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "FLAT", freightValue: "500" });
    await calculateProposalTax(director.actor, fx.proposal.id);
    const after = await refreshEconomics(fx.proposal.id);
    expect(after.revenue.toString()).toBe(before.revenue.toString());
    expect(after.grossProfit.toString()).toBe(before.grossProfit.toString());
    expect(after.blendedMarginPct!.toString()).toBe(before.blendedMarginPct!.toString());
    const l = (await linesOf(fx.proposal.id))[0];
    expect(money(l.marginPct)!.toString()).toBe("0.555556"); // (90−40)/90 stored at Decimal(12,6), untouched by freight or tax
    const t = await quoteTotals(fx.proposal.id);
    expect(t.total.toString()).toBe(t.subtotal.plus(t.freight).plus(t.tax!).toString());
    expect(t.total.toString()).toBe("1669.1");
  });

  test("the tax fingerprint goes stale on price / quantity / inclusion / freight / settings / ship-to changes, and NOT on unrelated changes", async () => {
    const fresh = async () => (await quoteTotals(fx.proposal.id)).taxStale === false;
    await calculateProposalTax(director.actor, fx.proposal.id);
    expect(await fresh()).toBe(true);
    // Unrelated: notes, customer note, justification, a scenario, saving the logistics form unchanged.
    await prisma.proposalLine.update({ where: { id: fx.lines[0].id }, data: { notes: "internal note", customerNote: "customer note", justification: "why" } });
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "FLAT", freightValue: "500", taxMode: "MANUAL", taxRate: "0.0825" });
    expect(await fresh()).toBe(true);
    // Price
    await setProposedPrice(director.actor, fx.lines[0].id, D("91"));
    expect(await fresh()).toBe(false);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Quantity (a re-snapshot / new version could change it)
    await prisma.proposalLine.update({ where: { id: fx.lines[1].id }, data: { quantity: "5" } });
    expect(await fresh()).toBe(false);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Inclusion
    await setLineIncluded(director.actor, fx.lines[1].id, false);
    expect(await fresh()).toBe(false);
    await setLineIncluded(director.actor, fx.lines[1].id, true);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Freight
    await setProposalLogistics(director.actor, fx.proposal.id, { freightValue: "501" });
    expect(await fresh()).toBe(false);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Tax settings (rate)
    await setProposalLogistics(director.actor, fx.proposal.id, { taxRate: "0.07" });
    expect(await fresh()).toBe(false);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Ship-to on the proposal
    await setProposalLogistics(director.actor, fx.proposal.id, { shipTo: { line1: "1 Quote St", city: "Dallas", region: "TX", postalCode: "75201" } });
    expect(await fresh()).toBe(false);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Ship-to falls back to the ACCOUNT default when the proposal has none: changing that default is a change of the taxed address.
    await setProposalLogistics(director.actor, fx.proposal.id, { shipTo: null });
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    await prisma.account.update({ where: { id: acct.id }, data: { shipToJson: JSON.stringify({ line1: "9 Account Rd", city: "Houston", region: "TX", postalCode: "77002", country: "US" }) } });
    expect(await fresh()).toBe(false);
    await calculateProposalTax(director.actor, fx.proposal.id); expect(await fresh()).toBe(true);
    // Pure fingerprint: order of lines does not matter; an excluded or unpriced line does not count.
    const base = { currency: "USD", freightMode: "NONE", freightValue: null, taxMode: "MANUAL", taxRate: "0.08", taxExemptionNo: null, shipToJson: null, lines: [{ id: "a", included: true, proposedPrice: "1", quantity: "2" }, { id: "b", included: true, proposedPrice: "3", quantity: "4" }] };
    expect(taxFingerprint(base)).toBe(taxFingerprint({ ...base, lines: [...base.lines].reverse() }));
    expect(taxFingerprint(base)).toBe(taxFingerprint({ ...base, lines: [...base.lines, { id: "c", included: false, proposedPrice: "9", quantity: "9" }, { id: "d", included: true, proposedPrice: null, quantity: "1" }] }));
    expect(taxFingerprint(base)).not.toBe(taxFingerprint({ ...base, lines: [base.lines[0], { ...base.lines[1], quantity: "5" }] }));
    expect(taxFingerprint(base)).not.toBe(taxFingerprint({ ...base, taxExemptionNo: "X" }));
  });

  test("PROVIDER mode: an uncommitted AvaTax SalesOrder with item code P0000000 and freight code FR020100, ship-to required, response mapped", async () => {
    await setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "PROVIDER", freightMode: "FLAT", freightValue: "50", shipTo: null });
    // No proposal ship-to, but the account has one → used.
    avataxCalls.length = 0;
    const { result, totals } = await calculateProposalTax(director.actor, fx.proposal.id);
    expect(avataxCalls.length).toBe(1);
    const { url, body } = avataxCalls[0];
    expect(url).toBe("https://sandbox-rest.avatax.com/api/v2/transactions/create");
    expect(body.type).toBe("SalesOrder");
    expect(body.commit).toBe(false);
    expect(body.companyCode).toBe("CROSSWALK");
    expect(body.currencyCode).toBe("USD");
    expect((body.addresses as { shipTo: { city: string; postalCode: string } }).shipTo).toMatchObject({ city: "Houston", postalCode: "77002" });
    const lines = body.lines as { number: string; itemCode: string; taxCode: string; amount: number; quantity: number }[];
    expect(lines.map((l) => l.taxCode)).toEqual(["P0000000", "P0000000", "FR020100"]);
    expect(lines[2]).toMatchObject({ number: "FREIGHT", itemCode: "FREIGHT", amount: 50, quantity: 1 });
    expect(lines[0]).toMatchObject({ number: "1", itemCode: prod.sku, amount: 910, quantity: 10 }); // 91 × 10
    expect(result.provider).toBe("avatax");
    expect(result.lines.length).toBe(3);
    expect(result.lines[0].rate).toBeCloseTo(0.0825, 10);
    expect(totals.taxStale).toBe(false);
    // Fake: 8.25 % per line, rounded by the fake: 75.08 + 18.56 + 4.13 = 97.77 (the provider's figure is taken as-is)
    expect(totals.tax!.toString()).toBe("97.77");
    expect(round(D("75.075").plus("18.5625").plus("4.125"), "USD").toString()).toBe("97.76"); // what a single rounding of the sum would give — not what the provider returned
    expect(totals.total.toString()).toBe(D("1135").plus("50").plus(totals.tax!).toString());
    // No usable ship-to at all → refused before any call.
    await prisma.account.update({ where: { id: acct.id }, data: { shipToJson: null } });
    avataxCalls.length = 0;
    await expect(calculateProposalTax(director.actor, fx.proposal.id)).rejects.toThrow(/Add a ship-to address/);
    expect(avataxCalls.length).toBe(0);
    await prisma.account.update({ where: { id: acct.id }, data: { shipToJson: JSON.stringify({ line1: "9 Account Rd", city: "Houston", region: "TX", postalCode: "77002", country: "US" }) } });
    // Dry run returns zero without calling Avalara.
    process.env.TAX_DRY_RUN = "true";
    try { const dry = await calculateProposalTax(director.actor, fx.proposal.id); expect(dry.result.totalTax).toBe("0"); expect(dry.result.provider).toBe("avatax (dry run)"); expect(avataxCalls.length).toBe(0); } finally { delete process.env.TAX_DRY_RUN; }
    // Provider errors surface as a clear message, never a stored figure.
    setAvataxFetchForTests(async () => new Response(JSON.stringify({ error: { code: "AuthenticationException", message: "Authentication failed", details: [{ description: "Bad credentials" }] } }), { status: 401 }));
    await expect(calculateProposalTax(director.actor, fx.proposal.id)).rejects.toThrow(/AvaTax 401: Authentication failed — Bad credentials/);
    expect(parseAddress({ country: "US" })).toBeNull();
    expect(parseAddress({ postalCode: " 02110 " })).toMatchObject({ postalCode: "02110", country: "US" });
  });

  test("fresh-tax gate: an approved quote cannot be exported (xlsx / csv / pdf) while the tax figure is stale; finalizeCheck itself has no tax requirement", async () => {
    setAvataxFetchForTests(async () => new Response(JSON.stringify({ totalTax: 1, totalTaxable: 1, totalExempt: 0, lines: [], summary: [] }), { status: 200 }));
    await setProposalLogistics(director.actor, fx.proposal.id, { taxMode: "MANUAL", taxRate: "0.05", freightMode: "NONE" });
    await calculateProposalTax(director.actor, fx.proposal.id);
    const sub = await submitForApproval(director.actor, fx.proposal.id);
    expect(sub.status).toBe("APPROVED");
    expect((await finalizeCheck(fx.proposal.id)).ok).toBe(true);
    expect((await quoteTotals(fx.proposal.id)).taxStale).toBe(false);
    const ok = await buildQuote(director.actor, fx.proposal.id, "csv");
    expect(ok.filename).toMatch(/^Crosswalk_Quote_.*\.csv$/);
    // Freight changed after approval (allowed: freight is not a priced line) → the tax figure is stale → export blocked until recalculated.
    await setProposalLogistics(director.actor, fx.proposal.id, { freightMode: "FLAT", freightValue: "10" });
    expect((await quoteTotals(fx.proposal.id)).taxStale).toBe(true);
    expect((await finalizeCheck(fx.proposal.id)).ok).toBe(true); // approvals are unaffected by freight/tax
    for (const f of ["xlsx", "csv"] as const) await expect(buildQuote(director.actor, fx.proposal.id, f)).rejects.toThrow(/Tax was calculated before the latest price or freight change/);
    await expect(buildQuotePdf(director.actor, fx.proposal.id)).rejects.toThrow(/Tax was calculated before the latest price change/);
    await calculateProposalTax(director.actor, fx.proposal.id);
    const pdf = await buildQuotePdf(director.actor, fx.proposal.id);
    expect(pdf.contentType).toBe("application/pdf");
  });
});

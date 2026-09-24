/**
 * WS2 — proposals and scenarios (KN-12): every scenario kind the constraint / UI allow is usable,
 * each kind seeds the documented prices, scenario edits are scoped to the scenario's proposal,
 * scenario and manual prices share one set of bounds, and nothing applies to a locked proposal.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { D, money, round } from "@/lib/money";
import { createScenario, setScenarioPrice, scenarioEconomics, applyScenario, setProposedPrice, SCENARIO_KINDS, MAX_UNIT_PRICE, refreshEconomics } from "@/lib/proposals/service";
import { submitForApproval } from "@/lib/approvals/service";
import { recordObservation } from "@/lib/intelligence";
import { ENUM_CONSTRAINTS } from "@/lib/db/constraints";
import { PATCH as scenarioPatchRoute } from "@/app/api/proposals/[id]/scenarios/[sid]/route";
import { setActorForTests } from "../setup";
import { RUN, mkUser, mkProduct, mkAccount, mkProposal, mkPolicy, linesOf, cleanupRun } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("WS2 proposals — scenarios and price bounds", () => {
  let rep: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let known: Awaited<ReturnType<typeof mkProduct>>, weak: Awaited<ReturnType<typeof mkProduct>>, none: Awaited<ReturnType<typeof mkProduct>>;
  let fx: Awaited<ReturnType<typeof mkProposal>>;
  const CODE_KNOWN = `${RUN}K1`.toUpperCase(), CODE_WEAK = `${RUN}W1`.toUpperCase(), CODE_NONE = `${RUN}N1`.toUpperCase();

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rep", ["SALES_REP"]);
    await mkPolicy(); // target 0.45 / min 0.30 / COST_PLUS_MIN_MARGIN / MATCH for the fixture family
    acct = await mkAccount({ name: "scenario acct" });
    known = await mkProduct({ sku: "KNOWN", listPrice: "1000", cogs: "400" });
    weak = await mkProduct({ sku: "WEAK", listPrice: "500", cogs: "200" });
    none = await mkProduct({ sku: "NONE", listPrice: "300", cogs: "100" });
    // A same-account invoice → KNOWN_ACCOUNT competitor price 900 for CODE_KNOWN.
    await recordObservation(rep.row.id, { competitorName: `${RUN} Rival`, competitorSku: CODE_KNOWN, price: "900", accountId: acct.id, observedAt: new Date(), sourceType: "CUSTOMER_INVOICE" });
    fx = await mkProposal(rep.actor, { accountId: acct.id, lines: [
      { code: CODE_KNOWN, qty: 10, productId: known.id },
      { code: CODE_WEAK, qty: 20, productId: weak.id, estCompetitorPrice: "450" }, // rep estimate only
      { code: CODE_NONE, qty: 30, productId: none.id },
    ] });
  });
  afterAll(async () => { setActorForTests(null); await cleanupRun(); });

  const line = (code: string) => fx.lines.find((l) => l.competitorCode === code)!;
  const priceIn = async (scenarioId: string, lineId: string) => money((await prisma.scenarioLine.findUniqueOrThrow({ where: { scenarioId_proposalLineId: { scenarioId, proposalLineId: lineId } } })).proposedPrice);

  test("competitor basis on creation: same-account invoice → KNOWN_ACCOUNT; rep estimate only → WEAK at 0.3; nothing → NONE at 0", () => {
    expect(line(CODE_KNOWN).competitorPriceBasis).toBe("KNOWN_ACCOUNT");
    expect(money(line(CODE_KNOWN).competitorPrice)!.toString()).toBe("900");
    expect(line(CODE_WEAK).competitorPriceBasis).toBe("WEAK");
    expect(line(CODE_WEAK).competitorPriceConfidence).toBe(0.3);
    expect(money(line(CODE_WEAK).competitorPrice)!.toString()).toBe("450");
    expect(line(CODE_NONE).competitorPriceBasis).toBe("NONE");
    expect(line(CODE_NONE).competitorPriceConfidence).toBe(0);
    expect(line(CODE_NONE).competitorPrice).toBeNull();
  });

  test("KN-12: the service, the CHECK constraint and the UI agree on the six scenario kinds", async () => {
    const constraint = ENUM_CONSTRAINTS.find((c) => c.table === "Scenario" && c.column === "kind")!;
    expect([...constraint.values].sort()).toEqual([...SCENARIO_KINDS].sort());
    for (const kind of SCENARIO_KINDS) {
      const s = await createScenario(rep.actor, fx.proposal.id, kind);
      expect(s.kind).toBe(kind);
      expect(await prisma.scenarioLine.count({ where: { scenarioId: s.id } })).toBe(3);
    }
    await expect(createScenario(rep.actor, fx.proposal.id, "PESSIMISTIC")).rejects.toThrow(/kind must be one of RECOMMENDED, AGGRESSIVE, MARGIN_OPTIMIZED, CUSTOMER_REQUESTED, CUSTOM, FINAL/);
    await expect(createScenario(rep.actor, fx.proposal.id, "CUSTOM", "x".repeat(121))).rejects.toThrow(/max 120/);
  });

  test("AGGRESSIVE = UNDERCUT_PCT 5 % under a usable competitor price, else STRATEGIC_DISCOUNT 5 % from the reference", async () => {
    const s = await createScenario(rep.actor, fx.proposal.id, "AGGRESSIVE");
    // KNOWN_ACCOUNT 900 → 900 × 0.95 = 855 (above the floor 400/(1−0.3) = 571.43; reference is list 1000).
    expect((await priceIn(s.id, line(CODE_KNOWN).id))!.toString()).toBe("855");
    // WEAK 450 at confidence 0.3 is not usable (needs KNOWN_ACCOUNT or ≥ 0.4): UNDERCUT_PCT falls back to the
    // target-margin price 200/(1−0.45) = 363.6363… → 363.64 — never to the weak estimate.
    expect((await priceIn(s.id, line(CODE_WEAK).id))!.toString()).toBe("363.64");
    // No competitor price → STRATEGIC_DISCOUNT 5 % from list 300 = 285.
    expect((await priceIn(s.id, line(CODE_NONE).id))!.toString()).toBe("285");
  });

  test("MARGIN_OPTIMIZED = lower of the target-margin price and the reference; RECOMMENDED = the engine's price", async () => {
    const s = await createScenario(rep.actor, fx.proposal.id, "MARGIN_OPTIMIZED");
    // target 400/(1−0.45) = 727.27 < list 1000 → 727.27
    expect((await priceIn(s.id, line(CODE_KNOWN).id))!.toString()).toBe("727.27");
    expect((await priceIn(s.id, line(CODE_NONE).id))!.toString()).toBe("181.82"); // 100/0.55 = 181.8181… < 300
    const r = await createScenario(rep.actor, fx.proposal.id, "RECOMMENDED");
    for (const l of fx.lines) expect((await priceIn(r.id, l.id))?.toString() ?? null).toBe(money(l.recommendedPrice)?.toString() ?? null);
  });

  test("CUSTOMER_REQUESTED seeds the customer's current competitor price where known, else the proposed price; CUSTOM and FINAL copy the proposal", async () => {
    const s = await createScenario(rep.actor, fx.proposal.id, "CUSTOMER_REQUESTED");
    expect((await priceIn(s.id, line(CODE_KNOWN).id))!.toString()).toBe("900");
    expect((await priceIn(s.id, line(CODE_WEAK).id))!.toString()).toBe("450"); // the rep's estimate is still "what the customer says they pay"
    expect((await priceIn(s.id, line(CODE_NONE).id))!.toString()).toBe(money(line(CODE_NONE).proposedPrice)!.toString());
    for (const kind of ["CUSTOM", "FINAL"] as const) {
      const c = await createScenario(rep.actor, fx.proposal.id, kind);
      for (const l of fx.lines) expect((await priceIn(c.id, l.id))!.toString()).toBe(money(l.proposedPrice)!.toString());
    }
    const e = await scenarioEconomics(s.id);
    expect(e.scenario.kind).toBe("CUSTOMER_REQUESTED");
    // 900×10 + 450×20 + proposed(NONE)×30
    const expected = D(900).times(10).plus(D(450).times(20)).plus(money(line(CODE_NONE).proposedPrice)!.times(30));
    expect(e.economics.revenue).toBe(expected.toString());
  });

  test("scenario line edits reject foreign line ids and cross-proposal scenario ids (service and route)", async () => {
    const other = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}O1`, qty: 1, productId: none.id }] });
    const s = await createScenario(rep.actor, fx.proposal.id, "CUSTOM");
    await expect(setScenarioPrice(rep.actor, s.id, other.lines[0].id, D(10))).rejects.toThrow(/line does not belong to this scenario's proposal/);
    await expect(setScenarioPrice(rep.actor, s.id, "no-such-line", D(10))).rejects.toThrow(/line does not belong/);
    await expect(setScenarioPrice(rep.actor, "no-such-scenario", line(CODE_NONE).id, D(10))).rejects.toThrow();
    expect(await prisma.scenarioLine.count({ where: { proposalLineId: other.lines[0].id } })).toBe(0);
    // Route: a scenario id from another proposal is "not found on this proposal" (404), never edited.
    setActorForTests(rep.actor);
    const res = await scenarioPatchRoute(new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineId: other.lines[0].id, proposedPrice: "10" }) }), { params: Promise.resolve({ id: other.proposal.id, sid: s.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/scenario not found on this proposal/);
    const res2 = await scenarioPatchRoute(new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineId: line(CODE_NONE).id, proposedPrice: "NaN" }) }), { params: Promise.resolve({ id: fx.proposal.id, sid: s.id }) });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toMatch(/not a number/);
    setActorForTests(null);
  });

  test("scenario prices and manual prices share one set of bounds: > 0, ≤ 1e9, ≤ 10 × list, rounded; null clears", async () => {
    const s = await createScenario(rep.actor, fx.proposal.id, "CUSTOM");
    const l = line(CODE_NONE); // list 300
    await expect(setScenarioPrice(rep.actor, s.id, l.id, D(0))).rejects.toThrow(/must be positive/);
    await expect(setScenarioPrice(rep.actor, s.id, l.id, D("-1"))).rejects.toThrow(/must be positive/);
    await expect(setScenarioPrice(rep.actor, s.id, l.id, D("3000.01"))).rejects.toThrow(/more than 10× the list price/);
    await expect(setScenarioPrice(rep.actor, s.id, l.id, MAX_UNIT_PRICE.plus(1))).rejects.toThrow(/exceeds the supported range/);
    await setScenarioPrice(rep.actor, s.id, l.id, D("123.455"));
    expect((await priceIn(s.id, l.id))!.toString()).toBe("123.46"); // half-even: 5 → 6 (odd → even)
    await setScenarioPrice(rep.actor, s.id, l.id, null);
    expect(await priceIn(s.id, l.id)).toBeNull();
    // The same rules on the proposal itself.
    await expect(setProposedPrice(rep.actor, l.id, D(0))).rejects.toThrow(/must be positive/);
    await expect(setProposedPrice(rep.actor, l.id, D("3000.01"))).rejects.toThrow(/more than 10× the list price/);
    await expect(setProposedPrice(rep.actor, l.id, MAX_UNIT_PRICE.plus(1))).rejects.toThrow(/exceeds the supported range/);
    const before = money((await prisma.proposalLine.findUniqueOrThrow({ where: { id: l.id } })).proposedPrice);
    const after = await setProposedPrice(rep.actor, l.id, null);
    expect(after.proposedPrice).toBeNull();
    expect(after.approvalState).toBe("NOT_REQUIRED");
    expect(after.marginPct).toBeNull();
    await setProposedPrice(rep.actor, l.id, before!);
    // applyScenario validates with the same bounds — a stored scenario price above 10 × list (written
    // directly, as an older client could) is refused, and nothing on the proposal changes.
    await prisma.scenarioLine.update({ where: { scenarioId_proposalLineId: { scenarioId: s.id, proposalLineId: l.id } }, data: { proposedPrice: "3001" } });
    await expect(applyScenario(rep.actor, s.id)).rejects.toThrow(/more than 10× the list price/);
    expect(money((await prisma.proposalLine.findUniqueOrThrow({ where: { id: l.id } })).proposedPrice)!.toString()).toBe(before!.toString());
  });

  test("applying a scenario copies its prices (audited per changed line) and is refused once the proposal is locked", async () => {
    const own = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}A1`, qty: 5, productId: none.id }, { code: `${RUN}A2`, qty: 7, productId: weak.id }] });
    const s = await createScenario(rep.actor, own.proposal.id, "CUSTOM", "Negotiated");
    await setScenarioPrice(rep.actor, s.id, own.lines[0].id, D("250"));
    await setScenarioPrice(rep.actor, s.id, own.lines[1].id, D("400"), false);
    await applyScenario(rep.actor, s.id);
    const after = await linesOf(own.proposal.id);
    expect(money(after[0].proposedPrice)!.toString()).toBe("250");
    expect(after[0].included).toBe(true);
    expect(money(after[1].proposedPrice)!.toString()).toBe("400");
    expect(after[1].included).toBe(false);
    const events = await prisma.auditEvent.findMany({ where: { entityType: "ProposalLine", entityId: { in: after.map((l) => l.id) }, action: "PRICE_CHANGED", reason: 'applied scenario "Negotiated"' } });
    expect(events.length).toBe(2);
    expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: own.proposal.id, action: "SCENARIO_APPLIED" } })).toBe(1);
    // The stored economics follow the applied prices: only line 1 is included now.
    const e = await refreshEconomics(own.proposal.id);
    expect(e.revenue.toString()).toBe(D(250).times(5).toString());
    // Submit (locks) → applying any scenario is refused, the proposal is untouched.
    await setProposedPrice(rep.actor, own.lines[0].id, round(money(own.lines[0].listPrice)!.times("0.9"), "USD"));
    const sub = await submitForApproval(rep.actor, own.proposal.id);
    expect(["APPROVED", "SUBMITTED"]).toContain(sub.status);
    const s2 = await createScenario(rep.actor, own.proposal.id, "AGGRESSIVE"); // a what-if on a locked proposal is read-only and allowed
    await expect(applyScenario(rep.actor, s2.id)).rejects.toThrow(/locked; create a new version/);
    await expect(setProposedPrice(rep.actor, own.lines[0].id, D(1))).rejects.toThrow(/locked/);
    const still = await linesOf(own.proposal.id);
    expect(money(still[0].proposedPrice)!.toString()).toBe("270");
  });
});

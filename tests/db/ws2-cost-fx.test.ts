/**
 * WS2 — cost selection and explicit FX. Cost is pure (`resolveCostFromInputs`); the FX part
 * uses the database: `catalog/fx.convert` (explicit, throws when no rate) and the stored-rate
 * immutability rule in the FX integration (a restated historical rate is logged, never applied).
 */
import { describe, test, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { D, money } from "@/lib/money";
import { resolveCostFromInputs, type CostInput } from "@/lib/catalog/cost";
import { convert } from "@/lib/catalog/fx";
import { storeRate } from "@/lib/integrations/fx/service";
import { onLog } from "@/lib/log";
import { day, mkProduct, mkAccount, mkUser, mkPolicy, mkProposal, cleanupRun, RUN } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const cost = (over: Partial<CostInput>): CostInput => ({ id: `c${Math.random().toString(36).slice(2, 6)}`, plant: null, region: null, currency: "USD", costType: "STANDARD", cost: "0", effectiveFrom: day("2025-01-01"), effectiveTo: null, source: "erp", ...over });
const asOf = day("2026-06-01");
const base = { productId: "p1", fallbackCogs: "50", fallbackCurrency: "USD", asOf, currency: "USD", region: "US-East", plant: "PLANT-1" };

describe("WS2 cost — plant > region > global, newest eligible, legacy fallback, unknown stays unknown", () => {
  test("plant-specific beats region beats global, regardless of effective dates", () => {
    const r = resolveCostFromInputs({ ...base, costs: [cost({ cost: "10", effectiveFrom: day("2026-05-01") }), cost({ cost: "20", region: "us-east", effectiveFrom: day("2026-04-01") }), cost({ cost: "30", plant: "PLANT-1", effectiveFrom: day("2025-01-01") })] });
    expect(r.cost!.toString()).toBe("30");
    expect(r.basis.kind).toBe("STANDARD_COST");
    expect(r.basis.specificity).toBe("plant");
    expect(r.basis.considered).toBe(3);
    expect(r.basis.note).toMatch(/STANDARD cost \(plant\) effective 2025-01-01 from erp/);
  });
  test("a plant cost for another plant never applies; another region never applies; global does", () => {
    const r = resolveCostFromInputs({ ...base, costs: [cost({ cost: "30", plant: "PLANT-9" }), cost({ cost: "20", region: "US-West" }), cost({ cost: "10" })] });
    expect(r.cost!.toString()).toBe("10");
    expect(r.basis.specificity).toBe("global");
    // With no plant/region in the question, only global rows qualify.
    const r2 = resolveCostFromInputs({ ...base, plant: null, region: null, costs: [cost({ cost: "30", plant: "PLANT-1" }), cost({ cost: "20", region: "US-East" }), cost({ cost: "10" })] });
    expect(r2.cost!.toString()).toBe("10");
  });
  test("within one specificity the newest effective row wins; future and expired rows are skipped", () => {
    const r = resolveCostFromInputs({ ...base, costs: [cost({ cost: "11", effectiveFrom: day("2025-01-01") }), cost({ cost: "12", effectiveFrom: day("2026-01-01") }), cost({ cost: "13", effectiveFrom: day("2026-07-01") }), cost({ cost: "14", effectiveFrom: day("2026-03-01"), effectiveTo: day("2026-06-01") })] });
    expect(r.cost!.toString()).toBe("12");
    expect(r.basis.effectiveFrom).toBe(day("2026-01-01").toISOString());
  });
  test("a cost in another currency never applies (no silent conversion); legacy COGS is the fallback in the same currency only", () => {
    const eur = resolveCostFromInputs({ ...base, costs: [cost({ cost: "9", currency: "EUR" })] });
    expect(eur.cost!.toString()).toBe("50");
    expect(eur.basis.kind).toBe("LEGACY_COGS");
    expect(eur.basis.note).toMatch(/catalog COGS \(no dated standard cost on file\)/);
    const eurAsk = resolveCostFromInputs({ ...base, currency: "EUR", costs: [cost({ cost: "9", currency: "USD" })] });
    expect(eurAsk.cost).toBeNull();
    expect(eurAsk.basis.kind).toBe("NONE");
    expect(eurAsk.basis.note).toBe("cost only known in USD");
  });
  test("no cost at all: unknown, not zero", () => {
    const r = resolveCostFromInputs({ ...base, fallbackCogs: null, costs: [] });
    expect(r.cost).toBeNull();
    expect(r.basis).toEqual({ kind: "NONE", considered: 0, note: "no cost on file — margin unknown" });
    const zero = resolveCostFromInputs({ ...base, fallbackCogs: "0", costs: [] });
    expect(zero.cost!.isZero()).toBe(true); // an explicit zero is a value
  });
});

describe.skipIf(!hasDb)("WS2 cost & FX — database", () => {
  const lines: string[] = [];
  let unsub = () => {};
  beforeAll(async () => { await cleanupRun(); unsub = onLog((l) => lines.push(JSON.stringify(l))); });
  afterAll(async () => { unsub(); await prisma.exchangeRate.deleteMany({ where: { source: `${RUN}-fx` } }); await cleanupRun(); });

  test("a proposal line with no cost carries cost null and margin null (never 0), with the basis recorded", async () => {
    const rep = await mkUser("rep", ["SALES_REP"]);
    await mkPolicy();
    const acct = await mkAccount({ name: "cost acct", region: "US-East" });
    const noCost = await mkProduct({ sku: "NOCOST", listPrice: "100", cogs: null });
    const regional = await mkProduct({ sku: "REGION", listPrice: "100", cogs: "70" });
    await prisma.standardCost.createMany({ data: [
      { productId: regional.id, cost: "40", region: "US-East", effectiveFrom: day("2025-01-01"), source: "erp" },
      { productId: regional.id, cost: "30", region: "US-West", effectiveFrom: day("2026-01-01"), source: "erp" },
      { productId: regional.id, cost: "35", plant: "PLANT-X", effectiveFrom: day("2026-01-01"), source: "erp" },
      { productId: regional.id, cost: "60", effectiveFrom: day("2026-01-01"), source: "erp" },
    ] });
    const { lines: ls } = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}NC`, qty: 1, productId: noCost.id }, { code: `${RUN}RG`, qty: 1, productId: regional.id }] });
    expect(ls[0].cost).toBeNull();
    expect(ls[0].marginPct).toBeNull();
    expect(ls[0].floorPrice).toBeNull(); // COST_PLUS_MIN_MARGIN with no cost → no floor
    expect(JSON.parse(ls[0].costBasisJson!).kind).toBe("NONE");
    expect(JSON.parse(ls[0].recommendationJson!).explanation).toMatch(/Margin unknown \(no cost on file\)/);
    // The account is in US-East: the regional row (40) beats the newer global (60); the other region and the plant row never apply (no plant in the question).
    expect(money(ls[1].cost)!.toString()).toBe("40");
    expect(JSON.parse(ls[1].costBasisJson!)).toMatchObject({ kind: "STANDARD_COST", specificity: "region", region: "US-East" });
  });

  test("convert() is explicit: same currency is the identity, the newest stored rate on or before the date is used and returned, none → throws", async () => {
    const same = await convert(D("10"), "USD", "USD", asOf);
    expect(same).toMatchObject({ amount: D("10"), rateId: null, rate: "1" });
    await expect(convert(D("10"), "USD", `${RUN.slice(-3).toUpperCase()}`, asOf)).rejects.toThrow(/No exchange rate USD→/);
    const a = await prisma.exchangeRate.create({ data: { fromCurrency: "USD", toCurrency: "EUR", rate: "0.90000000", asOf: day("2026-01-01"), source: `${RUN}-fx` } });
    const b = await prisma.exchangeRate.create({ data: { fromCurrency: "USD", toCurrency: "EUR", rate: "0.95000000", asOf: day("2026-03-01"), source: `${RUN}-fx` } });
    const c = await prisma.exchangeRate.create({ data: { fromCurrency: "USD", toCurrency: "EUR", rate: "1.05000000", asOf: day("2026-09-01"), source: `${RUN}-fx` } });
    try {
      const r = await convert(D("100"), "USD", "EUR", day("2026-06-01"));
      expect(r.rateId).toBe(b.id);
      expect(r.rate).toBe("0.95");
      expect(r.amount.toString()).toBe("95");
      expect((await convert(D("100"), "USD", "EUR", day("2026-02-01"))).rateId).toBe(a.id);
      await expect(convert(D("1"), "USD", "EUR", day("2025-12-31"))).rejects.toThrow(/on or before 2025-12-31/);
      void c;
    } finally {
      await prisma.exchangeRate.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    }
  });

  test("a stored historical rate is immutable: a restatement is logged and ignored, the original rate id keeps answering", async () => {
    const first = await storeRate({ base: "USD", quote: "GBP", date: "2026-02-02", rate: "0.79", provider: `${RUN}-fx`, fetchedAt: new Date().toISOString() });
    const again = await storeRate({ base: "USD", quote: "GBP", date: "2026-02-02", rate: "0.81", provider: `${RUN}-fx`, fetchedAt: new Date().toISOString() });
    expect(again.id).toBe(first.id);
    expect(again.rate.toString()).toBe("0.79");
    const restated = lines.filter((l) => l.includes("fx.rate_restated_ignored"));
    expect(restated.length, lines.slice(-5).join("\n")).toBeGreaterThan(0);
    expect(restated[restated.length - 1]).toMatch(/"stored":"0\.79(00)?"/);
    expect(restated[restated.length - 1]).toMatch(/"offered":"0\.81(00)?"/);
    const r = await convert(D("100"), "USD", "GBP", day("2026-02-02"));
    expect(r.rate).toBe("0.79");
    expect(r.rateId).toBe(first.id);
  });
});

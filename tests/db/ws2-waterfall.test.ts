/**
 * WS2 — the price waterfall. Part 1 is a table of pure `resolveFromInputs` fixtures (no DB);
 * part 2 prices the same SKU / account / quantity through `loadPricingContext` (what a
 * cross-reference run's `priceOf` in src/lib/pipeline/run.ts uses) and through a proposal
 * snapshot and asserts they agree.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { Decimal, D, money } from "@/lib/money";
import { resolveFromInputs, pickEntry, type ContractInput, type EntryInput, type ResolveInputs } from "@/lib/contracts/resolve";
import { loadPricingContext } from "@/lib/contracts/context";
import { RUN, day, mkUser, mkProduct, mkAccount, mkGpo, mkMembership, mkContract, mkProposal, mkPolicy, cleanupRun } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = (v: string | number) => new Decimal(v);

// ---- Part 1: pure fixtures ------------------------------------------------------------------
const P = { id: "p1", sku: "SKU1", family: "Trocar Products", listPrice: "1000", currency: "USD" };
const entry = (over: Partial<EntryInput> = {}): EntryInput => ({ id: `e${Math.random().toString(36).slice(2, 6)}`, productId: "p1", price: "0", currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: null, tier: null, minQty: null, maxQty: null, volumeTierName: null, status: "ACTIVE", approvalState: "APPROVED", ...over });
const contract = (over: Partial<ContractInput>): ContractInput => ({ id: over.contractNumber ?? "c", contractNumber: "C", name: "c", type: "LOCAL", status: "ACTIVE", accountId: "a1", parentAccountId: null, gpoId: null, tier: null, currency: "USD", effectiveFrom: day("2025-01-01"), effectiveTo: null, precedence: 0, scopes: [], entries: [], ...over });
const acct = { id: "a1", parentAccountId: "idn1", currency: "USD" };
const asOf = day("2026-06-01");
const memberA = [{ gpoId: "gpoA", tier: "Tier 2", effectiveFrom: day("2024-01-01"), effectiveTo: null }];
const national = contract({ contractNumber: "NAT", type: "NATIONAL", accountId: null, entries: [entry({ price: "900" })] });
const gpo = contract({ contractNumber: "GPO-T2", type: "GPO", accountId: null, gpoId: "gpoA", tier: "Tier 2", entries: [entry({ price: "800" })] });
const idn = contract({ contractNumber: "IDN", type: "IDN", accountId: null, parentAccountId: "idn1", entries: [entry({ price: "700" })] });
const local = contract({ contractNumber: "LOC", type: "LOCAL", entries: [entry({ price: "600" })] });
const base: ResolveInputs = { product: P, listEntries: [], account: acct, memberships: memberA, contracts: [national, gpo, idn, local], asOf, quantity: d(10) };

type Case = { name: string; input: ResolveInputs; source: string | null; price: string | null; ranks?: Record<string, number>; reasons?: Record<string, RegExp>; explanation?: RegExp };
const CASES: Case[] = [
  { name: "all five levels present: LOCAL (rank 4) wins; every loser is recorded as outranked", input: base, source: "LOCAL", price: "600", ranks: { LIST: 0, NATIONAL: 1, GPO: 2, IDN: 3, LOCAL: 4 }, explanation: /LOCAL \(LOC\) applies at USD 600: effective entry\. LIST: 1000 — outranked; NATIONAL NAT: 900 — outranked; GPO GPO-T2: 800 — outranked; IDN IDN: 700 — outranked/ },
  { name: "no local → IDN via the parent", input: { ...base, contracts: [national, gpo, idn] }, source: "IDN", price: "700" },
  { name: "no local/IDN → GPO tier", input: { ...base, contracts: [national, gpo] }, source: "GPO", price: "800" },
  { name: "only national → NATIONAL beats list", input: { ...base, contracts: [national] }, source: "NATIONAL", price: "900" },
  { name: "no contracts → LIST from the catalog", input: { ...base, contracts: [] }, source: "LIST", price: "1000", reasons: { LIST: /catalog list price/ } },
  { name: "precedence: GPO with precedence 5 ranks 15 and beats LOCAL (rank 4)", input: { ...base, contracts: [{ ...gpo, precedence: 5 }, local] }, source: "GPO", price: "800", ranks: { GPO: 15, LOCAL: 4 } },
  { name: "precedence: LOCAL precedence 1 (rank 11) still loses to GPO precedence 5 (rank 15) — the rank, not the level, decides", input: { ...base, contracts: [{ ...gpo, precedence: 5 }, { ...local, precedence: 1 }] }, source: "GPO", price: "800", ranks: { GPO: 15, LOCAL: 11 } },
  { name: "equal rank (two LOCAL contracts): the lower price wins and the explanation says so", input: { ...base, contracts: [local, contract({ contractNumber: "LOC2", type: "LOCAL", entries: [entry({ price: "550" })] })] }, source: "LOCAL", price: "550", reasons: { LOCAL: /lowest price among equal-precedence contracts/ } },
  { name: "equal rank, equal price: the first listed wins, still flagged as a tie", input: { ...base, contracts: [local, contract({ contractNumber: "LOC2", type: "LOCAL", entries: [entry({ price: "600" })] })] }, source: "LOCAL", price: "600", reasons: { LOCAL: /lowest price among equal-precedence/ } },
  { name: "DRAFT contract is skipped with the status as the reason", input: { ...base, contracts: [{ ...local, status: "DRAFT" }, gpo] }, source: "GPO", price: "800", reasons: { LOCAL: /contract status DRAFT/ } },
  { name: "TERMINATED contract is skipped", input: { ...base, contracts: [{ ...local, status: "TERMINATED" }] }, source: "LIST", price: "1000", reasons: { LOCAL: /contract status TERMINATED/ } },
  { name: "contract not yet in force on asOf", input: { ...base, contracts: [{ ...local, effectiveFrom: day("2026-07-01") }] }, source: "LIST", price: "1000", reasons: { LOCAL: /not in force on 2026-06-01/ } },
  { name: "contract expired before asOf (effectiveTo is exclusive)", input: { ...base, contracts: [{ ...local, effectiveTo: day("2026-06-01") }] }, source: "LIST", price: "1000", reasons: { LOCAL: /not in force/ } },
  { name: "contract in force on its last day (asOf just before effectiveTo)", input: { ...base, asOf: new Date(day("2026-06-01").getTime() - 1), contracts: [{ ...local, effectiveTo: day("2026-06-01") }] }, source: "LOCAL", price: "600" },
  { name: "contract in another currency: no silent conversion", input: { ...base, contracts: [{ ...local, currency: "EUR", entries: [entry({ price: "500", currency: "EUR" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /contract currency EUR ≠ USD/ } },
  { name: "entry in another currency inside a USD contract: no silent conversion", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "500", currency: "EUR" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /priced in EUR, not USD \(no silent conversion\)/ } },
  { name: "scope by family (case-insensitive) applies", input: { ...base, contracts: [{ ...local, scopes: [{ productFamily: "trocar products", productId: null }] }] }, source: "LOCAL", price: "600" },
  { name: "scope by another family excludes the SKU", input: { ...base, contracts: [{ ...local, scopes: [{ productFamily: "Hernia Mesh", productId: null }] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /outside contract scope/ } },
  { name: "scope by product id applies", input: { ...base, contracts: [{ ...local, scopes: [{ productFamily: null, productId: "p1" }] }] }, source: "LOCAL", price: "600" },
  { name: "GPO: not a member", input: { ...base, memberships: [], contracts: [gpo] }, source: "LIST", price: "1000", reasons: { GPO: /not an active member of this GPO/ } },
  { name: "GPO: membership not yet effective", input: { ...base, memberships: [{ ...memberA[0], effectiveFrom: day("2027-01-01") }], contracts: [gpo] }, source: "LIST", price: "1000", reasons: { GPO: /not an active member/ } },
  { name: "GPO: membership ended before asOf", input: { ...base, memberships: [{ ...memberA[0], effectiveTo: day("2026-01-01") }], contracts: [gpo] }, source: "LIST", price: "1000", reasons: { GPO: /not an active member/ } },
  { name: "GPO: tier mismatch", input: { ...base, memberships: [{ ...memberA[0], tier: "Tier 3" }], contracts: [gpo] }, source: "LIST", price: "1000", reasons: { GPO: /contract tier Tier 2 ≠ membership tier Tier 3/ } },
  { name: "GPO: contract tier set, membership tier unknown → applies (tier compared only when both set)", input: { ...base, memberships: [{ ...memberA[0], tier: null }], contracts: [gpo] }, source: "GPO", price: "800" },
  { name: "GPO: membership of another GPO", input: { ...base, memberships: [{ ...memberA[0], gpoId: "gpoB" }], contracts: [gpo] }, source: "LIST", price: "1000", reasons: { GPO: /not an active member/ } },
  { name: "IDN: account has no parent", input: { ...base, account: { ...acct, parentAccountId: null }, contracts: [idn] }, source: "LIST", price: "1000", reasons: { IDN: /not the account's parent/ } },
  { name: "IDN: contract on a different IDN", input: { ...base, contracts: [{ ...idn, parentAccountId: "idn2" }] }, source: "LIST", price: "1000", reasons: { IDN: /not the account's parent/ } },
  { name: "IDN: contract keyed by accountId = parent (legacy shape) applies", input: { ...base, contracts: [{ ...idn, parentAccountId: null, accountId: "idn1" }] }, source: "IDN", price: "700" },
  { name: "LOCAL: belongs to another account", input: { ...base, contracts: [{ ...local, accountId: "a2" }] }, source: "LIST", price: "1000", reasons: { LOCAL: /belongs to another account/ } },
  { name: "LOCAL: no account in the question", input: { ...base, account: null, memberships: [], contracts: [local] }, source: "LIST", price: "1000", reasons: { LOCAL: /belongs to another account/ } },
  { name: "entry PENDING approval is not a price", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "600", approvalState: "PENDING" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /expired, pending or not yet effective/ } },
  { name: "entry SUPERSEDED is not a price", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "600", status: "SUPERSEDED" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /expired, pending or not yet effective/ } },
  { name: "entry expired (effectiveTo exclusive)", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "600", effectiveTo: day("2026-06-01") })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /expired, pending/ } },
  { name: "entry future-dated", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "600", effectiveFrom: day("2026-07-01") })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /not yet effective/ } },
  { name: "entry for another SKU", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "600", productId: "p2" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /no entry for this SKU/ } },
  { name: "quantity below the band's minQty", input: { ...base, quantity: d(5), contracts: [{ ...local, entries: [entry({ price: "600", minQty: "10" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /quantity 5 outside every volume band/ } },
  { name: "quantity above the band's maxQty", input: { ...base, quantity: d(1000), contracts: [{ ...local, entries: [entry({ price: "600", minQty: "10", maxQty: "999" })] }] }, source: "LIST", price: "1000", reasons: { LOCAL: /quantity 1000 outside every volume band/ } },
  { name: "band edges are inclusive (qty = minQty, qty = maxQty)", input: { ...base, quantity: d(999), contracts: [{ ...local, entries: [entry({ price: "600", minQty: "999", maxQty: "999" })] }] }, source: "LOCAL", price: "600" },
  { name: "narrowest matching band wins over a wider one and over an unbanded entry", input: { ...base, quantity: d(50), contracts: [{ ...local, entries: [entry({ price: "650" }), entry({ price: "640", minQty: "1", maxQty: "1000" }), entry({ price: "630", minQty: "10", maxQty: "100", volumeTierName: "10–100" })] }] }, source: "LOCAL", price: "630", reasons: { LOCAL: /most specific volume band \/ latest effective entry/ } },
  { name: "same band width: the latest effective entry wins", input: { ...base, contracts: [{ ...local, entries: [entry({ price: "620", effectiveFrom: day("2025-01-01") }), entry({ price: "610", effectiveFrom: day("2026-01-01") })] }] }, source: "LOCAL", price: "610" },
  { name: "fractional quantity inside a band", input: { ...base, quantity: d("2.5"), contracts: [{ ...local, entries: [entry({ price: "600", minQty: "1", maxQty: "3" })] }] }, source: "LOCAL", price: "600" },
  { name: "LIST falls back to a pricebook entry when the catalog has no list price", input: { ...base, product: { ...P, listPrice: null }, listEntries: [entry({ price: "990", pricebookName: "2026 List" })], contracts: [] }, source: "LIST", price: "990", reasons: { LIST: /price list 2026 List/ } },
  { name: "LIST: catalog price in another currency → pricebook in the asked currency", input: { ...base, product: { ...P, listPrice: "800", currency: "EUR" }, listEntries: [entry({ price: "990" })], contracts: [] }, source: "LIST", price: "990" },
  { name: "LIST: catalog price in another currency and no pricebook → reason names both currencies", input: { ...base, product: { ...P, listPrice: "800", currency: "EUR" }, contracts: [] }, source: null, price: null, reasons: { LIST: /list price is in EUR, not USD/ } },
  { name: "no price anywhere: every step's reason is in the explanation", input: { ...base, product: { ...P, listPrice: null }, contracts: [{ ...local, entries: [] }] }, source: null, price: null, reasons: { LIST: /no entry for this SKU/, LOCAL: /no entry for this SKU/ }, explanation: /^No applicable price: LIST: no entry for this SKU; LOCAL: no entry for this SKU$/ },
  { name: "contract price applies even when there is no list price at all", input: { ...base, product: { ...P, listPrice: null }, contracts: [local] }, source: "LOCAL", price: "600", reasons: { LIST: /no entry for this SKU/ } },
  { name: "requested currency overrides the account currency", input: { ...base, currency: "EUR", contracts: [local] }, source: null, price: null, reasons: { LIST: /list price is in USD, not EUR/, LOCAL: /contract currency USD ≠ EUR/ } },
];

describe("WS2 waterfall — table-driven resolveFromInputs", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const r = resolveFromInputs(c.input);
      expect(r.source).toBe(c.source);
      expect(r.price?.toString() ?? null).toBe(c.price);
      expect(r.currency).toBe(c.input.currency ?? "USD");
      expect(r.asOf).toBe(c.input.asOf.toISOString());
      // Exactly one applied step when there is a price; none otherwise; every contract has a step.
      expect(r.steps.filter((s) => s.applied).length).toBe(c.source ? 1 : 0);
      expect(r.steps.length).toBe(1 + c.input.contracts.length);
      for (const s of r.steps) expect(s.reason.length).toBeGreaterThan(0);
      if (c.ranks) for (const [level, rank] of Object.entries(c.ranks)) expect(r.steps.find((s) => s.level === level)!.rank).toBe(rank);
      if (c.reasons) for (const [level, re] of Object.entries(c.reasons)) expect(r.steps.filter((s) => s.level === level).map((s) => s.reason).join(" | ")).toMatch(re);
      if (c.explanation) expect(r.explanation).toMatch(c.explanation);
      // Steps come back sorted by rank so the UI can show the ladder.
      for (let i = 1; i < r.steps.length; i++) expect(r.steps[i].rank).toBeGreaterThanOrEqual(r.steps[i - 1].rank);
    });
  }

  test("pickEntry reasons are specific: no entry / not live / currency / band, in that order", () => {
    expect(pickEntry([], "p1", asOf, d(1), "USD").reason).toBe("no entry for this SKU");
    expect(pickEntry([entry({ status: "EXPIRED" })], "p1", asOf, d(1), "USD").reason).toMatch(/expired, pending or not yet effective/);
    expect(pickEntry([entry({ currency: "GBP" })], "p1", asOf, d(1), "USD").reason).toBe("entry priced in GBP, not USD (no silent conversion)");
    expect(pickEntry([entry({ minQty: "5" })], "p1", asOf, d(1), "USD").reason).toBe("quantity 1 outside every volume band");
    expect(pickEntry([entry({ price: "1" })], "p1", asOf, d(1), "USD").reason).toBe("effective entry");
  });
});

// ---- Part 2: run pricing (loadPricingContext) vs proposal snapshot ----------------------------
describe.skipIf(!hasDb)("WS2 waterfall — request candidate pricing agrees with the proposal snapshot", () => {
  let rep: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let parent: Awaited<ReturnType<typeof mkAccount>>;
  let g: Awaited<ReturnType<typeof mkGpo>>;
  let sku: Awaited<ReturnType<typeof mkProduct>>;
  let banded: Awaited<ReturnType<typeof mkProduct>>;

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rep", ["SALES_REP"]);
    await mkPolicy();
    parent = await mkAccount({ name: "parent idn" });
    acct = await mkAccount({ name: "wf acct", parentAccountId: parent.id });
    g = await mkGpo("wf gpo");
    await mkMembership(acct.id, g.id, "Tier 2", day("2024-01-01"));
    sku = await mkProduct({ sku: "WF1", listPrice: "1000", cogs: "400" });
    banded = await mkProduct({ sku: "WF2", listPrice: "100", cogs: "40" });
    await mkContract({ number: "WF-NAT", type: "NATIONAL", entries: [{ productId: sku.id, price: "900" }, { productId: banded.id, price: "95" }] });
    await mkContract({ number: "WF-GPO", type: "GPO", gpoId: g.id, tier: "Tier 2", entries: [{ productId: sku.id, price: "800" }, { productId: banded.id, price: "90", minQty: "1", maxQty: "99" }, { productId: banded.id, price: "85", minQty: "100", maxQty: "999", volumeTierName: "100–999" }] });
    await mkContract({ number: "WF-IDN", type: "IDN", parentAccountId: parent.id, entries: [{ productId: sku.id, price: "700" }] });
    await mkContract({ number: "WF-LOC", type: "LOCAL", accountId: acct.id, entries: [{ productId: sku.id, price: "600" }] });
  });
  afterAll(async () => { await cleanupRun(); });

  test("the same SKU / account / quantity resolves identically through the run's context and the proposal's snapshot (LOCAL, and a GPO volume band)", async () => {
    const { lines } = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}WF1`, qty: 10, productId: sku.id }, { code: `${RUN}WF2`, qty: 240, productId: banded.id }] });
    // What src/lib/pipeline/run.ts `priceOf` does for a request that names the account (no pricebook → no `prices`).
    const ctx = await loadPricingContext({ accountId: acct.id });
    const products = await prisma.ownProduct.findMany({ where: { id: { in: [sku.id, banded.id] } } });
    for (const l of lines) {
      const p = products.find((x) => x.id === l.productId)!;
      const r = ctx.resolvePrice({ id: p.id, sku: p.sku, category: p.category, listPrice: p.listPrice, currency: p.currency, prices: [] }, D(l.quantity));
      const win = r.steps.find((s) => s.applied)!;
      const snap = JSON.parse(l.waterfallJson!) as { steps: { level: string; price: string | null; applied: boolean; rank: number; contractNumber?: string; volumeTier?: string | null }[]; explanation: string };
      const snapWin = snap.steps.find((s) => s.applied)!;
      expect(r.price!.toString()).toBe(money(l.contractPrice)!.toString());
      expect(win.level).toBe(l.contractPriceSource);
      expect(snapWin.price).toBe(r.price!.toString());
      expect(snapWin.level).toBe(win.level);
      expect(snapWin.contractNumber).toBe(win.contractNumber);
      expect(snapWin.volumeTier ?? null).toBe(win.volumeTier ?? null);
      expect(snap.steps.map((s) => `${s.level}:${s.price}:${s.rank}`)).toEqual(r.steps.map((s) => `${s.level}:${s.price}:${s.rank}`));
      expect(money(l.listPrice)!.toString()).toBe(r.steps.find((s) => s.level === "LIST")!.price);
      // The run stores a JS number (MatchCandidate.unitPrice is Decimal(18,4)): same value once rounded to 4 dp.
      expect(new Decimal(Number(r.price!.toString())).toFixed(4)).toBe(r.price!.toFixed(4));
    }
    expect(lines[0].contractPriceSource).toBe("LOCAL");
    expect(money(lines[0].contractPrice)!.toString()).toBe("600");
    expect(lines[1].contractPriceSource).toBe("GPO");
    expect(money(lines[1].contractPrice)!.toString()).toBe("85");
    expect(JSON.parse(lines[1].waterfallJson!).steps.find((s: { level: string }) => s.level === "GPO").volumeTier).toBe("100–999");
  });

  test("LIST from a pricebook: only the request's selected pricebook is a pricing basis — run and proposal agree with and without one", async () => {
    const pb = await prisma.pricebook.create({ data: { name: `${RUN} Pricebook` } });
    const pb2 = await prisma.pricebook.create({ data: { name: `${RUN} Other book` } });
    const noList = await mkProduct({ sku: "WFPB", listPrice: null, cogs: "10" });
    await prisma.priceEntry.createMany({ data: [{ pricebookId: pb.id, productId: noList.id, price: "77", effectiveFrom: day("2025-01-01") }, { pricebookId: pb2.id, productId: noList.id, price: "66", effectiveFrom: day("2025-06-01") }] });
    // No pricebook on the request: the run has no LIST price for this SKU (run.ts passes no `prices`); the proposal must not invent one from a random book.
    const none = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}PB0`, qty: 1, productId: noList.id }] });
    expect(none.lines[0].listPrice).toBeNull();
    expect(JSON.parse(none.lines[0].waterfallJson!).explanation).toMatch(/LIST: no entry for this SKU/);
    // With the request's pricebook: both price from THAT book (77), never the other book's newer 66.
    const withPb = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}PB1`, qty: 1, productId: noList.id }], pricebookId: pb.id });
    expect(money(withPb.lines[0].listPrice)!.toString()).toBe("77");
    const ctx = await loadPricingContext({ accountId: acct.id });
    const prices = await prisma.priceEntry.findMany({ where: { productId: noList.id, pricebookId: pb.id }, include: { pricebook: true } });
    const r = ctx.resolvePrice({ id: noList.id, sku: noList.sku, category: noList.category, listPrice: null, currency: "USD", prices: prices.map((e) => ({ ...e, pricebook: { name: e.pricebook!.name } })) }, D(1));
    expect(r.price!.toString()).toBe("77");
    expect(r.steps.find((s) => s.level === "LIST")!.reason).toBe(`price list ${RUN} Pricebook`);
  });

  test("membership change: the run's context follows today's membership while the proposal keeps its snapshot", async () => {
    const { lines } = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}WF3`, qty: 10, productId: banded.id }] });
    expect(lines[0].contractPriceSource).toBe("GPO");
    expect(money(lines[0].contractPrice)!.toString()).toBe("90");
    const m = await prisma.gpoMembership.findFirstOrThrow({ where: { accountId: acct.id, gpoId: g.id } });
    await prisma.gpoMembership.update({ where: { id: m.id }, data: { effectiveTo: day("2026-01-01") } });
    try {
      const ctx = await loadPricingContext({ accountId: acct.id });
      const r = ctx.resolvePrice({ id: banded.id, sku: banded.sku, category: banded.category, listPrice: banded.listPrice, currency: "USD", prices: [] }, D(10));
      expect(r.source).toBe("NATIONAL");
      expect(r.price!.toString()).toBe("95");
      expect(r.steps.find((s) => s.level === "GPO")!.reason).toMatch(/not an active member/);
      const again = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lines[0].id } });
      expect(money(again.contractPrice)!.toString()).toBe("90"); // snapshot untouched
    } finally {
      await prisma.gpoMembership.update({ where: { id: m.id }, data: { effectiveTo: null } });
    }
  });

  test("multiple LOCAL contracts for one account: the cheaper one applies and the tie is explained; primaryContractId is the newest ACTIVE local", async () => {
    const other = await mkContract({ number: "WF-LOC2", type: "LOCAL", accountId: acct.id, effectiveFrom: day("2026-01-01"), entries: [{ productId: sku.id, price: "650" }] });
    try {
      const ctx = await loadPricingContext({ accountId: acct.id });
      expect(ctx.primaryContractId).toBe(other.id);
      const r = ctx.resolvePrice({ id: sku.id, sku: sku.sku, category: sku.category, listPrice: sku.listPrice, currency: "USD", prices: [] }, D(1));
      expect(r.price!.toString()).toBe("600");
      expect(r.steps.filter((s) => s.level === "LOCAL").length).toBe(2);
      expect(r.steps.find((s) => s.applied)!.reason).toMatch(/lowest price among equal-precedence contracts/);
    } finally {
      await prisma.contract.delete({ where: { id: other.id } });
    }
  });
});

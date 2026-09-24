/**
 * WS2 — proposal economics reconciliation. Every figure is recomputed here from the stored
 * lines with plain Decimal arithmetic (no call into economics.ts) and compared with the stored
 * `economicsJson`, the customer quote (xlsx parsed with exceljs, csv, PDF text) and the CRM
 * write-back payload.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { Decimal, D, money, ZERO } from "@/lib/money";
import { setProposedPrice, setLineIncluded, refreshEconomics } from "@/lib/proposals/service";
import { rollup, type EconLine } from "@/lib/proposals/economics";
import { submitForApproval } from "@/lib/approvals/service";
import { buildQuote } from "@/lib/proposals/export";
import { buildQuotePdf } from "@/lib/pdf";
import { buildQuoteWriteback } from "@/lib/integrations/salesforce/writeback";
import { parseCsv } from "@/lib/sheets/csv";
import { recordObservation } from "@/lib/intelligence";
import { RUN, mkUser, mkProduct, mkAccount, mkContract, mkProposal, mkPolicy, linesOf, cleanupRun, pdfText } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
type Line = Awaited<ReturnType<typeof linesOf>>[number];

/** The independent oracle: the documented rollup, written out. */
function oracle(lines: Line[]) {
  const q = (l: Line) => D(l.quantity);
  const inc = lines.filter((l) => l.included);
  const priced = inc.filter((l) => l.proposedPrice !== null);
  const ext = (p: unknown, l: Line) => (p == null ? ZERO : D(p as never).times(q(l)));
  let revenue = ZERO, listValue = ZERO, contractValue = ZERO, competitorSpend = ZERO, compPriced = ZERO, revWithComp = ZERO, cogs = ZERO, revWithCost = ZERO;
  for (const l of inc) competitorSpend = competitorSpend.plus(ext(l.competitorPrice, l));
  for (const l of priced) {
    revenue = revenue.plus(ext(l.proposedPrice, l));
    listValue = listValue.plus(ext(l.listPrice, l));
    contractValue = contractValue.plus(ext(l.contractPrice ?? l.listPrice, l));
    if (l.competitorPrice !== null) { compPriced = compPriced.plus(ext(l.competitorPrice, l)); revWithComp = revWithComp.plus(ext(l.proposedPrice, l)); }
    if (l.cost !== null) { cogs = cogs.plus(ext(l.cost, l)); revWithCost = revWithCost.plus(ext(l.proposedPrice, l)); }
  }
  const savings = compPriced.minus(revWithComp);
  const profit = revWithCost.minus(cogs);
  const fam = new Map<string, { rev: Decimal; gp: Decimal; revWc: Decimal; cs: Decimal; cr: Decimal; n: number }>();
  for (const l of priced) {
    const k = l.productFamily ?? "Other";
    const f = fam.get(k) ?? { rev: ZERO, gp: ZERO, revWc: ZERO, cs: ZERO, cr: ZERO, n: 0 };
    f.rev = f.rev.plus(ext(l.proposedPrice, l)); f.n++;
    if (l.cost !== null) { f.gp = f.gp.plus(ext(l.proposedPrice, l).minus(ext(l.cost, l))); f.revWc = f.revWc.plus(ext(l.proposedPrice, l)); }
    if (l.competitorPrice !== null) { f.cs = f.cs.plus(ext(l.competitorPrice, l)); f.cr = f.cr.plus(ext(l.proposedPrice, l)); }
    fam.set(k, f);
  }
  return {
    linesTotal: inc.length, linesPriced: priced.length, revenue, listValue, contractValue, competitorSpend, compPriced, savings,
    savingsPct: compPriced.isZero() ? null : savings.div(compPriced), cogs, profit, blendedMargin: revWithCost.isZero() ? null : profit.div(revWithCost),
    discountFromList: listValue.isZero() ? null : listValue.minus(revenue).div(listValue), discountFromContract: contractValue.isZero() ? null : contractValue.minus(revenue).div(contractValue),
    shareOfWallet: competitorSpend.isZero() ? null : compPriced.div(competitorSpend),
    approvalsPending: inc.filter((l) => l.approvalState === "PENDING").length, approvalsRequired: inc.filter((l) => ["REQUIRED", "PENDING", "REJECTED"].includes(l.approvalState)).length,
    families: fam,
  };
}
const s = (v: Decimal | null) => (v === null ? null : v.toString());

describe.skipIf(!hasDb)("WS2 economics — stored rollup, quote exports and CRM payload agree with an independent recomputation", () => {
  let director: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let fx: Awaited<ReturnType<typeof mkProposal>>;
  let P1: Awaited<ReturnType<typeof mkProduct>>, P2: Awaited<ReturnType<typeof mkProduct>>, P3: Awaited<ReturnType<typeof mkProduct>>, P4: Awaited<ReturnType<typeof mkProduct>>, P5: Awaited<ReturnType<typeof mkProduct>>;

  beforeAll(async () => {
    await cleanupRun();
    director = await mkUser("dir", ["PRICING_DIRECTOR"]);
    await mkPolicy();
    await mkPolicy(`${RUN} Mesh`);
    acct = await mkAccount({ name: "econ acct", shipToJson: JSON.stringify({ line1: "1 Main St", city: "Boston", region: "MA", postalCode: "02110", country: "US" }) });
    P1 = await mkProduct({ sku: "E1", listPrice: "1000", cogs: "400" }); // competitor known, contract price
    P2 = await mkProduct({ sku: "E2", listPrice: "500", cogs: "200", category: `${RUN} Mesh` }); // rep estimate
    P3 = await mkProduct({ sku: "E3", listPrice: "300", cogs: null }); // no cost → excluded from margin
    P4 = await mkProduct({ sku: "E4", listPrice: "80", cogs: "30", category: `${RUN} Mesh` }); // fractional quantity
    P5 = await mkProduct({ sku: "E5", listPrice: "60", cogs: "20" }); // will be excluded
    await mkContract({ number: "EC-LOC", type: "LOCAL", accountId: acct.id, entries: [{ productId: P1.id, price: "800" }] });
    await recordObservation(director.row.id, { competitorName: `${RUN} Rival`, competitorSku: `${RUN}C1`, price: "850", accountId: acct.id, observedAt: new Date(), sourceType: "CUSTOMER_INVOICE" });
    fx = await mkProposal(director.actor, { accountId: acct.id, lines: [
      { code: `${RUN}C1`, qty: 10, productId: P1.id, customerNote: "Ships in cases of 6" },
      { code: `${RUN}C2`, qty: 20, productId: P2.id, estCompetitorPrice: "450" },
      { code: `${RUN}C3`, qty: 30, productId: P3.id },
      { code: `${RUN}C4`, qty: 2.5, productId: P4.id, estCompetitorPrice: "75.5" },
      { code: `${RUN}C5`, qty: 4, productId: P5.id },
      { code: `${RUN}C6`, qty: 9, productId: null }, // no product: excluded on creation
    ] });
    // Manual prices with half-way rounding cases; one exclusion; one line left at recommendation.
    await setProposedPrice(director.actor, fx.lines[0].id, D("777.775")); // → 777.78 (7 odd → up)
    await setProposedPrice(director.actor, fx.lines[1].id, D("444.445")); // → 444.44 (4 even → down)
    await setProposedPrice(director.actor, fx.lines[3].id, D("70.125")); // → 70.12
    await setLineIncluded(director.actor, fx.lines[4].id, false);
    fx.lines = await linesOf(fx.proposal.id);
  });
  afterAll(async () => { await cleanupRun(); });

  test("rounding on write: manual prices land at the currency's minor unit with banker's rounding", () => {
    expect(money(fx.lines[0].proposedPrice)!.toString()).toBe("777.78");
    expect(money(fx.lines[1].proposedPrice)!.toString()).toBe("444.44");
    expect(money(fx.lines[3].proposedPrice)!.toString()).toBe("70.12");
    expect(fx.lines[4].included).toBe(false);
    expect(fx.lines[5].included).toBe(false);
    expect(fx.lines[5].notes).toMatch(/No product selected/);
    expect(D(fx.lines[3].quantity).toString()).toBe("2.5");
  });

  test("stored economicsJson equals the independent recomputation from the lines (every figure, by family, approval counts)", async () => {
    const o = oracle(fx.lines);
    const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } });
    const e = JSON.parse(p.economicsJson!);
    expect(e.currency).toBe("USD");
    expect(e.mixedCurrency).toBe(false);
    expect(e.linesTotal).toBe(4);
    expect(e.linesPriced).toBe(4);
    expect(e.revenue).toBe(s(o.revenue));
    expect(e.listValue).toBe(s(o.listValue));
    expect(e.currentContractValue).toBe(s(o.contractValue));
    expect(e.competitorSpend).toBe(s(o.competitorSpend));
    expect(e.competitorSpendPricedLines).toBe(s(o.compPriced));
    expect(e.customerSavings).toBe(s(o.savings));
    expect(e.customerSavingsPct).toBe(s(o.savingsPct));
    expect(e.cogs).toBe(s(o.cogs));
    expect(e.grossProfit).toBe(s(o.profit));
    expect(e.blendedMarginPct).toBe(s(o.blendedMargin));
    expect(e.discountFromListPct).toBe(s(o.discountFromList));
    expect(e.discountFromContractPct).toBe(s(o.discountFromContract));
    expect(e.shareOfWalletPct).toBe(s(o.shareOfWallet));
    expect(e.approvalsPending).toBe(o.approvalsPending);
    expect(e.approvalsRequired).toBe(o.approvalsRequired);
    // Concrete values, written out: revenue = 777.78×10 + 444.44×20 + rec(E3)×30 + 70.12×2.5
    const recE3 = money(fx.lines[2].proposedPrice)!;
    expect(o.revenue.toString()).toBe(D("7777.8").plus("8888.8").plus(recE3.times(30)).plus("175.3").toString());
    expect(o.listValue.toString()).toBe("29200"); // 10000 + 10000 + 9000 + 200
    expect(o.contractValue.toString()).toBe("27200"); // E1 at contract 800 instead of list 1000
    expect(o.competitorSpend.toString()).toBe(D("8500").plus("9000").plus("188.75").toString()); // 850×10 + 450×20 + 75.5×2.5
    expect(o.cogs.toString()).toBe(D("4000").plus("4000").plus("75").toString()); // E3 has no cost
    expect(e.byFamily.map((f: { family: string }) => f.family).sort()).toEqual([`${RUN} Family`, `${RUN} Mesh`].sort());
    for (const f of e.byFamily) {
      const of = o.families.get(f.family)!;
      expect(f.lines).toBe(of.n);
      expect(f.revenue).toBe(of.rev.toString());
      expect(f.grossProfit).toBe(of.gp.toString());
      expect(f.marginPct).toBe(of.revWc.isZero() ? null : of.gp.div(of.revWc).toString());
      expect(f.competitorSpend).toBe(of.cs.toString());
      expect(f.customerSavings).toBe(of.cs.minus(of.cr).toString());
    }
  });

  test("edge rollups: all lines excluded → zero totals and null ratios; mixed currency lines are flagged and left out of totals; unpriced lines count in competitor spend only", () => {
    const base: EconLine = { id: "x", included: true, family: null, quantity: D(2), proposedPrice: D("10"), competitorPrice: D("12"), listPrice: D("15"), contractPrice: null, cost: D("6"), currency: "USD", approvalState: "NOT_REQUIRED" };
    const none = rollup([{ ...base, included: false }], "USD");
    expect(none.revenue.toString()).toBe("0");
    expect(none.linesTotal).toBe(0);
    expect(none.blendedMarginPct).toBeNull();
    expect(none.customerSavingsPct).toBeNull();
    expect(none.shareOfWalletPct).toBeNull();
    expect(none.discountFromListPct).toBeNull();
    expect(none.byFamily).toEqual([]);
    const mixed = rollup([base, { ...base, id: "eur", currency: "EUR", proposedPrice: D("1000") }], "USD");
    expect(mixed.mixedCurrency).toBe(true);
    expect(mixed.revenue.toString()).toBe("20"); // the EUR line is not added into USD totals
    expect(mixed.competitorSpend.toString()).toBe("24");
    const unpriced = rollup([base, { ...base, id: "np", proposedPrice: null, competitorPrice: D("100") }], "USD");
    expect(unpriced.revenue.toString()).toBe("20");
    expect(unpriced.competitorSpend.toString()).toBe("224"); // 24 + 200: the customer still pays the competitor for the unpriced line
    expect(unpriced.competitorSpendPricedLines.toString()).toBe("24");
    expect(unpriced.shareOfWalletPct!.toString()).toBe(D("24").div("224").toString());
    expect(unpriced.linesTotal).toBe(2);
    expect(unpriced.linesPriced).toBe(1);
    const zeroPrice = rollup([{ ...base, proposedPrice: D("0"), cost: D("0") }], "USD");
    expect(zeroPrice.blendedMarginPct).toBeNull(); // 0/0 → unknown, never NaN
    expect(zeroPrice.discountFromListPct!.toString()).toBe("1");
  });

  test("the customer quote (xlsx, csv, pdf) and the CRM payload carry the same lines, prices and totals as the stored economics", async () => {
    const sub = await submitForApproval(director.actor, fx.proposal.id);
    expect(sub.status).toBe("APPROVED"); // the director holds every authority these lines need
    const lines = await linesOf(fx.proposal.id);
    const o = oracle(lines);
    const inc = lines.filter((l) => l.included);
    const expectedRows = inc.map((l) => ({ code: l.competitorCode, sku: l.sku, qty: D(l.quantity), unit: money(l.proposedPrice)!, ext: money(l.proposedPrice)!.times(D(l.quantity)).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN) }));
    const expectedTotal = expectedRows.reduce((a, r) => a.plus(r.ext), ZERO);
    expect(expectedTotal.toString()).toBe(o.revenue.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toString());

    // xlsx
    const x = await buildQuote(director.actor, fx.proposal.id, "xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.buffer as never);
    const ws = wb.getWorksheet("Proposal")!;
    const rows: (string | number | null)[][] = [];
    ws.eachRow((r) => rows.push((r.values as (string | number | null)[]).slice(1)));
    const header = rows.find((r) => r[0] === "Current Product")!;
    expect(header).toEqual(["Current Product", "Current Product Description", "Proposed Equivalent", "Description", "Equivalence", "Annual Qty", "Unit Price", "Extended", "Notes"]);
    const data = rows.filter((r) => expectedRows.some((e) => e.code === r[0]));
    expect(data.length).toBe(expectedRows.length);
    for (const e of expectedRows) {
      const r = data.find((d) => d[0] === e.code)!;
      expect(r[2]).toBe(e.sku);
      expect(r[5]).toBe(e.qty.toNumber());
      expect(r[6]).toBe(e.unit.toNumber());
      expect(r[7]).toBe(e.ext.toNumber());
    }
    const subtotal = rows.find((r) => r[0] === "SUBTOTAL")!;
    const total = rows.find((r) => r[0] === "TOTAL")!;
    expect(subtotal[7]).toBe(expectedTotal.toNumber());
    expect(total[7]).toBe(expectedTotal.toNumber()); // no freight, no tax
    expect(total[8]).toBe("excludes tax");
    expect(data.find((d) => d[0] === `${RUN}C1`)![8]).toBe("Ships in cases of 6");
    expect(rows.some((r) => r[0] === `${RUN}C5`)).toBe(false); // excluded line never printed

    // csv
    const c = await buildQuote(director.actor, fx.proposal.id, "csv");
    const csv = parseCsv(c.buffer.toString("utf8"));
    const csvTotal = csv.find((r) => r[0] === "TOTAL")!;
    expect(D(csvTotal[7]).toString()).toBe(expectedTotal.toString());
    for (const e of expectedRows) { const r = csv.find((d) => d[0] === e.code)!; expect(D(r[6]).toString()).toBe(e.unit.toString()); expect(D(r[7]).toString()).toBe(e.ext.toString()); }

    // pdf
    const pdf = await buildQuotePdf(director.actor, fx.proposal.id);
    const text = pdfText(pdf.buffer);
    // The 66 pt code / SKU columns wrap a 13-character code mid-word and pdftotext de-hyphenates at the
    // break (see report: PDF column widths), so codes are compared without whitespace or hyphens.
    const norm = (v: string) => v.replace(/[\s-]+/g, "");
    const squashed = norm(text);
    for (const e of expectedRows) { expect(squashed).toContain(norm(e.code)); expect(squashed).toContain(norm(e.sku!)); }
    const fmt = (v: Decimal) => `$${v.toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(text).toContain(fmt(expectedTotal));
    for (const e of expectedRows) expect(text).toContain(fmt(e.ext));
    expect(text).toContain("Ships in cases of 6");
    expect(squashed).not.toContain(norm(`${RUN}C5`));

    // CRM write-back payload
    await prisma.account.update({ where: { id: acct.id }, data: { externalCrmId: `001${RUN}` } });
    const crm = await buildQuoteWriteback(fx.proposal.id, true);
    const stored = JSON.parse((await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } })).economicsJson!);
    expect(crm.totalValue).toBe(stored.revenue);
    expect(crm.totalValue).toBe(o.revenue.toString());
    expect(crm.customerSavings).toBe(o.savings.toString());
    expect(crm.blendedMarginPct).toBe(o.blendedMargin!.toString());
    expect((await buildQuoteWriteback(fx.proposal.id, false)).blendedMarginPct).toBeNull(); // margin never leaves without the flag
    expect(crm.lines.map((l) => l.competitorCode)).toEqual(inc.map((l) => l.competitorCode));
    for (const l of crm.lines) { const line = inc.find((x) => x.competitorCode === l.competitorCode)!; expect(l.unitPrice).toBe(money(line.proposedPrice)!.toString()); expect(l.quantity).toBe(D(line.quantity).toString()); }
    // Approval counts after auto-approval: nothing pending or required.
    expect(stored.approvalsPending).toBe(0);
    expect(stored.approvalsRequired).toBe(0);
    // Refreshing from the same lines reproduces the same JSON (deterministic, no drift on re-rollup).
    const again = await refreshEconomics(fx.proposal.id);
    expect(again.revenue.toString()).toBe(stored.revenue);
  });
});

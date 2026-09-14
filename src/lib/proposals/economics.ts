/**
 * Deal-level economics — one authoritative rollup used by the proposal workspace,
 * scenarios, exports and analytics. Pure; lines carry their own snapshotted inputs.
 *
 * Conventions:
 *  - Only `included` lines count toward the deal.
 *  - "Competitor spend" is what the customer pays today across ALL included lines
 *    (quantity × competitor price); it is the denominator of share of wallet.
 *  - Customer savings compare competitor spend and proposed spend on lines that
 *    have BOTH prices (unpriced lines can't save anything yet).
 *  - Blended margin = gross profit / revenue over lines with a cost.
 */
import { Decimal, type Money, ZERO, ratio } from "@/lib/money";

export type EconLine = {
  id: string;
  included: boolean;
  family: string | null;
  quantity: Money;
  proposedPrice: Money | null;
  competitorPrice: Money | null;
  listPrice: Money | null;
  contractPrice: Money | null;
  cost: Money | null;
  currency: string;
  approvalState: string;
};

export type FamilyEconomics = {
  family: string;
  lines: number;
  revenue: Money;
  grossProfit: Money;
  marginPct: Money | null;
  competitorSpend: Money;
  customerSavings: Money;
};

export type DealEconomics = {
  currency: string;
  mixedCurrency: boolean;
  linesTotal: number;
  linesProposed: number;
  linesPriced: number;
  revenue: Money; // proposed spend (annual)
  listValue: Money; // what the same units cost at list
  currentContractValue: Money; // what they would pay at today's applicable contract/list price from us
  competitorSpend: Money; // what they pay the competitor today
  competitorSpendPricedLines: Money;
  customerSavings: Money; // competitorSpendPricedLines − revenue
  customerSavingsPct: Money | null;
  cogs: Money;
  grossProfit: Money;
  blendedMarginPct: Money | null;
  discountFromListPct: Money | null;
  discountFromContractPct: Money | null;
  shareOfWalletPct: Money | null; // revenue-weighted: proposed lines' competitor spend / all lines' competitor spend
  approvalsPending: number;
  approvalsRequired: number;
  byFamily: FamilyEconomics[];
};

export function rollup(lines: EconLine[], currency: string): DealEconomics {
  const inc = lines.filter((l) => l.included);
  const mixed = inc.some((l) => l.currency !== currency);
  const priced = inc.filter((l) => l.proposedPrice !== null && l.currency === currency);
  const ext = (p: Money | null, q: Money) => (p === null ? ZERO : p.times(q));

  const revenue = priced.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity)), ZERO);
  const listValue = priced.reduce((s, l) => s.plus(ext(l.listPrice, l.quantity)), ZERO);
  const currentContractValue = priced.reduce((s, l) => s.plus(ext(l.contractPrice ?? l.listPrice, l.quantity)), ZERO);
  const competitorSpend = inc.filter((l) => l.currency === currency).reduce((s, l) => s.plus(ext(l.competitorPrice, l.quantity)), ZERO);
  const pricedWithComp = priced.filter((l) => l.competitorPrice !== null);
  const competitorSpendPricedLines = pricedWithComp.reduce((s, l) => s.plus(ext(l.competitorPrice, l.quantity)), ZERO);
  const revenueWithComp = pricedWithComp.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity)), ZERO);
  const customerSavings = competitorSpendPricedLines.minus(revenueWithComp);
  const withCost = priced.filter((l) => l.cost !== null);
  const cogs = withCost.reduce((s, l) => s.plus(ext(l.cost, l.quantity)), ZERO);
  const revenueWithCost = withCost.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity)), ZERO);
  const grossProfit = revenueWithCost.minus(cogs);
  const wonWallet = pricedWithComp.reduce((s, l) => s.plus(ext(l.competitorPrice, l.quantity)), ZERO);

  const families = new Map<string, EconLine[]>();
  for (const l of priced) families.set(l.family ?? "Other", [...(families.get(l.family ?? "Other") ?? []), l]);
  const byFamily: FamilyEconomics[] = [...families.entries()].map(([family, ls]) => {
    const rev = ls.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity)), ZERO);
    const wc = ls.filter((l) => l.cost !== null);
    const gp = wc.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity).minus(ext(l.cost, l.quantity))), ZERO);
    const revWc = wc.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity)), ZERO);
    const comp = ls.filter((l) => l.competitorPrice !== null);
    const cs = comp.reduce((s, l) => s.plus(ext(l.competitorPrice, l.quantity)), ZERO);
    const cr = comp.reduce((s, l) => s.plus(ext(l.proposedPrice, l.quantity)), ZERO);
    return { family, lines: ls.length, revenue: rev, grossProfit: gp, marginPct: ratio(gp, revWc), competitorSpend: cs, customerSavings: cs.minus(cr) };
  }).sort((a, b) => b.revenue.cmp(a.revenue));

  return {
    currency,
    mixedCurrency: mixed,
    linesTotal: inc.length,
    linesProposed: priced.length,
    linesPriced: priced.length,
    revenue,
    listValue,
    currentContractValue,
    competitorSpend,
    competitorSpendPricedLines,
    customerSavings,
    customerSavingsPct: ratio(customerSavings, competitorSpendPricedLines),
    cogs,
    grossProfit,
    blendedMarginPct: ratio(grossProfit, revenueWithCost),
    discountFromListPct: listValue.isZero() ? null : listValue.minus(revenue).div(listValue),
    discountFromContractPct: currentContractValue.isZero() ? null : currentContractValue.minus(revenue).div(currentContractValue),
    shareOfWalletPct: ratio(wonWallet, competitorSpend),
    approvalsPending: inc.filter((l) => l.approvalState === "PENDING").length,
    approvalsRequired: inc.filter((l) => l.approvalState === "REQUIRED" || l.approvalState === "PENDING" || l.approvalState === "REJECTED").length,
    byFamily,
  };
}

/** JSON-safe form for storage / API. */
export function economicsToJson(e: DealEconomics) {
  const s = (v: Money | null) => (v === null ? null : v.toString());
  return {
    ...e,
    revenue: s(e.revenue), listValue: s(e.listValue), currentContractValue: s(e.currentContractValue), competitorSpend: s(e.competitorSpend), competitorSpendPricedLines: s(e.competitorSpendPricedLines),
    customerSavings: s(e.customerSavings), customerSavingsPct: s(e.customerSavingsPct), cogs: s(e.cogs), grossProfit: s(e.grossProfit), blendedMarginPct: s(e.blendedMarginPct),
    discountFromListPct: s(e.discountFromListPct), discountFromContractPct: s(e.discountFromContractPct), shareOfWalletPct: s(e.shareOfWalletPct),
    byFamily: e.byFamily.map((f) => ({ ...f, revenue: s(f.revenue), grossProfit: s(f.grossProfit), marginPct: s(f.marginPct), competitorSpend: s(f.competitorSpend), customerSavings: s(f.customerSavings) })),
  };
}
export type DealEconomicsJson = ReturnType<typeof economicsToJson>;

export { Decimal };

/**
 * Price recommendation — deterministic commercial rules, explainable, per line.
 *
 * Inputs are everything a pricing analyst would look at; the output is a price, the
 * bounds it was derived from (floor / target / ceiling), the economics at that price,
 * the approval authority it needs, and a paragraph built from the actual numbers.
 * Statistical or model assistance may *suggest* a strategy or adjustment; it never
 * bypasses these rules.
 */
import { Decimal, money, type Money, marginPct, marginAmount, discountPct, priceForMargin, clamp, round } from "@/lib/money";
import { type Policy, type Strategy } from "./policy-model";
import { authorityRank, AUTHORITY_ORDER } from "@/lib/auth/permissions";

export type RecommendInput = {
  currency: string;
  quantity: Money;
  listPrice: Money | null;
  contractPrice: Money | null; // currently applicable (GPO/IDN/LOCAL) or null
  contractSource: string | null;
  cost: Money | null;
  competitorPrice: Money | null;
  competitorConfidence: number; // 0..1
  competitorBasis: "KNOWN_ACCOUNT" | "MARKET_ESTIMATE" | "WEAK" | "NONE";
  policy: Policy;
  strategy?: Strategy | null; // override
  adjustmentPct?: number | null; // override for UNDERCUT_PCT / HOLD_PREMIUM
  adjustmentAmount?: number | null; // for UNDERCUT_AMOUNT
  strategicAccount?: boolean;
  bundleBenefitPct?: number | null; // negative = discount granted by a bundle term
  dealValue?: Money | null;
  contractMonths?: number | null;
  justification?: string | null; // clinical/product justification for premium
};

export type Recommendation = {
  recommendedPrice: Money | null;
  floorPrice: Money | null;
  targetPrice: Money | null;
  ceilingPrice: Money | null; // competitor reference used as the ceiling, if any
  referencePrice: Money | null; // the price we were anchored to (contract or list)
  strategy: Strategy;
  discountFromListPct: Money | null;
  discountFromContractPct: Money | null;
  marginPct: Money | null;
  marginAmount: Money | null;
  requiredAuthority: string | null; // lowest role that may approve this price; null = within rep authority
  approvalReasons: string[];
  belowFloor: boolean;
  confidence: number;
  explanation: string;
  /** the same reasoning without margin or floor figures — what roles without view_cost/view_margin see */
  explanationPublic: string;
  policyId: string;
  policyVersion: number;
};

export function floorFor(policy: Policy, cost: Money | null, list: Money | null): Money | null {
  switch (policy.floorMethod) {
    case "FIXED": return policy.floorParams.fixed != null ? new Decimal(policy.floorParams.fixed) : null;
    case "PCT_OF_LIST": return list && policy.floorParams.pctOfList != null ? list.times(policy.floorParams.pctOfList) : null;
    default: return priceForMargin(cost, policy.floorParams.minMarginPct ?? policy.minMarginPct);
  }
}

/**
 * Lowest role whose discount authority covers `discount`; committee if none.
 * The discount measured is the *incremental* one: below the customer's currently
 * applicable contract price when there is one, otherwise below list. Quoting the
 * price a customer already pays under a contract never needs approval by itself.
 */
export function authorityForDiscount(policy: Policy, discount: Money | null): string | null {
  if (discount === null || discount.lte(0)) return null;
  const d = discount.toNumber();
  for (const role of AUTHORITY_ORDER) {
    const max = policy.authority[role];
    if (max != null && d <= max + 1e-9) return role === "SALES_REP" ? null : role;
  }
  return "PRICING_COMMITTEE";
}

const higher = (a: string | null, b: string | null): string | null => {
  if (!a) return b; if (!b) return a;
  return authorityRank(a) >= authorityRank(b) ? a : b;
};

/** Apply policy approval rules; returns the highest authority any rule demands plus reasons. */
export function approvalRequirements(policy: Policy, facts: { belowFloor: boolean; belowTargetMargin: boolean; marginPct: Money | null; discountFromList: Money | null; discountFromContract: Money | null; dealValue: Money | null; lineValue: Money | null; strategicAccount: boolean; contractMonths: number | null }): { role: string | null; reasons: string[] } {
  let role: string | null = null;
  const reasons: string[] = [];
  for (const r of policy.approvalRules) {
    const w = r.when;
    const hit =
      (w.belowFloor === undefined || w.belowFloor === facts.belowFloor) &&
      (w.belowTargetMargin === undefined || w.belowTargetMargin === facts.belowTargetMargin) &&
      (w.marginBelow === undefined || (facts.marginPct !== null && facts.marginPct.lt(w.marginBelow))) &&
      (w.discountFromListOver === undefined || (facts.discountFromList !== null && facts.discountFromList.gt(w.discountFromListOver))) &&
      (w.discountFromContractOver === undefined || (facts.discountFromContract !== null && facts.discountFromContract.gt(w.discountFromContractOver))) &&
      (w.dealValueOver === undefined || (facts.dealValue !== null && facts.dealValue.gt(w.dealValueOver))) &&
      (w.lineValueOver === undefined || (facts.lineValue !== null && facts.lineValue.gt(w.lineValueOver))) &&
      (w.strategicAccount === undefined || w.strategicAccount === facts.strategicAccount) &&
      (w.contractMonthsOver === undefined || (facts.contractMonths !== null && facts.contractMonths > w.contractMonthsOver));
    // A rule with only "belowFloor: false"-style negations shouldn't fire on nothing: require at least one positive condition.
    const positive = Object.entries(w).some(([k, v]) => v !== undefined && !(k === "belowFloor" && v === false) && !(k === "belowTargetMargin" && v === false) && !(k === "strategicAccount" && v === false));
    if (hit && positive) { role = higher(role, r.require); reasons.push(r.reason ?? `policy rule → ${r.require}`); }
  }
  return { role, reasons };
}

/** Economics of a given price against the line's inputs (the one authoritative implementation). */
export function economicsAt(price: Money | null, input: Pick<RecommendInput, "listPrice" | "contractPrice" | "cost" | "quantity" | "policy" | "strategicAccount" | "dealValue" | "contractMonths">, floor: Money | null) {
  const mPct = marginPct(price, input.cost);
  const mAmt = marginAmount(price, input.cost);
  const dList = discountPct(price, input.listPrice);
  const dContract = discountPct(price, input.contractPrice);
  const belowFloor = Boolean(price && floor && price.lt(floor));
  const belowTarget = Boolean(mPct && mPct.lt(input.policy.targetMarginPct));
  const lineValue = price ? price.times(input.quantity) : null;
  const incremental = input.contractPrice ? dContract : dList;
  const byDiscount = authorityForDiscount(input.policy, incremental);
  const rules = approvalRequirements(input.policy, { belowFloor, belowTargetMargin: belowTarget, marginPct: mPct, discountFromList: dList, discountFromContract: dContract, dealValue: input.dealValue ?? null, lineValue, strategicAccount: Boolean(input.strategicAccount), contractMonths: input.contractMonths ?? null });
  const reasons = [...rules.reasons];
  if (byDiscount) reasons.unshift(`${incremental ? incremental.times(100).toFixed(1) : "?"}% below ${input.contractPrice ? "the current contract price" : "list"} exceeds rep authority`);
  return { marginPct: mPct, marginAmount: mAmt, discountFromListPct: dList, discountFromContractPct: dContract, belowFloor, belowTargetMargin: belowTarget, lineValue, requiredAuthority: higher(byDiscount, rules.role), approvalReasons: reasons };
}

export function recommend(input: RecommendInput): Recommendation {
  const p = input.policy;
  const strategy: Strategy = input.strategy ?? p.defaultStrategy;
  const floor = floorFor(p, input.cost, input.listPrice);
  const target = priceForMargin(input.cost, p.targetMarginPct);
  const reference = input.contractPrice ?? input.listPrice; // what the customer pays today from us, else list
  const compUsable = input.competitorPrice !== null && input.competitorBasis !== "NONE" && (input.competitorBasis === "KNOWN_ACCOUNT" || input.competitorConfidence >= 0.4);
  const ceiling = compUsable ? input.competitorPrice : null;
  const notes: string[] = [];

  let price: Money | null = null;
  const pctAdj = input.adjustmentPct ?? p.defaultAdjustmentPct;
  switch (strategy) {
    case "PRESERVE_CONTRACT":
      price = reference; notes.push(reference ? `holds the current ${input.contractSource ?? "list"} price` : "no current price to preserve"); break;
    case "MATCH":
      if (ceiling) { price = ceiling; notes.push(`matches the competitor reference ${fmt(ceiling)}`); }
      else { price = target ?? reference; notes.push(ceiling === null && input.competitorPrice ? "competitor price too weak to anchor on; priced at target margin" : "no competitor price; priced at target margin"); }
      break;
    case "UNDERCUT_PCT":
      if (ceiling) { price = ceiling.times(new Decimal(1).minus(Math.abs(pctAdj || 0.025))); notes.push(`${(Math.abs(pctAdj || 0.025) * 100).toFixed(1)}% below the competitor reference ${fmt(ceiling)}`); }
      else { price = target ?? reference; notes.push("no usable competitor price to undercut; priced at target margin"); }
      break;
    case "UNDERCUT_AMOUNT":
      if (ceiling) { const amt = new Decimal(Math.abs(input.adjustmentAmount ?? 0)); price = ceiling.minus(amt); notes.push(`${fmt(amt)} below the competitor reference ${fmt(ceiling)}`); }
      else { price = target ?? reference; notes.push("no usable competitor price to undercut; priced at target margin"); }
      break;
    case "HOLD_PREMIUM":
      if (ceiling) { price = ceiling.times(new Decimal(1).plus(Math.abs(pctAdj || 0.05))); notes.push(`${(Math.abs(pctAdj || 0.05) * 100).toFixed(1)}% premium over the competitor reference ${fmt(ceiling)}${input.justification ? ` (justification: ${input.justification})` : " — add a clinical/product justification"}`); }
      else { price = reference ?? target; notes.push("no competitor price; premium held at current price"); }
      break;
    case "STRATEGIC_DISCOUNT":
      price = (reference ?? target)?.times(new Decimal(1).minus(Math.abs(pctAdj || 0.15))) ?? null; notes.push(`strategic ${(Math.abs(pctAdj || 0.15) * 100).toFixed(0)}% discount from ${input.contractPrice ? "current contract" : "list"}`); break;
    case "PENETRATION":
      price = floor ? floor.times(1.02) : target; notes.push("commodity penetration price just above floor"); break;
  }
  if (price !== null && input.bundleBenefitPct) { price = price.times(new Decimal(1).plus(input.bundleBenefitPct)); notes.push(`bundle term adjusts by ${(input.bundleBenefitPct * 100).toFixed(1)}%`); }

  // Never below floor by recommendation; never above what they pay today (or list) unless holding premium deliberately.
  let clamped = false;
  if (price !== null) {
    const hi = strategy === "HOLD_PREMIUM" ? input.listPrice : reference ?? input.listPrice;
    const before = price;
    price = clamp(price, floor, hi);
    clamped = !price.eq(before);
    if (clamped) notes.push(floor && before.lt(floor) ? `raised to the floor ${fmt(floor)}` : `capped at ${hi === input.listPrice ? "list" : "the current price"} ${fmt(hi)}`);
    price = round(price, input.currency);
  }

  const econ = economicsAt(price, input, floor);
  // Two explanations: the full one (margin, floor distance) for roles that may see cost and margin,
  // and a public one that says everything except those figures. Redaction picks the right one.
  const discountText = (econ.discountFromListPct ? `, ${econ.discountFromListPct.times(100).toFixed(1)}% off list` : "") +
    (input.contractPrice && econ.discountFromContractPct ? `, ${econ.discountFromContractPct.times(100).toFixed(1)}% below the current ${input.contractSource ?? "contract"} price` : "");
  const authorityText = `. ${econ.requiredAuthority ? `Needs ${econ.requiredAuthority.replace(/_/g, " ").toLowerCase()} approval (${econ.approvalReasons.join("; ")}).` : "Within sales-rep authority."}` +
    (input.competitorBasis === "WEAK" ? " Competitor price intelligence is weak — verify before quoting." : "");
  const explanation = price === null
    ? `No recommendation: ${notes.join("; ")}.`
    : `Recommend ${fmt(price)}: ${notes.join("; ")}. ` +
      (econ.marginPct ? `Gross margin ${econ.marginPct.times(100).toFixed(1)}% (${fmt(econ.marginAmount)}/unit)` : "Margin unknown (no cost on file)") +
      (floor ? `, ${price.gte(floor) ? `${fmt(price.minus(floor))} above` : `${fmt(floor.minus(price))} BELOW`} the ${p.productFamily === "*" ? "default" : p.productFamily} floor ${fmt(floor)}` : "") +
      discountText + authorityText;
  const explanationPublic = price === null
    ? `No recommendation: ${notes.join("; ")}.`
    : `Recommend ${fmt(price)}: ${notes.join("; ")}${floor && price.lt(floor) ? ". Below the pricing floor" : ""}${discountText.replace(/^, /, ". ")}` + authorityText;

  const confidence = price === null ? 0 : Math.min(1, 0.35 + (input.cost ? 0.2 : 0) + (compUsable ? 0.25 * input.competitorConfidence + 0.1 : 0) + (input.contractPrice ? 0.1 : 0));

  return {
    recommendedPrice: price,
    floorPrice: floor ? round(floor, input.currency) : null,
    targetPrice: target ? round(target, input.currency) : null,
    ceilingPrice: ceiling,
    referencePrice: reference,
    strategy,
    discountFromListPct: econ.discountFromListPct,
    discountFromContractPct: econ.discountFromContractPct,
    marginPct: econ.marginPct,
    marginAmount: econ.marginAmount,
    requiredAuthority: econ.requiredAuthority,
    approvalReasons: econ.approvalReasons,
    belowFloor: econ.belowFloor,
    confidence,
    explanation,
    explanationPublic,
    policyId: p.id,
    policyVersion: p.version,
  };
}

function fmt(v: Money | null): string {
  return v === null ? "—" : `$${v.toFixed(2)}`;
}

export { money };

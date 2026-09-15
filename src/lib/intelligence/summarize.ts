/**
 * Competitive price intelligence — pure aggregation over observations.
 *
 * Raw confidence (what the source deserves) is never modified. *Current* confidence
 * is computed at read time from source reliability, verification, age (half-life by
 * source), and how relevant the observation is to the account being priced
 * (same account > same GPO > same region > anywhere). The summary tells the rep
 * which of three things they are looking at: a KNOWN account price, a MARKET
 * estimate, or WEAK / stale intelligence.
 */
import { Decimal, money, type Money, ZERO } from "@/lib/money";

export const SOURCE_TYPES = ["CUSTOMER_INVOICE", "CUSTOMER_PO", "CUSTOMER_BID_FILE", "GPO_CONTRACT_FILE", "WIN_LOSS_RECORD", "INTERNAL_VERIFIED", "REP_OBSERVED", "ANECDOTAL"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Reliability of the source itself and how fast it goes stale (half-life in days). */
export const SOURCE_PROFILE: Record<SourceType, { reliability: number; halfLifeDays: number; label: string }> = {
  CUSTOMER_INVOICE: { reliability: 1.0, halfLifeDays: 365, label: "customer invoice" },
  CUSTOMER_PO: { reliability: 0.95, halfLifeDays: 365, label: "customer PO" },
  CUSTOMER_BID_FILE: { reliability: 0.9, halfLifeDays: 270, label: "customer bid file" },
  GPO_CONTRACT_FILE: { reliability: 0.85, halfLifeDays: 540, label: "GPO contract file" },
  WIN_LOSS_RECORD: { reliability: 0.8, halfLifeDays: 365, label: "win/loss record" },
  INTERNAL_VERIFIED: { reliability: 0.75, halfLifeDays: 270, label: "verified internal record" },
  REP_OBSERVED: { reliability: 0.55, halfLifeDays: 180, label: "rep-observed" },
  ANECDOTAL: { reliability: 0.35, halfLifeDays: 120, label: "anecdotal" },
};

export function defaultRawConfidence(sourceType: string): number {
  return SOURCE_PROFILE[sourceType as SourceType]?.reliability ?? 0.35;
}

export type ObservationInput = {
  id: string;
  competitorSku: string;
  price: unknown;
  currency: string;
  uom: string;
  accountId: string | null;
  gpoId: string | null;
  region: string | null;
  observedAt: Date;
  sourceType: string;
  rawConfidence: number;
  verificationStatus: string;
};

export type Context = { accountId: string | null; gpoId: string | null; region: string | null; asOf: Date; currency: string; /** unit the reference price must be in (default EA); observations in another UOM are excluded, never converted */ uom?: string };

export type WeightedObservation = ObservationInput & { ageDays: number; ageFactor: number; relevance: number; verificationFactor: number; currentConfidence: number; weight: number; relation: "ACCOUNT" | "GPO" | "REGION" | "MARKET" };

export function weigh(o: ObservationInput, ctx: Context): WeightedObservation {
  const prof = SOURCE_PROFILE[o.sourceType as SourceType] ?? SOURCE_PROFILE.ANECDOTAL;
  const ageDays = Math.max(0, (ctx.asOf.getTime() - o.observedAt.getTime()) / 86_400_000);
  const ageFactor = Math.pow(0.5, ageDays / prof.halfLifeDays);
  const verificationFactor = o.verificationStatus === "VERIFIED" ? 1.0 : o.verificationStatus === "DISPUTED" ? 0.4 : 0.85;
  const relation: WeightedObservation["relation"] = ctx.accountId && o.accountId === ctx.accountId ? "ACCOUNT" : ctx.gpoId && o.gpoId === ctx.gpoId ? "GPO" : ctx.region && o.region && o.region.toLowerCase() === ctx.region.toLowerCase() ? "REGION" : "MARKET";
  const relevance = relation === "ACCOUNT" ? 1.0 : relation === "GPO" ? 0.85 : relation === "REGION" ? 0.7 : 0.55;
  const currentConfidence = Math.min(1, o.rawConfidence * verificationFactor * ageFactor);
  return { ...o, ageDays, ageFactor, relevance, verificationFactor, currentConfidence, weight: currentConfidence * relevance, relation };
}

export type PriceSummary = {
  competitorSku: string;
  currency: string;
  basis: "KNOWN_ACCOUNT" | "MARKET_ESTIMATE" | "WEAK" | "NONE";
  reference: Money | null; // the price the recommendation engine should use
  confidence: number; // 0..1, of the reference
  accountPrice: Money | null;
  gpoPrice: Money | null;
  mostRecent: { price: Money; observedAt: string; sourceType: string; relation: string } | null;
  median: Money | null;
  weightedAverage: Money | null;
  min: Money | null;
  max: Money | null;
  count: number;
  countUsed: number;
  trend: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  observations: WeightedObservation[];
  explanation: string;
};

function weightedMedian(items: { v: Decimal; w: number }[]): Decimal | null {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.v.cmp(b.v));
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) { acc += x.w; if (acc >= total / 2) return x.v; }
  return sorted[sorted.length - 1].v;
}

export function summarize(observations: ObservationInput[], ctx: Context): PriceSummary {
  // Same currency AND same unit of measure: a case price compared with a unit price manufactures a
  // discount that does not exist. Nothing converts UOMs silently.
  const uom = (ctx.uom ?? "EA").toUpperCase();
  const sameCcy = observations.filter((o) => o.currency === ctx.currency && (o.uom ?? "EA").toUpperCase() === uom);
  const uomMismatch = observations.filter((o) => o.currency === ctx.currency && (o.uom ?? "EA").toUpperCase() !== uom).length;
  const weighted = sameCcy.map((o) => weigh(o, ctx)).sort((a, b) => b.weight - a.weight);
  const empty: PriceSummary = { competitorSku: observations[0]?.competitorSku ?? "", currency: ctx.currency, basis: "NONE", reference: null, confidence: 0, accountPrice: null, gpoPrice: null, mostRecent: null, median: null, weightedAverage: null, min: null, max: null, count: observations.length, countUsed: 0, trend: "UNKNOWN", observations: weighted, explanation: observations.length ? `${observations.length} observation(s) exist but none in ${ctx.currency} per ${uom}${uomMismatch ? ` (${uomMismatch} in another unit of measure — not comparable)` : ""}` : "no competitor price observations" };
  if (!weighted.length) return empty;

  const used = weighted.filter((o) => o.currentConfidence >= 0.05);
  const items = used.map((o) => ({ v: money(o.price as never)!, w: o.weight }));
  const wsum = items.reduce((s, x) => s + x.w, 0);
  const weightedAverage = wsum > 0 ? items.reduce((s, x) => s.plus(x.v.times(x.w)), ZERO).div(wsum) : null;
  const median = weightedMedian(items);
  const prices = items.map((x) => x.v);
  const min = prices.length ? prices.reduce((a, b) => (a.lte(b) ? a : b)) : null;
  const max = prices.length ? prices.reduce((a, b) => (a.gte(b) ? a : b)) : null;
  const byDate = [...used].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const mostRecent = byDate[0] ? { price: money(byDate[0].price as never)!, observedAt: byDate[0].observedAt.toISOString(), sourceType: byDate[0].sourceType, relation: byDate[0].relation } : null;

  // Trend: compare the weighted mean of the newest third with the oldest third.
  let trend: PriceSummary["trend"] = "UNKNOWN";
  if (byDate.length >= 3) {
    const k = Math.max(1, Math.floor(byDate.length / 3));
    const mean = (xs: WeightedObservation[]) => xs.reduce((s, o) => s.plus(money(o.price as never)!), ZERO).div(xs.length);
    const newest = mean(byDate.slice(0, k)), oldest = mean(byDate.slice(-k));
    const delta = newest.minus(oldest).div(oldest);
    trend = delta.gt(0.03) ? "UP" : delta.lt(-0.03) ? "DOWN" : "FLAT";
  }

  const account = used.filter((o) => o.relation === "ACCOUNT").sort((a, b) => b.weight - a.weight)[0] ?? null;
  const gpo = used.filter((o) => o.relation === "GPO").sort((a, b) => b.weight - a.weight)[0] ?? null;
  const accountPrice = account ? money(account.price as never) : null;
  const gpoPrice = gpo ? money(gpo.price as never) : null;

  let basis: PriceSummary["basis"];
  let reference: Money | null;
  let confidence: number;
  let explanation: string;
  if (account && account.currentConfidence >= 0.4) {
    basis = "KNOWN_ACCOUNT"; reference = accountPrice; confidence = account.currentConfidence;
    explanation = `Known account price ${reference} from ${SOURCE_PROFILE[account.sourceType as SourceType]?.label ?? account.sourceType} ${Math.round(account.ageDays)} days ago (confidence ${confidence.toFixed(2)}).`;
  } else if (used.length && wsum >= 0.4) {
    basis = "MARKET_ESTIMATE"; reference = median; confidence = Math.min(0.9, wsum / (wsum + 1) + (used.length >= 3 ? 0.15 : 0));
    explanation = `Market estimate ${reference} (weighted median of ${used.length} observation(s)${gpo ? `, incl. same-GPO ${gpoPrice}` : ""}; range ${min}–${max}; trend ${trend.toLowerCase()}).`;
  } else if (used.length) {
    basis = "WEAK"; reference = median; confidence = Math.min(0.39, wsum);
    explanation = `Weak / stale intelligence: ${used.length} observation(s), best confidence ${weighted[0].currentConfidence.toFixed(2)} (${Math.round(weighted[0].ageDays)} days old, ${SOURCE_PROFILE[weighted[0].sourceType as SourceType]?.label ?? weighted[0].sourceType}). Treat ${reference} as indicative only.`;
  } else {
    return { ...empty, observations: weighted, explanation: "observations exist but have decayed to no usable confidence" };
  }
  return { competitorSku: weighted[0].competitorSku, currency: ctx.currency, basis, reference, confidence, accountPrice, gpoPrice, mostRecent, median, weightedAverage, min, max, count: observations.length, countUsed: used.length, trend, observations: weighted, explanation };
}

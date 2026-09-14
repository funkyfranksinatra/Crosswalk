/**
 * Analytics read models over the commercial facts (proposals, outcomes, approvals,
 * match decisions, observations, purchases). Plain SQL/Prisma aggregations; no
 * warehouse in v1. "Rep acceptance" and "validated accuracy" are reported separately.
 */
import { prisma } from "@/lib/db";
import { money, ratio, ZERO, type Money } from "@/lib/money";

const pct = (n: number, d: number) => (d ? n / d : null);
const bucket = (d: Money | null) => (d === null ? "unknown" : d.lt(0.1) ? "0–10%" : d.lt(0.2) ? "10–20%" : d.lt(0.3) ? "20–30%" : d.lt(0.4) ? "30–40%" : d.lt(0.5) ? "40–50%" : "50%+");

function group<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

export async function winLoss() {
  const outcomes = await prisma.dealOutcome.findMany({ include: { proposal: { include: { account: true, lines: true } }, competitor: true } });
  const decided = outcomes.filter((o) => o.outcome === "WON" || o.outcome === "LOST");
  const won = decided.filter((o) => o.outcome === "WON").length;
  const by = <T,>(label: string, key: (o: (typeof outcomes)[number]) => string) => [...group(decided, key).entries()].map(([k, os]) => ({ [label]: k, deals: os.length, won: os.filter((o) => o.outcome === "WON").length, winRate: pct(os.filter((o) => o.outcome === "WON").length, os.length), value: os.reduce((s, o) => s.plus(money(o.finalValue) ?? ZERO), ZERO).toString() }));
  // Discount band of the deal (from economics snapshot)
  const band = (o: (typeof outcomes)[number]) => { try { const e = JSON.parse(o.proposal.economicsJson ?? "{}"); return bucket(money(e.discountFromListPct)); } catch { return "unknown"; } };
  const familyRows: { family: string; deals: number; won: number }[] = [];
  const fam = new Map<string, { deals: number; won: number }>();
  for (const o of decided) for (const f of new Set(o.proposal.lines.filter((l) => l.included).map((l) => l.productFamily ?? "Other"))) { const c = fam.get(f) ?? { deals: 0, won: 0 }; fam.set(f, { deals: c.deals + 1, won: c.won + (o.outcome === "WON" ? 1 : 0) }); }
  for (const [family, v] of fam) familyRows.push({ family, ...v });
  return {
    deals: decided.length, won, lost: decided.length - won, winRate: pct(won, decided.length),
    byCompetitor: by("competitor", (o) => o.competitor?.name ?? "unknown"),
    bySegment: by("segment", (o) => o.proposal.account.segment ?? "unknown"),
    byGpo: by("gpo", (o) => o.proposal.gpoNameSnapshot ?? "none"),
    byRep: by("rep", (o) => o.proposal.ownerUserId ?? "unknown"),
    byDiscountBand: by("band", band),
    byFamily: familyRows.map((r) => ({ ...r, winRate: pct(r.won, r.deals) })),
    lossReasons: [...group(decided.filter((o) => o.outcome === "LOST"), (o) => o.priceReason ?? o.commercialReason ?? "unspecified").entries()].map(([reason, os]) => ({ reason, count: os.length })),
  };
}

export async function pricingEffectiveness() {
  const lines = await prisma.proposalLine.findMany({ where: { included: true, proposedPrice: { not: null } }, include: { proposal: { include: { outcome: true } } } });
  const wonLines = lines.filter((l) => l.proposal.outcome?.outcome === "WON");
  const discounts = wonLines.map((l) => money(l.discountFromListPct)).filter((d): d is Money => d !== null).sort((a, b) => a.cmp(b));
  const avg = discounts.length ? discounts.reduce((s, d) => s.plus(d), ZERO).div(discounts.length) : null;
  const median = discounts.length ? discounts[Math.floor(discounts.length / 2)] : null;
  const recVsFinal = lines.filter((l) => l.recommendedPrice && l.proposedPrice).map((l) => ratio(money(l.proposedPrice)!.minus(money(l.recommendedPrice)!), money(l.recommendedPrice)!)!);
  const deviation = recVsFinal.length ? recVsFinal.reduce((s, d) => s.plus(d.abs()), ZERO).div(recVsFinal.length) : null;
  const approvals = await prisma.approvalRequest.findMany();
  const floorExceptions = lines.filter((l) => l.floorPrice && l.proposedPrice && money(l.proposedPrice)!.lt(money(l.floorPrice)!)).length;
  const marginByMonth = [...group(wonLines, (l) => l.createdAt.toISOString().slice(0, 7)).entries()].sort().map(([month, ls]) => { const rev = ls.reduce((s, l) => s.plus(money(l.proposedPrice)!.times(money(l.quantity)!)), ZERO); const gp = ls.filter((l) => l.cost).reduce((s, l) => s.plus(money(l.proposedPrice)!.minus(money(l.cost)!).times(money(l.quantity)!)), ZERO); return { month, revenue: rev.toString(), marginPct: ratio(gp, rev)?.toString() ?? null }; });
  const spread = await prisma.competitorPriceObservation.groupBy({ by: ["competitorSku"], _min: { price: true }, _max: { price: true }, _count: { _all: true } });
  return {
    linesPriced: lines.length, linesWon: wonLines.length,
    avgDiscountToWin: avg?.toString() ?? null, medianDiscountToWin: median?.toString() ?? null,
    avgAbsDeviationFromRecommendation: deviation?.toString() ?? null,
    recommendationFollowedPct: pct(lines.filter((l) => l.recommendedPrice && l.proposedPrice && money(l.recommendedPrice)!.eq(money(l.proposedPrice)!)).length, lines.filter((l) => l.recommendedPrice).length),
    floorExceptions, approvalsTotal: approvals.length, approvalsApproved: approvals.filter((a) => a.status === "APPROVED").length, approvalsRejected: approvals.filter((a) => a.status === "REJECTED").length,
    approvalFrequencyPct: pct(lines.filter((l) => l.requiredAuthority).length, lines.length),
    marginTrend: marginByMonth,
    competitorPriceSpread: spread.slice(0, 50).map((s) => ({ sku: s.competitorSku, min: s._min.price?.toString() ?? null, max: s._max.price?.toString() ?? null, observations: s._count._all })),
  };
}

export async function conversion() {
  const proposals = await prisma.proposal.findMany({ include: { lines: true, outcome: true } });
  const proposed = proposals.flatMap((p) => p.lines.filter((l) => l.included));
  const accepted = proposed.filter((l) => l.approvalState === "APPROVED" || l.approvalState === "NOT_REQUIRED");
  const wonLines = proposals.filter((p) => p.outcome?.outcome === "WON").flatMap((p) => p.lines.filter((l) => l.included));
  const purchases = await prisma.purchaseRecord.findMany({ where: { proposalId: { not: null } } });
  const convertedSkus = new Set(purchases.map((r) => `${r.proposalId}:${r.sku.toUpperCase()}`));
  const converted = wonLines.filter((l) => l.sku && convertedSkus.has(`${l.proposalId}:${l.sku.toUpperCase()}`));
  const byKey = (label: string, key: (l: (typeof wonLines)[number]) => string) => [...group(wonLines, key).entries()].map(([k, ls]) => ({ [label]: k, won: ls.length, converted: ls.filter((l) => l.sku && convertedSkus.has(`${l.proposalId}:${l.sku!.toUpperCase()}`)).length }));
  return { proposed: proposed.length, accepted: accepted.length, won: wonLines.length, converted: converted.length, conversionRate: pct(converted.length, wonLines.length), byFamily: byKey("family", (l) => l.productFamily ?? "Other"), byCompetitor: byKey("competitor", (l) => l.competitorName ?? "unknown") };
}

/** Cross-reference acceptance dashboard. Acceptance ≠ validated accuracy: both reported. */
export async function crossReferenceAccuracy() {
  const decisions = await prisma.matchDecision.findMany({ orderBy: { at: "asc" } });
  const acc = (ds: typeof decisions) => pct(ds.filter((d) => d.acceptedTop).length, ds.length);
  const validated = decisions.filter((d) => d.groundTruth !== "UNKNOWN");
  return {
    decisions: decisions.length,
    top1AcceptanceRate: acc(decisions),
    overrideRate: pct(decisions.filter((d) => !d.acceptedTop).length, decisions.length),
    validatedAccuracy: pct(validated.filter((d) => d.groundTruth === "VALIDATED_CORRECT").length, validated.length),
    validatedCount: validated.length,
    byFamily: [...group(decisions, (d) => d.productFamily ?? "Other").entries()].map(([family, ds]) => ({ family, decisions: ds.length, acceptance: acc(ds) })),
    byCompetitor: [...group(decisions, (d) => d.competitorName ?? "unknown").entries()].map(([competitor, ds]) => ({ competitor, decisions: ds.length, acceptance: acc(ds) })),
    overTime: [...group(decisions, (d) => d.at.toISOString().slice(0, 7)).entries()].sort().map(([month, ds]) => ({ month, decisions: ds.length, acceptance: acc(ds) })),
    overrideReasons: [...group(decisions.filter((d) => !d.acceptedTop && d.overrideReason), (d) => d.overrideReason!).entries()].map(([reason, ds]) => ({ reason, count: ds.length })).slice(0, 20),
    avgConfidenceAccepted: decisions.filter((d) => d.acceptedTop && d.confidence != null).reduce((s, d, _, a) => s + (d.confidence ?? 0) / a.length, 0),
    avgConfidenceOverridden: decisions.filter((d) => !d.acceptedTop && d.confidence != null).reduce((s, d, _, a) => s + (d.confidence ?? 0) / a.length, 0),
  };
}

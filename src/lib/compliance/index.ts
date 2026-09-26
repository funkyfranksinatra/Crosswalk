/**
 * Post-win compliance: did the customer deliver the business they committed to?
 * Computed from PurchaseRecord rows (ERP feed or import) against contract
 * commitments and won-proposal lines. Results are cached on Contract.performanceJson
 * and never replace the underlying records.
 */
import { prisma } from "@/lib/db";
import { money, ratio, ZERO, type Money } from "@/lib/money";
import { effectiveNet, rebateBasisValue } from "@/lib/contracts/rebates";

export type CommitmentStatus = {
  commitmentId: string;
  productFamily: string | null;
  productId: string | null;
  periodStart: string;
  periodEnd: string;
  committedUnits: string | null;
  committedValue: string | null;
  actualUnits: string;
  actualValue: string;
  unitsPct: string | null;
  valuePct: string | null;
  elapsedPct: string;
  status: "ON_TRACK" | "AT_RISK" | "MISSED" | "MET" | "NOT_STARTED";
};

export type ContractPerformance = {
  contractId: string;
  asOf: string;
  commitments: CommitmentStatus[];
  rebates: { rebateId: string; type: string; basis: string; measured: string; tier: unknown; next: unknown; toNext: string | null; rebate: string; net: string }[];
  flags: string[];
  totalActualValue: string;
  totalActualUnits: string;
};

function statusFor(pct: Money | null, elapsed: Money, ended: boolean): CommitmentStatus["status"] {
  if (pct === null) return "NOT_STARTED";
  if (pct.gte(1)) return "MET";
  if (ended) return "MISSED";
  if (elapsed.lte(0.1)) return "NOT_STARTED";
  // Behind pace by more than 20 % of the elapsed share → at risk.
  return pct.lt(elapsed.times(0.8)) ? "AT_RISK" : "ON_TRACK";
}

export async function contractPerformance(contractId: string, asOf = new Date()): Promise<ContractPerformance> {
  const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, include: { commitments: true, rebates: true } });
  const purchases = await prisma.purchaseRecord.findMany({ where: { OR: [{ contractId }, ...(c.accountId ? [{ accountId: c.accountId, contractId: null, invoiceDate: { gte: c.effectiveFrom, ...(c.effectiveTo ? { lt: c.effectiveTo } : {}) } }] : [])] }, include: { product: { select: { category: true } } } });
  const flags: string[] = [];
  const commitments: CommitmentStatus[] = c.commitments.map((k) => {
    const inPeriod = purchases.filter((p) => p.invoiceDate >= k.periodStart && p.invoiceDate < k.periodEnd && (!k.productId || p.productId === k.productId) && (!k.productFamily || (p.product?.category ?? "").toLowerCase() === k.productFamily.toLowerCase()));
    const units = inPeriod.reduce((s, p) => s.plus(money(p.quantity)!), ZERO);
    const value = inPeriod.reduce((s, p) => s.plus(money(p.netPrice)!.times(money(p.quantity)!)), ZERO);
    const total = k.periodEnd.getTime() - k.periodStart.getTime();
    const elapsed = money(Math.min(1, Math.max(0, (asOf.getTime() - k.periodStart.getTime()) / total)))!;
    const unitsPct = ratio(units, k.committedUnits);
    const valuePct = ratio(value, k.committedValue);
    const status = statusFor(unitsPct ?? valuePct, elapsed, asOf >= k.periodEnd);
    if (status === "AT_RISK") flags.push(`Commitment ${k.productFamily ?? k.productId ?? "contract"} at risk: ${((unitsPct ?? valuePct)!.times(100)).toFixed(0)}% delivered with ${elapsed.times(100).toFixed(0)}% of the period elapsed`);
    if (status === "MISSED") flags.push(`Commitment ${k.productFamily ?? k.productId ?? "contract"} missed`);
    return { commitmentId: k.id, productFamily: k.productFamily, productId: k.productId, periodStart: k.periodStart.toISOString(), periodEnd: k.periodEnd.toISOString(), committedUnits: k.committedUnits?.toString() ?? null, committedValue: k.committedValue?.toString() ?? null, actualUnits: units.toString(), actualValue: value.toString(), unitsPct: unitsPct?.toString() ?? null, valuePct: valuePct?.toString() ?? null, elapsedPct: elapsed.toString(), status };
  });
  const totalUnits = purchases.reduce((s, p) => s.plus(money(p.quantity)!), ZERO);
  const totalValue = purchases.reduce((s, p) => s.plus(money(p.netPrice)!.times(money(p.quantity)!)), ZERO);
  const rebates = c.rebates.map((r) => {
    const rows = r.productFamily ? purchases.filter((p) => (p.product?.category ?? "").toLowerCase() === r.productFamily!.toLowerCase()) : purchases;
    const units = rows.reduce((s, p) => s.plus(money(p.quantity)!), ZERO);
    const spend = rows.reduce((s, p) => s.plus(money(p.netPrice)!.times(money(p.quantity)!)), ZERO);
    // COMPLIANCE_PCT: delivered ÷ committed across the commitments the rebate covers (units, else value).
    // GROWTH_PCT needs a prior-period baseline this contract does not carry: measured as 0 (documented gap).
    const covered = commitments.filter((k) => !r.productFamily || (k.productFamily ?? "").toLowerCase() === r.productFamily.toLowerCase());
    const committedUnits = covered.reduce((s, k) => s.plus(money(k.committedUnits) ?? ZERO), ZERO), actualUnits = covered.reduce((s, k) => s.plus(money(k.actualUnits)!), ZERO);
    const committedValue = covered.reduce((s, k) => s.plus(money(k.committedValue) ?? ZERO), ZERO), actualValue = covered.reduce((s, k) => s.plus(money(k.actualValue)!), ZERO);
    const compliancePct = committedUnits.gt(0) ? ratio(actualUnits, committedUnits) : committedValue.gt(0) ? ratio(actualValue, committedValue) : null;
    const measured = rebateBasisValue(r.basis, units, spend, compliancePct, null);
    const e = effectiveNet({ invoiceSpend: spend, units, rebate: r, measured });
    if (e.next && e.toNext && e.toNext.lte(measured.times(0.1))) flags.push(`Rebate tier approaching: ${e.toNext} more ${r.basis.toLowerCase()} to reach ${JSON.stringify(e.next)}`);
    return { rebateId: r.id, type: r.type, basis: r.basis, measured: measured.toString(), tier: e.tier, next: e.next, toNext: e.toNext?.toString() ?? null, rebate: e.rebate.toString(), net: e.net.toString() };
  });
  if (c.effectiveTo && c.effectiveTo.getTime() - asOf.getTime() < 90 * 86_400_000 && c.effectiveTo > asOf) flags.push(`Contract expires ${c.effectiveTo.toISOString().slice(0, 10)} — renewal due`);
  const perf: ContractPerformance = { contractId, asOf: asOf.toISOString(), commitments, rebates, flags, totalActualValue: totalValue.toString(), totalActualUnits: totalUnits.toString() };
  await prisma.contract.update({ where: { id: contractId }, data: { performanceJson: JSON.stringify(perf) } });
  return perf;
}

/** Conversion of a won proposal: proposed lines vs what actually shipped since the decision. */
export async function proposalConversion(proposalId: string, asOf = new Date()) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, outcome: true } });
  const since = p.outcome?.decidedAt ?? p.decidedAt ?? p.createdAt;
  const purchases = await prisma.purchaseRecord.findMany({ where: { accountId: p.accountId, invoiceDate: { gte: since, lte: asOf } } });
  const bySku = new Map<string, { units: Money; value: Money }>();
  for (const r of purchases) {
    const cur = bySku.get(r.sku.toUpperCase()) ?? { units: ZERO, value: ZERO };
    bySku.set(r.sku.toUpperCase(), { units: cur.units.plus(money(r.quantity)!), value: cur.value.plus(money(r.netPrice)!.times(money(r.quantity)!)) });
  }
  const months = Math.max(1 / 30, (asOf.getTime() - since.getTime()) / (30.44 * 86_400_000));
  const lines = p.lines.filter((l) => l.included && l.sku).map((l) => {
    const actual = bySku.get(l.sku!.toUpperCase()) ?? { units: ZERO, value: ZERO };
    const expectedToDate = money(l.quantity)!.times(Math.min(12, months)).div(12); // annual quantity pro-rated
    const expectedRevenue = expectedToDate.times(money(l.proposedPrice) ?? ZERO);
    const expectedMargin = money(l.cost) ? expectedToDate.times((money(l.proposedPrice) ?? ZERO).minus(money(l.cost)!)) : null;
    const actualMargin = money(l.cost) ? actual.value.minus(actual.units.times(money(l.cost)!)) : null;
    return { lineId: l.id, sku: l.sku, family: l.productFamily, annualQty: l.quantity.toString(), expectedUnitsToDate: expectedToDate.toString(), actualUnits: actual.units.toString(), conversionPct: ratio(actual.units, expectedToDate)?.toString() ?? null, expectedRevenue: expectedRevenue.toString(), actualRevenue: actual.value.toString(), expectedMargin: expectedMargin?.toString() ?? null, actualMargin: actualMargin?.toString() ?? null, converted: actual.units.gt(0) };
  });
  const byFamily = new Map<string, { expected: Money; actual: Money }>();
  for (const l of lines) { const f = l.family ?? "Other"; const cur = byFamily.get(f) ?? { expected: ZERO, actual: ZERO }; byFamily.set(f, { expected: cur.expected.plus(l.expectedUnitsToDate), actual: cur.actual.plus(l.actualUnits) }); }
  const totalExpected = lines.reduce((s, l) => s.plus(l.expectedUnitsToDate), ZERO);
  const totalActual = lines.reduce((s, l) => s.plus(l.actualUnits), ZERO);
  return { proposalId, since: since.toISOString(), asOf: asOf.toISOString(), monthsElapsed: months, lines, byFamily: [...byFamily.entries()].map(([family, v]) => ({ family, expectedUnits: v.expected.toString(), actualUnits: v.actual.toString(), conversionPct: ratio(v.actual, v.expected)?.toString() ?? null })), conversionPct: ratio(totalActual, totalExpected)?.toString() ?? null, linesConverted: lines.filter((l) => l.converted).length, linesTotal: lines.length };
}

/** Renewal pipeline: contracts expiring within `days`, with performance flags. */
export async function renewalPipeline(days = 180, scope: Record<string, unknown> = {}) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);
  const rows = await prisma.contract.findMany({ where: { AND: [scope, { status: "ACTIVE", effectiveTo: { not: null, lte: until } }] }, include: { account: true, gpo: true }, orderBy: { effectiveTo: "asc" } });
  return rows.map((c) => ({ id: c.id, contractNumber: c.contractNumber, name: c.name, type: c.type, account: c.account?.name ?? c.gpo?.name ?? null, effectiveTo: c.effectiveTo!.toISOString(), daysLeft: Math.ceil((c.effectiveTo!.getTime() - now.getTime()) / 86_400_000), flags: c.performanceJson ? (JSON.parse(c.performanceJson) as ContractPerformance).flags : [], renewal: c.renewalJson ? JSON.parse(c.renewalJson) : null }));
}

/**
 * Context drift. A proposal snapshots everything a price depends on — the applicable
 * contract price, the cost basis, the pricing policy version, the published crosswalk
 * version, the account's GPO — and never follows later changes (by design: an approver
 * decides the numbers they were shown). But a draft that sits for a week while a GPO
 * contract renews or a standard cost is refreshed is quietly pricing off the old world.
 *
 * `driftFor` compares each unlocked draft's snapshot with what the same inputs resolve
 * to today and reports every difference; `refreshContext` re-snapshots an editable draft
 * (audited, proposed prices kept, derived economics recomputed). Submitted and closed
 * proposals are only ever reported on, never changed.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, toDb, round, type Money } from "@/lib/money";
import { loadPricingContext } from "@/lib/contracts/context";
import { activePolicies, policyFor } from "@/lib/pricing/policy";
import { floorFor, recommend } from "@/lib/pricing/recommend";
import { approvedCross, currentPublishedVersion } from "@/lib/xref/governance";
import { recomputeAllLines, refreshEconomics } from "./service";
import { log } from "@/lib/log";

export type Change = { field: "listPrice" | "contractPrice" | "contractPriceSource" | "cost" | "floorPrice" | "policy" | "equivalence" | "product"; from: string | null; to: string | null; note?: string };
export type LineDrift = { lineId: string; lineNo: number; sku: string | null; competitorCode: string; changes: Change[] };
export type ProposalDrift = { proposalId: string; status: string; editable: boolean; checkedAt: string; proposal: Change[]; lines: LineDrift[]; summary: { lines: number; drifted: number; byField: Record<string, number>; belowNewFloor: number } };

const s = (v: Money | null | undefined) => (v === null || v === undefined ? null : v.toFixed(4).replace(/\.?0+$/, ""));
const same = (a: Money | null, b: Money | null) => (a === null && b === null) || (a !== null && b !== null && a.eq(b));

async function liveContext(proposalId: string) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true, lines: { orderBy: { lineNo: "asc" }, include: { product: { include: { prices: { include: { pricebook: true } }, costs: true } } } } } });
  const asOf = new Date();
  const [ctx, policies, version] = await Promise.all([loadPricingContext({ accountId: p.accountId, asOf }), activePolicies(), currentPublishedVersion()]);
  return { p, ctx, policies, version, asOf };
}

export async function driftFor(proposalId: string): Promise<ProposalDrift> {
  const { p, ctx, policies, version, asOf } = await liveContext(proposalId);
  const editable = ["DRAFT", "CHANGES_REQUESTED"].includes(p.status) && !p.lockedAt;
  const proposal: Change[] = [];
  const liveGpo = ctx.primaryGpo?.id ?? null;
  if ((p.gpoIdSnapshot ?? null) !== liveGpo) proposal.push({ field: "policy", from: p.gpoNameSnapshot ?? "no GPO", to: ctx.primaryGpo ? `${ctx.primaryGpo.name}${ctx.primaryGpo.tier ? ` · ${ctx.primaryGpo.tier}` : ""}` : "no GPO", note: "GPO membership changed" });
  if ((p.contractId ?? null) !== (ctx.primaryContractId ?? null)) proposal.push({ field: "contractPriceSource", from: p.contractId ?? "no local contract", to: ctx.primaryContractId ?? "no local contract", note: "account's local contract changed" });
  if ((p.crosswalkVersionId ?? null) !== (version?.id ?? null)) proposal.push({ field: "equivalence", from: p.crosswalkVersionId ?? "none", to: version?.id ?? "none", note: `crosswalk v${version?.number ?? "—"} is now published` });

  const lines: LineDrift[] = [];
  const byField: Record<string, number> = {};
  let belowNewFloor = 0;
  for (const l of p.lines) {
    if (!l.included || !l.product) continue;
    const product = l.product;
    const qty = money(l.quantity)!;
    const price = ctx.resolvePrice({ id: product.id, sku: product.sku, category: product.category, listPrice: product.listPrice, currency: product.currency, prices: product.prices.map((e) => ({ ...e, pricebook: e.pricebook ? { name: e.pricebook.name } : null })) }, qty);
    const cost = ctx.resolveCost({ id: product.id, cogs: product.cogs, currency: product.currency, costs: product.costs });
    const listPrice = money(price.steps.find((st) => st.level === "LIST" && st.price !== null)?.price ?? null);
    const contractStep = price.source && price.source !== "LIST" ? price : null;
    const contractPrice = contractStep?.price ?? null;
    const contractSource = contractStep?.source ?? null;
    const policy = policyFor(policies, product.category);
    const cross = await approvedCross(l.competitorCode, version?.id);
    const entry = cross.entries.find((e) => e.ownSku.toUpperCase() === product.sku.toUpperCase()) ?? null;
    const equivalence = entry ? entry.equivalenceLevel : "NONE";
    const changes: Change[] = [];
    if (!same(money(l.listPrice), listPrice)) changes.push({ field: "listPrice", from: s(money(l.listPrice)), to: s(listPrice) });
    if (!same(money(l.contractPrice), contractPrice)) changes.push({ field: "contractPrice", from: s(money(l.contractPrice)), to: s(contractPrice), note: contractSource ? `now from ${contractSource}` : "no contract price applies now" });
    else if ((l.contractPriceSource ?? null) !== contractSource) changes.push({ field: "contractPriceSource", from: l.contractPriceSource, to: contractSource });
    if (!same(money(l.cost), cost.cost ?? null)) changes.push({ field: "cost", from: s(money(l.cost)), to: s(cost.cost ?? null) });
    // The floor moves with cost, list price OR the policy (a higher minimum margin, a new method) — always recompute it.
    const rawFloor = floorFor(policy, cost.cost ?? null, listPrice);
    const newFloor = rawFloor ? round(rawFloor, p.currency) : null; // stored floors are rounded to the minor unit (recommend.ts)
    if (!same(money(l.floorPrice), newFloor)) {
      changes.push({ field: "floorPrice", from: s(money(l.floorPrice)), to: s(newFloor) });
      const pp = money(l.proposedPrice);
      if (pp && newFloor && pp.lt(newFloor)) belowNewFloor++;
    }
    if ((l.policyId ?? null) !== policy.id) changes.push({ field: "policy", from: l.policyId, to: policy.id, note: `${policy.productFamily} policy v${policy.version} is now active` });
    if ((l.equivalenceLevel ?? "NONE") !== equivalence) changes.push({ field: "equivalence", from: l.equivalenceLevel, to: equivalence, note: entry ? "published cross changed" : "no published cross for this pair any more" });
    if (!product.isActive || /not in commercial/i.test(product.status ?? "")) changes.push({ field: "product", from: "active", to: product.isActive ? "not in commercial distribution" : "inactive", note: "SKU can no longer be quoted" });
    if (changes.length) { lines.push({ lineId: l.id, lineNo: l.lineNo, sku: l.sku, competitorCode: l.competitorCode, changes }); for (const c of changes) byField[c.field] = (byField[c.field] ?? 0) + 1; }
  }
  return { proposalId, status: p.status, editable, checkedAt: asOf.toISOString(), proposal, lines, summary: { lines: p.lines.filter((l) => l.included && l.product).length, drifted: lines.length, byField, belowNewFloor } };
}

/**
 * Re-snapshot an editable draft to today's context. Proposed prices are kept (the rep's
 * intent), everything derived from the context is recomputed, and the whole diff is
 * audited so the approver can see the draft was rebased.
 */
export async function refreshContext(actor: Actor, proposalId: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const before = await driftFor(proposalId);
  if (!before.editable) throw new Error(`Proposal is ${before.status.toLowerCase()}${before.status === "DRAFT" ? " but locked" : ""}; only an unlocked draft can be refreshed — reopen it first`);
  if (!before.lines.length && !before.proposal.length) return { refreshed: 0, drift: before };
  // Claim the draft for the duration (same lock submission takes), so a submit racing this refresh
  // cannot snapshot half-rewritten lines; released at the end, or if anything throws.
  const claimed = await prisma.proposal.updateMany({ where: { id: proposalId, status: { in: ["DRAFT", "CHANGES_REQUESTED"] }, lockedAt: null }, data: { lockedAt: new Date() } });
  if (claimed.count !== 1) throw new Error("Proposal is being submitted or refreshed by someone else; try again in a moment");
  try {
  const { p, ctx, policies, version, asOf } = await liveContext(proposalId);
  let refreshed = 0;
  for (const d of before.lines) {
    const l = p.lines.find((x) => x.id === d.lineId);
    if (!l || !l.product) continue;
    const product = l.product;
    const qty = money(l.quantity)!;
    const price = ctx.resolvePrice({ id: product.id, sku: product.sku, category: product.category, listPrice: product.listPrice, currency: product.currency, prices: product.prices.map((e) => ({ ...e, pricebook: e.pricebook ? { name: e.pricebook.name } : null })) }, qty);
    const cost = ctx.resolveCost({ id: product.id, cogs: product.cogs, currency: product.currency, costs: product.costs });
    const listPrice = money(price.steps.find((st) => st.level === "LIST" && st.price !== null)?.price ?? null);
    const contractStep = price.source && price.source !== "LIST" ? price : null;
    const policy = policyFor(policies, product.category);
    const cross = await approvedCross(l.competitorCode, version?.id);
    const entry = cross.entries.find((e) => e.ownSku.toUpperCase() === product.sku.toUpperCase()) ?? null;
    const rec = recommend({ currency: ctx.currency, quantity: qty, listPrice, contractPrice: contractStep?.price ?? null, contractSource: contractStep?.source ?? null, cost: cost.cost ?? null, competitorPrice: money(l.competitorPrice), competitorConfidence: l.competitorPriceConfidence ?? 0, competitorBasis: (l.competitorPriceBasis ?? "NONE") as never, policy, strategicAccount: ctx.account?.isStrategic ?? false });
    const retired = !product.isActive || /not in commercial/i.test(product.status ?? "");
    await prisma.proposalLine.update({ where: { id: l.id }, data: {
      listPrice: toDb(listPrice), contractPrice: toDb(contractStep?.price ?? null), contractPriceSource: contractStep?.source ?? null, waterfallJson: JSON.stringify({ steps: price.steps, explanation: price.explanation, asOf: price.asOf }),
      cost: toDb(cost.cost ?? null), costBasisJson: JSON.stringify(cost.basis),
      floorPrice: toDb(rec.floorPrice), targetPrice: toDb(rec.targetPrice), ceilingPrice: toDb(rec.ceilingPrice), recommendedPrice: toDb(rec.recommendedPrice), policyId: policy.id,
      crossId: entry?.knownCrossId ?? null, crosswalkVersionId: version?.id ?? null, equivalenceLevel: entry ? entry.equivalenceLevel : "NONE",
      ...(retired ? { included: false, notes: `${product.sku} is ${product.isActive ? "no longer in commercial distribution" : "inactive"}; excluded on context refresh` } : {}),
    } });
    refreshed++;
  }
  await prisma.proposal.update({ where: { id: proposalId }, data: { gpoIdSnapshot: ctx.primaryGpo?.id ?? null, gpoNameSnapshot: ctx.primaryGpo ? `${ctx.primaryGpo.name}${ctx.primaryGpo.tier ? ` · ${ctx.primaryGpo.tier}` : ""}` : null, contractId: ctx.primaryContractId, crosswalkVersionId: version?.id ?? null, policyVersionsJson: JSON.stringify(Object.fromEntries([...policies.values()].map((x) => [x.productFamily, x.id]))) } });
  const econ = await refreshEconomics(proposalId);
  await recomputeAllLines(proposalId, { dealValue: econ.revenue, strategicAccount: ctx.account?.isStrategic });
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "CONTEXT_REFRESHED", before: { checkedAt: before.checkedAt, proposal: before.proposal, lines: before.lines.map((d) => ({ line: d.lineNo, sku: d.sku, changes: d.changes })) }, after: { refreshedLines: refreshed, asOf: asOf.toISOString() } });
  log.info("proposal.context_refreshed", { proposalId, refreshed, proposalChanges: before.proposal.length });
  return { refreshed, drift: before };
  } finally {
    await prisma.proposal.updateMany({ where: { id: proposalId, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } }, data: { lockedAt: null } });
  }
}

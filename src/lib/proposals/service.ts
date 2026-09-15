/**
 * Proposals — versioned commercial artefacts built from a cross-reference request.
 *
 * Creating a proposal snapshots every input a line depends on (approved cross +
 * crosswalk version, waterfall price, cost basis, competitor intelligence,
 * recommendation + policy version). Editing a proposed price recomputes that line's
 * economics and approval requirement and writes an audit event with the
 * recommendation/floor/margin at the time. Nothing here reads live prices for an
 * existing line unless explicitly asked to refresh.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission, can } from "@/lib/auth";
import { D, money, toDb, toDbPct, round, type Money, ZERO } from "@/lib/money";
import { loadPricingContext } from "@/lib/contracts/context";
import { summariesFor, type PriceSummary } from "@/lib/intelligence";
import { activePolicies, policyFor } from "@/lib/pricing/policy";
import { recommend, economicsAt, floorFor, type Recommendation } from "@/lib/pricing/recommend";
import { type Policy, type Strategy } from "@/lib/pricing/policy-model";
import { approvedCross, currentPublishedVersion, equivalenceFromMatchType } from "@/lib/xref/governance";
import { rollup, economicsToJson, type EconLine } from "./economics";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { conditionMet, parseBundle, benefitApplies } from "@/lib/contracts/bundles";

export type LineRow = Awaited<ReturnType<typeof prisma.proposalLine.findMany>>[number];

export async function nextProposalReference(): Promise<string> {
  const last = await prisma.proposal.findFirst({ orderBy: { createdAt: "desc" }, select: { reference: true } });
  const n = last ? parseInt(last.reference.replace(/\D/g, ""), 10) || 0 : 0;
  return `PRP-${String(n + 1).padStart(4, "0")}`;
}

const EDITABLE = new Set(["DRAFT", "CHANGES_REQUESTED"]);

/** Sanity ceiling for a unit price; Decimal(18,4) allows far more, but nothing sold here costs a billion. */
export const MAX_UNIT_PRICE = D("1000000000");

export async function assertEditable(proposalId: string) {
  const p = await prisma.proposal.findUnique({ where: { id: proposalId }, select: { status: true, lockedAt: true } });
  if (!p) throw new Error("proposal not found");
  if (!EDITABLE.has(p.status) || p.lockedAt) throw new Error(`Proposal is ${p.status.toLowerCase().replace(/_/g, " ")} and locked; create a new version to change prices`);
}

// ---------------------------------------------------------------------------
// Create from a cross-reference request
// ---------------------------------------------------------------------------

export async function createFromRequest(actor: Actor, requestId: string, opts: { accountId: string; opportunityId?: string | null; asOf?: Date; validDays?: number; objectives?: string | null }) {
  requirePermission(actor, "edit_proposed_pricing");
  const request = await prisma.request.findUnique({ where: { id: requestId }, include: { lines: { orderBy: { lineNo: "asc" }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: { include: { prices: { include: { pricebook: true } }, costs: true } } } } } } } });
  if (!request) throw new Error("request not found");
  if (request.status !== "complete") throw new Error(`The cross-reference is ${request.status}; wait for it to complete before pricing`);
  const open = await prisma.proposal.findFirst({ where: { requestId, accountId: opts.accountId, status: "DRAFT" }, select: { reference: true } });
  if (open) throw new Error(`Draft ${open.reference} already exists for this request and account — open it, or create a new version from a closed proposal`);
  const asOf = opts.asOf ?? new Date();
  const ctx = await loadPricingContext({ accountId: opts.accountId, asOf });
  if (!ctx.account) throw new Error("account not found");
  const policies = await activePolicies();
  const version = await currentPublishedVersion();
  const summaries = await summariesFor(request.lines.map((l) => l.cfnNorm), { accountId: ctx.account.id, gpoId: ctx.primaryGpo?.id ?? null, region: ctx.account.region, asOf, currency: ctx.currency });
  const reference = await nextProposalReference();

  const proposal = await prisma.proposal.create({
    data: {
      reference, requestId, accountId: ctx.account.id, opportunityId: opts.opportunityId ?? null,
      gpoIdSnapshot: ctx.primaryGpo?.id ?? null, gpoNameSnapshot: ctx.primaryGpo ? `${ctx.primaryGpo.name}${ctx.primaryGpo.tier ? ` · ${ctx.primaryGpo.tier}` : ""}` : null,
      contractId: ctx.primaryContractId, currency: ctx.currency, status: "DRAFT",
      validThrough: new Date(asOf.getTime() + (opts.validDays ?? 60) * 86_400_000),
      ownerUserId: actor.id, crosswalkVersionId: version?.id ?? null, objectivesJson: opts.objectives ? JSON.stringify({ text: opts.objectives }) : null,
      policyVersionsJson: JSON.stringify(Object.fromEntries([...policies.values()].map((p) => [p.productFamily, p.id]))),
      createdByUserId: actor.id,
    },
  });

  let lineNo = 0;
  const usedPolicies = new Map<string, string>();
  try {
  for (const line of request.lines) {
    lineNo++;
    const sel = line.candidates.find((c) => c.id === line.selectedCandidateId) ?? line.candidates.find((c) => c.isSelected) ?? null;
    const product = sel?.ownProduct ?? null;
    // A retired SKU can be shown but never quoted: excluded, with the reason on the line.
    const retired = product ? !product.isActive || /not in commercial/i.test(product.status ?? "") : false;
    const cp = line.competitorProduct;
    const competitorName = cp?.manufacturer ?? null;
    const qty = D(line.quantity);

    // Governed cross: only a published, approved entry may be represented as an equivalence.
    const cross = await approvedCross(line.cfnNorm, version?.id);
    const entry = product ? cross.entries.find((e) => e.ownSku.toUpperCase() === product.sku.toUpperCase()) ?? null : null;
    const equivalence = entry ? entry.equivalenceLevel : product ? "NONE" : "NONE";
    const matchType = sel?.matchType ?? null;

    // Waterfall + cost + intelligence + recommendation
    const price = product ? ctx.resolvePrice({ id: product.id, sku: product.sku, category: product.category, listPrice: product.listPrice, currency: product.currency, prices: product.prices.map((e) => ({ ...e, pricebook: e.pricebook ? { name: e.pricebook.name } : null })) }, qty) : null;
    const cost = product ? ctx.resolveCost({ id: product.id, cogs: product.cogs, currency: product.currency, costs: product.costs }) : null;
    const summary: PriceSummary | undefined = summaries.get(compactCfn(normalizeCfn(line.cfnNorm)));
    const competitorPrice = summary?.reference ?? money(line.estCompetitorPrice) ?? null;
    const competitorBasis = summary?.basis && summary.basis !== "NONE" ? summary.basis : money(line.estCompetitorPrice) ? "WEAK" : "NONE";
    const competitorConfidence = summary?.basis && summary.basis !== "NONE" ? summary.confidence : money(line.estCompetitorPrice) ? 0.3 : 0;
    const listPrice = price?.steps.find((s) => s.level === "LIST" && s.price !== null)?.price ?? null;
    const contractStep = price?.source && price.source !== "LIST" ? price : null;
    const policy = policyFor(policies, product?.category);
    usedPolicies.set(policy.productFamily, policy.id);
    const rec: Recommendation | null = product ? recommend({
      currency: ctx.currency, quantity: qty, listPrice: money(listPrice), contractPrice: contractStep?.price ?? null, contractSource: contractStep?.source ?? null,
      cost: cost?.cost ?? null, competitorPrice, competitorConfidence, competitorBasis, policy, strategicAccount: ctx.account.isStrategic,
    }) : null;

    const created = await prisma.proposalLine.create({
      data: {
        proposalId: proposal.id, lineNo, included: Boolean(product) && !retired,
        competitorCode: line.rawCode, competitorDescription: cp?.description ?? null, competitorName, competitorProductId: cp?.id ?? null,
        crossId: entry?.knownCrossId ?? null, crosswalkVersionId: version?.id ?? null, equivalenceLevel: equivalence, matchType,
        productId: product?.id ?? null, sku: product?.sku ?? null, description: product?.description ?? null, productFamily: product?.category ?? null,
        quantity: toDb(qty)!, uom: "EA",
        listPrice: toDb(listPrice), contractPrice: toDb(contractStep?.price ?? null), contractPriceSource: contractStep?.source ?? null, waterfallJson: price ? JSON.stringify({ steps: price.steps, explanation: price.explanation, asOf: price.asOf }) : null,
        competitorPrice: toDb(competitorPrice), competitorPriceConfidence: competitorConfidence, competitorPriceBasis: competitorBasis, competitorIntelJson: summary ? JSON.stringify({ basis: summary.basis, explanation: summary.explanation, count: summary.count, countUsed: summary.countUsed, median: summary.median?.toString() ?? null, min: summary.min?.toString() ?? null, max: summary.max?.toString() ?? null, trend: summary.trend, accountPrice: summary.accountPrice?.toString() ?? null, gpoPrice: summary.gpoPrice?.toString() ?? null, mostRecent: summary.mostRecent ? { ...summary.mostRecent, price: summary.mostRecent.price.toString() } : null }) : null,
        cost: toDb(cost?.cost ?? null), costBasisJson: cost ? JSON.stringify(cost.basis) : null,
        floorPrice: toDb(rec?.floorPrice ?? null), targetPrice: toDb(rec?.targetPrice ?? null), ceilingPrice: toDb(rec?.ceilingPrice ?? null), recommendedPrice: toDb(rec?.recommendedPrice ?? null),
        recommendationJson: rec ? JSON.stringify(recToJson(rec)) : null, policyId: policy.id,
        proposedPrice: toDb(rec?.recommendedPrice ?? null),
        marginAmount: toDb(rec?.marginAmount ?? null), marginPct: toDbPct(rec?.marginPct ?? null), discountFromListPct: toDbPct(rec?.discountFromListPct ?? null), discountFromContractPct: toDbPct(rec?.discountFromContractPct ?? null),
        requiredAuthority: rec?.requiredAuthority ?? null, approvalState: rec?.requiredAuthority ? "REQUIRED" : "NOT_REQUIRED",
        notes: !product ? "No product selected on the cross-reference; excluded" : retired ? `${product.sku} is ${product.isActive ? "no longer in commercial distribution" : "inactive"}; excluded` : !entry && matchType ? `Cross-reference verdict "${matchType}" is not in the published crosswalk (v${version?.number ?? "—"}); shown as unapproved` : null,
      },
    });
    // Feedback: what the engine recommended vs what the rep chose (rep acceptance, not validated accuracy).
    if (line.candidates.length) {
      const top = line.candidates[0];
      await prisma.matchDecision.create({ data: { requestLineId: line.id, proposalLineId: created.id, topRecommendedSku: top.ownProduct.sku, chosenSku: product?.sku ?? null, acceptedTop: Boolean(product && top.ownProductId === product.id), overrideReason: line.overrideNote, productFamily: product?.category ?? top.ownProduct.category, competitorName, confidence: top.score, decidedByUserId: actor.id } });
    }
  }
  await applyBundleTerms(proposal.id, ctx.primaryContractId);
  await prisma.proposal.update({ where: { id: proposal.id }, data: { policyVersionsJson: JSON.stringify(Object.fromEntries(usedPolicies)) } });
  await refreshEconomics(proposal.id);
  } catch (e) {
    // Never leave a half-built proposal behind: a partially priced draft looks like a real one.
    await prisma.matchDecision.deleteMany({ where: { proposalLine: { proposalId: proposal.id } } });
    await prisma.proposal.delete({ where: { id: proposal.id } }).catch(() => undefined);
    throw e;
  }
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposal.id, action: "CREATED", after: { reference, requestId, accountId: ctx.account.id, crosswalkVersion: version?.number ?? null, lines: lineNo } });
  return prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
}

function recToJson(r: Recommendation) {
  const s = (v: Money | null) => (v === null ? null : v.toString());
  return { ...r, recommendedPrice: s(r.recommendedPrice), floorPrice: s(r.floorPrice), targetPrice: s(r.targetPrice), ceilingPrice: s(r.ceilingPrice), referencePrice: s(r.referencePrice), discountFromListPct: s(r.discountFromListPct), discountFromContractPct: s(r.discountFromContractPct), marginPct: s(r.marginPct), marginAmount: s(r.marginAmount) };
}

/** Bundle terms on the account's contract: note which lines earn a benefit (applied as recommendation adjustment, never silently). */
async function applyBundleTerms(proposalId: string, contractId: string | null) {
  if (!contractId) return;
  const bundles = await prisma.bundleTerm.findMany({ where: { contractId } });
  if (!bundles.length) return;
  const lines = await prisma.proposalLine.findMany({ where: { proposalId } });
  const econLines = lines.map((l) => ({ productId: l.productId, productFamily: l.productFamily, quantity: money(l.quantity)!, extended: (money(l.proposedPrice) ?? ZERO).times(money(l.quantity)!), included: l.included }));
  for (const b of bundles) {
    const parsed = parseBundle(b.conditionJson, b.benefitJson);
    if (!parsed) continue;
    const met = conditionMet(econLines, parsed.condition);
    for (let i = 0; i < lines.length; i++) {
      if (!benefitApplies(econLines[i], parsed.benefit)) continue;
      const note = `Bundle "${b.name}": ${met.met ? `condition met (${met.reason}) — benefit available` : `condition NOT met (${met.reason})`}`;
      await prisma.proposalLine.update({ where: { id: lines[i].id }, data: { notes: [lines[i].notes, note].filter(Boolean).join(" · ") } });
    }
  }
}

// ---------------------------------------------------------------------------
// Line economics / price changes
// ---------------------------------------------------------------------------

function toEcon(l: LineRow): EconLine {
  return { id: l.id, included: l.included, family: l.productFamily, quantity: money(l.quantity)!, proposedPrice: money(l.proposedPrice), competitorPrice: money(l.competitorPrice), listPrice: money(l.listPrice), contractPrice: money(l.contractPrice), cost: money(l.cost), currency: "USD", approvalState: l.approvalState };
}

export async function refreshEconomics(proposalId: string, priceOverrides?: Map<string, Money | null>) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true } });
  const lines = p.lines.map((l) => ({ ...toEcon(l), currency: p.currency, proposedPrice: priceOverrides?.has(l.id) ? priceOverrides.get(l.id)! : money(l.proposedPrice) }));
  const e = rollup(lines, p.currency);
  if (!priceOverrides) await prisma.proposal.update({ where: { id: proposalId }, data: { economicsJson: JSON.stringify(economicsToJson(e)) } });
  return e;
}

/** Policies the given lines pin (by id) plus the active set, loaded once — never one query per line. */
export type PolicyCache = { byId: Map<string, Policy>; active: Map<string, Policy> };
export async function policyCacheFor(lines: { policyId: string | null }[]): Promise<PolicyCache> {
  const ids = [...new Set(lines.map((l) => l.policyId).filter((x): x is string => Boolean(x) && x !== "default"))];
  const [rows, active] = await Promise.all([ids.length ? prisma.pricingPolicy.findMany({ where: { id: { in: ids } } }) : Promise.resolve([]), activePolicies()]);
  const { toPolicy } = await import("@/lib/pricing/policy-model");
  return { byId: new Map(rows.map((r) => [r.id, toPolicy(r)])), active };
}
function policyFromCache(cache: PolicyCache, l: LineRow): Policy {
  return (l.policyId && cache.byId.get(l.policyId)) || policyFor(cache.active, l.productFamily);
}
async function policyForLine(l: LineRow): Promise<Policy> {
  return policyFromCache(await policyCacheFor([l]), l);
}

/** The derived columns for a line at a given price — pure economics on snapshot inputs, one implementation. */
function derivedWith(policy: Policy, l: LineRow & { proposal: { account: { isStrategic: boolean } } }, price: Money | null, included: boolean, opts: { dealValue?: Money | null; strategicAccount?: boolean } = {}) {
  const floor = money(l.floorPrice) ?? floorFor(policy, money(l.cost), money(l.listPrice));
  const econ = economicsAt(price, { listPrice: money(l.listPrice), contractPrice: money(l.contractPrice), cost: money(l.cost), quantity: money(l.quantity)!, policy, strategicAccount: opts.strategicAccount ?? l.proposal.account.isStrategic, dealValue: opts.dealValue ?? null, contractMonths: null }, floor);
  const state = !included || !price ? "NOT_REQUIRED" : econ.requiredAuthority ? (l.approvalState === "APPROVED" || l.approvalState === "PENDING" ? l.approvalState : "REQUIRED") : "NOT_REQUIRED";
  return { marginAmount: toDb(econ.marginAmount), marginPct: toDbPct(econ.marginPct), discountFromListPct: toDbPct(econ.discountFromListPct), discountFromContractPct: toDbPct(econ.discountFromContractPct), requiredAuthority: econ.requiredAuthority, approvalState: state };
}

/**
 * Recompute every line of a proposal in one pass: one read, one policy load, one batched write.
 * (Per-line recomputation cost ~4 round trips; a 300-line deal took a minute.)
 */
export async function recomputeAllLines(proposalId: string, opts: { dealValue?: Money | null; strategicAccount?: boolean } = {}) {
  const lines = await prisma.proposalLine.findMany({ where: { proposalId }, include: { proposal: { include: { account: true } } }, orderBy: { lineNo: "asc" } });
  const cache = await policyCacheFor(lines);
  const updates = lines.map((l) => ({ id: l.id, data: derivedWith(policyFromCache(cache, l), l, money(l.proposedPrice), l.included, opts) }));
  await bulkWriteDerived(updates);
  return lines.map((l, i) => ({ ...l, ...updates[i].data }));
}

type Derived = ReturnType<typeof derivedWith>;
/** One UPDATE … FROM unnest(…) statement for every line — a 300-line deal is one round trip, not 300. */
async function bulkWriteDerived(rows: { id: string; data: Derived & { proposedPrice?: string | null; included?: boolean } }[]) {
  if (!rows.length) return;
  const col = <K extends keyof (Derived & { proposedPrice?: string | null; included?: boolean })>(k: K) => rows.map((r) => (r.data[k] === undefined ? null : r.data[k])) as (string | boolean | null)[];
  const withPrice = rows.some((r) => "proposedPrice" in r.data);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "ProposalLine" AS l SET
      "marginAmount" = v.ma::numeric, "marginPct" = v.mp::numeric, "discountFromListPct" = v.dl::numeric, "discountFromContractPct" = v.dc::numeric,
      "requiredAuthority" = v.ra, "approvalState" = v.st,
      "proposedPrice" = CASE WHEN ${withPrice} THEN v.pp::numeric ELSE l."proposedPrice" END,
      "included" = CASE WHEN ${withPrice} THEN v.inc::boolean ELSE l."included" END,
      "updatedAt" = now()
    FROM unnest(${rows.map((r) => r.id)}::text[], ${col("marginAmount")}::text[], ${col("marginPct")}::text[], ${col("discountFromListPct")}::text[], ${col("discountFromContractPct")}::text[], ${col("requiredAuthority")}::text[], ${col("approvalState")}::text[], ${col("proposedPrice")}::text[], ${rows.map((r) => (r.data.included === undefined ? null : String(r.data.included)))}::text[])
      AS v(id, ma, mp, dl, dc, ra, st, pp, inc)
    WHERE l.id = v.id`);
}

async function derivedFor(l: LineRow & { proposal: { account: { isStrategic: boolean } } }, price: Money | null, included: boolean, opts: { dealValue?: Money | null; strategicAccount?: boolean } = {}) {
  const policy = await policyForLine(l);
  return derivedWith(policy, l, price, included, opts);
}

/** Recompute a line's margin/discount/approval fields for its current proposedPrice (pure economics, snapshot inputs). */
export async function recomputeLine(lineId: string, opts: { dealValue?: Money | null; strategicAccount?: boolean } = {}) {
  const l = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId }, include: { proposal: { include: { account: true } } } });
  return prisma.proposalLine.update({ where: { id: lineId }, data: await derivedFor(l, money(l.proposedPrice), l.included, opts) });
}

export async function setProposedPrice(actor: Actor, lineId: string, price: Money | null, reason?: string | null) {
  requirePermission(actor, "edit_proposed_pricing");
  const before = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId } });
  await assertEditable(before.proposalId);
  if (price !== null && price.lte(0)) throw new Error("price must be positive");
  if (price !== null && price.gt(MAX_UNIT_PRICE)) throw new Error(`price exceeds the supported range (max ${MAX_UNIT_PRICE.toString()})`);
  const list = money(before.listPrice);
  if (price !== null && list && list.gt(0) && price.gt(list.times(10))) throw new Error(`price ${price.toFixed(2)} is more than 10× the list price ${list.toFixed(2)} — check the decimal point`);
  // Price and its derived fields are computed first and written in ONE statement: a line is never
  // left with a new price and stale margins (or a failed write after the price landed).
  const full = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId }, include: { proposal: { include: { account: true } } } });
  // A quoted price is a price in the currency's minor unit: what is stored is what is approved,
  // exported and written into the contract — never a sub-cent figure that rounds differently later.
  if (price !== null) price = round(price, full.proposal.currency);
  const derived = await derivedFor({ ...full, approvalState: "NOT_REQUIRED" }, price, full.included);
  const after = await prisma.proposalLine.update({ where: { id: lineId }, data: { proposedPrice: toDb(price), ...derived } });
  // A pending approval request is for the *old* price; it is void now and the line must be resubmitted.
  const voided = await prisma.approvalRequest.updateMany({ where: { proposalLineId: lineId, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: "price changed before decision" } });
  if (voided.count) await audit({ actorUserId: actor.id, entityType: "ProposalLine", entityId: lineId, action: "APPROVAL_REQUEST_VOIDED", reason: "price changed while a request was pending" });
  await refreshEconomics(before.proposalId);
  await audit({
    actorUserId: actor.id, entityType: "ProposalLine", entityId: lineId, action: "PRICE_CHANGED", reason: reason ?? null,
    before: { proposedPrice: before.proposedPrice?.toString() ?? null }, after: { proposedPrice: after.proposedPrice?.toString() ?? null },
    context: { recommendedPrice: before.recommendedPrice?.toString() ?? null, floorPrice: before.floorPrice?.toString() ?? null, marginPct: after.marginPct?.toString() ?? null, discountFromListPct: after.discountFromListPct?.toString() ?? null, requiredAuthority: after.requiredAuthority, policyId: before.policyId },
  });
  return after;
}

export async function setLineIncluded(actor: Actor, lineId: string, included: boolean) {
  requirePermission(actor, "edit_proposed_pricing");
  const before = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId } });
  await assertEditable(before.proposalId);
  await prisma.proposalLine.update({ where: { id: lineId }, data: { included } });
  if (!included) await prisma.approvalRequest.updateMany({ where: { proposalLineId: lineId, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: "line excluded before decision" } });
  await recomputeLine(lineId);
  await refreshEconomics(before.proposalId);
  await audit({ actorUserId: actor.id, entityType: "ProposalLine", entityId: lineId, action: included ? "INCLUDED" : "EXCLUDED" });
}

/** Re-run the recommendation for one line with a different strategy (rep-chosen), keeping snapshot inputs. */
export async function rerecommendLine(actor: Actor, lineId: string, opts: { strategy?: Strategy | null; adjustmentPct?: number | null; adjustmentAmount?: number | null; justification?: string | null; apply?: boolean }) {
  requirePermission(actor, "edit_proposed_pricing");
  const l = await prisma.proposalLine.findUniqueOrThrow({ where: { id: lineId }, include: { proposal: { include: { account: true } } } });
  const policy = await policyForLine(l);
  const rec = recommend({ currency: l.proposal.currency, quantity: money(l.quantity)!, listPrice: money(l.listPrice), contractPrice: money(l.contractPrice), contractSource: l.contractPriceSource, cost: money(l.cost), competitorPrice: money(l.competitorPrice), competitorConfidence: l.competitorPriceConfidence ?? 0, competitorBasis: (l.competitorPriceBasis as never) ?? "NONE", policy, strategy: opts.strategy ?? null, adjustmentPct: opts.adjustmentPct ?? null, adjustmentAmount: opts.adjustmentAmount ?? null, strategicAccount: l.proposal.account.isStrategic, justification: opts.justification ?? l.justification });
  if (opts.apply) {
    await assertEditable(l.proposalId);
    await prisma.proposalLine.update({ where: { id: lineId }, data: { recommendedPrice: toDb(rec.recommendedPrice), recommendationJson: JSON.stringify(recToJson(rec)), justification: opts.justification ?? l.justification } });
    await setProposedPrice(actor, lineId, rec.recommendedPrice, `re-recommended with ${rec.strategy}`);
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Scenarios (what-if) — never touch the proposal's own prices until applied
// ---------------------------------------------------------------------------

export async function createScenario(actor: Actor, proposalId: string, kind: string, name?: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true } });
  if (!["RECOMMENDED", "AGGRESSIVE", "MARGIN_OPTIMIZED", "CUSTOM"].includes(kind)) throw new Error("kind must be RECOMMENDED, AGGRESSIVE, MARGIN_OPTIMIZED or CUSTOM");
  if (name !== undefined && (typeof name !== "string" || name.length > 120)) throw new Error("name must be text (max 120)");
  const cache = await policyCacheFor(p.lines);
  const s = await prisma.scenario.create({ data: { proposalId, kind, name: name ?? kind.charAt(0) + kind.slice(1).toLowerCase().replace(/_/g, " "), createdByUserId: actor.id } });
  const scenarioLines: { scenarioId: string; proposalLineId: string; proposedPrice: string | null; included: boolean }[] = [];
  for (const l of p.lines) {
    let price: Money | null = money(l.proposedPrice);
    const policy = policyFromCache(cache, l);
    const base = { currency: p.currency, quantity: money(l.quantity)!, listPrice: money(l.listPrice), contractPrice: money(l.contractPrice), contractSource: l.contractPriceSource, cost: money(l.cost), competitorPrice: money(l.competitorPrice), competitorConfidence: l.competitorPriceConfidence ?? 0, competitorBasis: (l.competitorPriceBasis as never) ?? "NONE", policy, strategicAccount: p.account.isStrategic };
    if (l.productId) {
      if (kind === "RECOMMENDED") price = money(l.recommendedPrice);
      else if (kind === "AGGRESSIVE") price = recommend({ ...base, strategy: money(l.competitorPrice) ? "UNDERCUT_PCT" : "STRATEGIC_DISCOUNT", adjustmentPct: 0.05 }).recommendedPrice;
      else if (kind === "MARGIN_OPTIMIZED") { const t = money(l.targetPrice); const ref = money(l.contractPrice) ?? money(l.listPrice); price = t && ref ? (t.gt(ref) ? ref : t) : (t ?? price); }
    }
    scenarioLines.push({ scenarioId: s.id, proposalLineId: l.id, proposedPrice: toDb(price), included: l.included });
  }
  await prisma.scenarioLine.createMany({ data: scenarioLines });
  return s;
}

export async function setScenarioPrice(actor: Actor, scenarioId: string, lineId: string, price: Money | null, included?: boolean) {
  requirePermission(actor, "edit_proposed_pricing");
  const s = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId }, include: { proposal: { select: { currency: true } } } });
  if (!(await prisma.proposalLine.findFirst({ where: { id: lineId, proposalId: s.proposalId }, select: { id: true } }))) throw new Error("line does not belong to this scenario's proposal");
  if (price !== null) { if (price.lte(0)) throw new Error("price must be positive"); price = round(price, s.proposal.currency); }
  return prisma.scenarioLine.upsert({ where: { scenarioId_proposalLineId: { scenarioId, proposalLineId: lineId } }, create: { scenarioId, proposalLineId: lineId, proposedPrice: toDb(price), included: included ?? true }, update: { proposedPrice: toDb(price), ...(included === undefined ? {} : { included }) } });
}

export async function scenarioEconomics(scenarioId: string) {
  const s = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId }, include: { lines: true, proposal: { include: { lines: true } } } });
  const overrides = new Map(s.lines.map((sl) => [sl.proposalLineId, money(sl.proposedPrice)]));
  const inc = new Map(s.lines.map((sl) => [sl.proposalLineId, sl.included]));
  const policies = await activePolicies();
  const lines: EconLine[] = [];
  const lineDetail: { id: string; proposedPrice: string | null; marginPct: string | null; discountFromListPct: string | null; requiredAuthority: string | null; belowFloor: boolean }[] = [];
  for (const l of s.proposal.lines) {
    const price = overrides.has(l.id) ? overrides.get(l.id)! : money(l.proposedPrice);
    const included = inc.get(l.id) ?? l.included;
    lines.push({ ...toEcon(l), currency: s.proposal.currency, proposedPrice: price, included });
    const policy = policyFor(policies, l.productFamily);
    const e = economicsAt(price, { listPrice: money(l.listPrice), contractPrice: money(l.contractPrice), cost: money(l.cost), quantity: money(l.quantity)!, policy, strategicAccount: false, dealValue: null, contractMonths: null }, money(l.floorPrice));
    lineDetail.push({ id: l.id, proposedPrice: price?.toString() ?? null, marginPct: e.marginPct?.toString() ?? null, discountFromListPct: e.discountFromListPct?.toString() ?? null, requiredAuthority: e.requiredAuthority, belowFloor: e.belowFloor });
  }
  return { scenario: { id: s.id, name: s.name, kind: s.kind }, economics: economicsToJson(rollup(lines, s.proposal.currency)), lines: lineDetail };
}

/** Copy a scenario's prices into the proposal (only while editable), audited per line. */
export async function applyScenario(actor: Actor, scenarioId: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const s = await prisma.scenario.findUniqueOrThrow({ where: { id: scenarioId }, include: { lines: true, proposal: { select: { currency: true } } } });
  await assertEditable(s.proposalId);
  const full = await prisma.proposalLine.findMany({ where: { proposalId: s.proposalId }, include: { proposal: { include: { account: true } } } });
  const before = new Map(full.map((l) => [l.id, l]));
  const cache = await policyCacheFor(full);
  // Validate every scenario price with the same rules as a manual edit, then write all prices in one
  // batch, recompute every line once and roll the deal up once (not once per line).
  const writes = s.lines.map((sl) => {
    const b = before.get(sl.proposalLineId);
    if (!b) throw new Error("scenario refers to a line that is no longer on the proposal");
    let price = money(sl.proposedPrice);
    if (price !== null) {
      if (price.lte(0)) throw new Error("scenario price must be positive");
      const list = money(b.listPrice);
      if (list && list.gt(0) && price.gt(list.times(10))) throw new Error(`scenario price ${price.toFixed(2)} is more than 10× list`);
      price = round(price, s.proposal.currency);
    }
    return { id: sl.proposalLineId, included: sl.included, price, previous: money(b.proposedPrice) };
  });
  const rows = writes.map((w) => { const l = before.get(w.id)!; return { id: w.id, data: { ...derivedWith(policyFromCache(cache, l), { ...l, approvalState: "NOT_REQUIRED" }, w.price, w.included), proposedPrice: toDb(w.price), included: w.included } }; });
  await bulkWriteDerived(rows);
  await prisma.approvalRequest.updateMany({ where: { proposalLineId: { in: writes.map((w) => w.id) }, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: `scenario "${s.name}" applied before decision` } });
  const after = new Map(rows.map((r) => [r.id, r.data]));
  await refreshEconomics(s.proposalId);
  for (const w of writes) {
    if (w.previous?.toString() === w.price?.toString()) continue;
    const a = after.get(w.id);
    await audit({ actorUserId: actor.id, entityType: "ProposalLine", entityId: w.id, action: "PRICE_CHANGED", reason: `applied scenario "${s.name}"`, before: { proposedPrice: w.previous?.toString() ?? null }, after: { proposedPrice: w.price?.toString() ?? null }, context: { marginPct: a?.marginPct ?? null, discountFromListPct: a?.discountFromListPct ?? null, requiredAuthority: a?.requiredAuthority ?? null } });
  }
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: s.proposalId, action: "SCENARIO_APPLIED", context: { scenarioId, name: s.name, kind: s.kind, lines: writes.length } });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** New editable version cloned from a locked proposal (all snapshots carried over). */
export async function newVersion(actor: Actor, proposalId: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true } });
  const { lines: _lines, ...head } = p;
  const created = await prisma.proposal.create({ data: { ...stripId(head), reference: p.reference.replace(/(-v\d+)?$/, "") + `-v${p.version + 1}`, version: p.version + 1, parentProposalId: p.id, status: "DRAFT", lockedAt: null, submittedAt: null, decidedAt: null, economicsJson: null, createdByUserId: actor.id, ownerUserId: actor.id } });
  await prisma.proposalLine.createMany({ data: p.lines.map((l) => ({ ...stripId(l), proposalId: created.id, approvalState: l.requiredAuthority ? "REQUIRED" : "NOT_REQUIRED" })) });
  await refreshEconomics(created.id);
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: created.id, action: "VERSION_CREATED", context: { from: p.id, version: created.version } });
  return created;
}

function stripId<T extends { id: string; createdAt: Date; updatedAt: Date }>(row: T): Omit<T, "id" | "createdAt" | "updatedAt"> {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

export const canViewCost = (actor: Actor | null) => can(actor, "view_cost");

/**
 * Deal outcomes and what a win turns into: a LOCAL contract with effective-dated
 * price entries (the approved prices become the account's applicable prices), plus
 * win/loss evidence for the intelligence layer. Losses record the competitor and
 * the reason so pricing analytics can learn from them.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, toDb } from "@/lib/money";
import { competitorByName, recordObservation } from "@/lib/intelligence";
import { finalizeCheck } from "@/lib/approvals/service";

export async function recordOutcome(actor: Actor, proposalId: string, input: { outcome: "WON" | "LOST" | "NO_DECISION"; competitorName?: string | null; priceReason?: string | null; commercialReason?: string | null; finalValue?: string | null; notes?: string | null; competitorWinningPrices?: { competitorCode: string; price: string }[]; createContract?: boolean; contractMonths?: number }) {
  requirePermission(actor, "record_outcomes");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true, outcome: true } });
  if (!["WON", "LOST", "NO_DECISION"].includes(input.outcome)) throw new Error("outcome must be WON, LOST or NO_DECISION");
  // A closed proposal stays closed: a won deal already became a contract, a lost one already fed intelligence.
  if (["WON", "LOST"].includes(p.status) || (p.outcome && ["WON", "LOST"].includes(p.outcome.outcome))) throw new Error(`Proposal is already ${p.status.toLowerCase()}; record a new version for a new outcome`);
  if (input.outcome === "WON") { const f = await finalizeCheck(proposalId); if (!f.ok) throw new Error(`Cannot mark as won: ${f.reason}`); }
  if (input.outcome === "LOST" && !["APPROVED", "SUBMITTED", "PARTIALLY_APPROVED", "REJECTED", "CHANGES_REQUESTED", "EXPIRED"].includes(p.status)) throw new Error(`Cannot mark a ${p.status.toLowerCase()} proposal as lost; submit it first`);
  const competitor = input.competitorName ? await competitorByName(input.competitorName) : null;
  const econ = p.economicsJson ? JSON.parse(p.economicsJson) : null;
  // WON: the contract is created first (atomically) — a won proposal without its contract would
  // price the next quote off the old contract while reporting a win.
  let contract: { id: string; contractNumber: string } | null = null;
  if (input.outcome === "WON" && input.createContract !== false) contract = await contractFromProposal(actor, proposalId, input.contractMonths ?? 12);
  const outcome = await prisma.dealOutcome.upsert({
    where: { proposalId },
    create: { proposalId, outcome: input.outcome, competitorId: competitor?.id ?? null, priceReason: input.priceReason ?? null, commercialReason: input.commercialReason ?? null, finalValue: toDb(input.finalValue ?? econ?.revenue ?? null), currency: p.currency, recordedByUserId: actor.id, notes: input.notes ?? null },
    update: { outcome: input.outcome, competitorId: competitor?.id ?? null, priceReason: input.priceReason ?? null, commercialReason: input.commercialReason ?? null, finalValue: toDb(input.finalValue ?? econ?.revenue ?? null), recordedByUserId: actor.id, notes: input.notes ?? null, decidedAt: new Date() },
  });
  await prisma.proposal.update({ where: { id: proposalId }, data: { status: input.outcome === "WON" ? "WON" : input.outcome === "LOST" ? "LOST" : p.status, decidedAt: new Date(), lockedAt: p.lockedAt ?? new Date() } });

  // Loss: the competitor's winning prices are the most valuable intelligence we get.
  if (input.outcome === "LOST" && competitor && input.competitorWinningPrices?.length) {
    for (const w of input.competitorWinningPrices) {
      const line = p.lines.find((l) => l.competitorCode === w.competitorCode);
      await recordObservation(actor.id, { competitorName: competitor.name, competitorSku: w.competitorCode, price: w.price, currency: p.currency, accountId: p.accountId, gpoId: p.gpoIdSnapshot, region: p.account.region, observedAt: new Date(), sourceType: "WIN_LOSS_RECORD", sourceRef: `${p.reference} lost`, notes: input.priceReason ?? null, proposalLineId: line?.id ?? null });
    }
  }
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: `OUTCOME_${input.outcome}`, after: { competitor: competitor?.name ?? null, priceReason: input.priceReason, commercialReason: input.commercialReason, finalValue: outcome.finalValue?.toString() ?? null, contract: contract?.contractNumber ?? null } });
  { const { requestAnalyticsRefresh } = await import("@/lib/analytics/snapshots"); await requestAnalyticsRefresh(["winloss", "pricing", "conversion"]); }
  return { outcome, contract };
}

/** The approved prices become a LOCAL contract for the account, effective today, so the waterfall now resolves to them. */
export async function contractFromProposal(actor: Actor, proposalId: string, months = 12) {
  requirePermission(actor, "record_outcomes");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true } });
  const from = new Date();
  const to = new Date(from); to.setMonth(to.getMonth() + months);
  const contractNumber = `LOC-${p.account.accountNumber ?? p.account.id.slice(-6)}-${p.reference}`;
  const existing = await prisma.contract.findUnique({ where: { contractNumber } });
  if (existing) return existing;
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("contractMonths must be a whole number of months between 1 and 120");
  // Contract, entries and commitments land together or not at all.
  const c = await prisma.$transaction(async (tx) => {
    const created = await tx.contract.create({ data: { contractNumber, name: `${p.account.name} — ${p.reference}`, type: "LOCAL", status: "ACTIVE", accountId: p.accountId, currency: p.currency, effectiveFrom: from, effectiveTo: to, sourceSystem: "crosswalk", externalId: p.id, ownerUserId: p.ownerUserId, createdByUserId: actor.id, notes: `Created from won proposal ${p.reference}` } });
    const lines = p.lines.filter((l) => l.included && l.productId && money(l.proposedPrice));
    await tx.priceEntry.createMany({ data: lines.map((l) => ({ contractId: created.id, accountId: p.accountId, productId: l.productId!, productFamily: l.productFamily, price: toDb(l.proposedPrice)!, currency: p.currency, effectiveFrom: from, effectiveTo: to, source: "proposal", status: "ACTIVE", approvalState: "APPROVED" })) });
    await tx.contractCommitment.createMany({ data: lines.map((l) => ({ contractId: created.id, productId: l.productId!, productFamily: l.productFamily, committedUnits: toDb(l.quantity), committedValue: toDb(money(l.quantity)!.times(money(l.proposedPrice)!)), periodStart: from, periodEnd: to })) });
    return created;
  }, { timeout: 30_000 });
  await audit({ actorUserId: actor.id, entityType: "Contract", entityId: c.id, action: "CREATED_FROM_PROPOSAL", after: { contractNumber, proposal: p.reference, lines: p.lines.filter((l) => l.included).length } });
  return c;
}

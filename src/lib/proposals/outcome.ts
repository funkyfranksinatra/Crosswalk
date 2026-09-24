/**
 * Deal outcomes and what a win turns into: a LOCAL contract with effective-dated
 * price entries (the approved prices become the account's applicable prices), plus
 * win/loss evidence for the intelligence layer. Losses record the competitor and
 * the reason so pricing analytics can learn from them.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, toDb } from "@/lib/money";
import { competitorByName, recordObservation } from "@/lib/intelligence";
import { finalizeCheck } from "@/lib/approvals/service";

export type OutcomeInput = { outcome: "WON" | "LOST" | "NO_DECISION"; competitorName?: string | null; priceReason?: string | null; commercialReason?: string | null; finalValue?: string | null; notes?: string | null; competitorWinningPrices?: { competitorCode: string; price: string }[]; createContract?: boolean; contractMonths?: number };

const CLOSED = ["WON", "LOST"];

export async function recordOutcome(actor: Actor, proposalId: string, input: OutcomeInput) {
  requirePermission(actor, "record_outcomes");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true, outcome: true } });
  if (!["WON", "LOST", "NO_DECISION"].includes(input.outcome)) throw new Error("outcome must be WON, LOST or NO_DECISION");
  // A closed proposal stays closed: a won deal already became a contract, a lost one already fed intelligence.
  if (CLOSED.includes(p.status) || (p.outcome && CLOSED.includes(p.outcome.outcome))) throw new Error(`Proposal is already ${p.status.toLowerCase()}; record a new version for a new outcome`);
  if (input.outcome === "WON") { const f = await finalizeCheck(proposalId); if (!f.ok) throw new Error(`Cannot mark as won: ${f.reason}`); }
  if (input.outcome === "LOST" && !["APPROVED", "SUBMITTED", "PARTIALLY_APPROVED", "REJECTED", "CHANGES_REQUESTED", "EXPIRED"].includes(p.status)) throw new Error(`Cannot mark a ${p.status.toLowerCase()} proposal as lost; submit it first`);
  const months = input.contractMonths ?? 12;
  if (input.outcome === "WON" && input.createContract !== false && (!Number.isInteger(months) || months < 1 || months > 120)) throw new Error("contractMonths must be a whole number of months between 1 and 120");
  const finalValue = input.finalValue === undefined || input.finalValue === null || input.finalValue === "" ? null : money(input.finalValue);
  if (input.finalValue !== undefined && input.finalValue !== null && input.finalValue !== "" && (finalValue === null || finalValue.lt(0))) throw new Error("finalValue must be a non-negative number");
  const competitor = input.competitorName ? await competitorByName(input.competitorName) : null;
  const econ = p.economicsJson ? JSON.parse(p.economicsJson) : null;
  const value = toDb(finalValue ?? econ?.revenue ?? null);
  const status = input.outcome === "WON" ? "WON" : input.outcome === "LOST" ? "LOST" : p.status;

  // WON / LOST close the proposal: the claim, the contract (with its entries and commitments), the
  // outcome row and the status land in ONE transaction. Two simultaneous closes serialise on the
  // claim — the second finds the proposal already closed and changes nothing.
  const { outcome, contract } = await prisma.$transaction(async (tx) => {
    // The WON claim also re-checks the status the finalize check saw: a reopen racing in between
    // would otherwise let a DRAFT be closed as won (review §5).
    const claimed = await tx.proposal.updateMany({ where: { id: proposalId, status: input.outcome === "WON" ? { in: ["APPROVED", "WON"] as string[], notIn: CLOSED } : { notIn: CLOSED } }, data: { status, decidedAt: new Date(), lockedAt: p.lockedAt ?? new Date() } });
    if (claimed.count !== 1) throw new Error(`Proposal is already closed; record a new version for a new outcome`);
    let contract: { id: string; contractNumber: string } | null = null;
    // WON: the contract is created in the same transaction — a won proposal without its contract would
    // price the next quote off the old contract while reporting a win.
    if (input.outcome === "WON" && input.createContract !== false) contract = await contractFromProposalIn(tx, actor, p, months);
    if (input.outcome === "LOST") {
      // Nothing stays open on a lost deal: a leftover PENDING request could otherwise be decided later.
      await tx.approvalRequest.updateMany({ where: { proposalId, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: "proposal recorded as lost" } });
    }
    const outcome = await tx.dealOutcome.upsert({
      where: { proposalId },
      create: { proposalId, outcome: input.outcome, competitorId: competitor?.id ?? null, priceReason: input.priceReason ?? null, commercialReason: input.commercialReason ?? null, finalValue: value, currency: p.currency, recordedByUserId: actor.id, notes: input.notes ?? null },
      update: { outcome: input.outcome, competitorId: competitor?.id ?? null, priceReason: input.priceReason ?? null, commercialReason: input.commercialReason ?? null, finalValue: value, recordedByUserId: actor.id, notes: input.notes ?? null, decidedAt: new Date() },
    });
    await tx.auditEvent.create({ data: { actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: `OUTCOME_${input.outcome}`, afterJson: JSON.stringify({ competitor: competitor?.name ?? null, priceReason: input.priceReason, commercialReason: input.commercialReason, finalValue: outcome.finalValue?.toString() ?? null, contract: contract?.contractNumber ?? null }) } });
    return { outcome, contract };
  }, { timeout: 60_000, maxWait: 15_000 });

  // Loss: the competitor's winning prices are the most valuable intelligence we get (append-only; outside the close).
  if (input.outcome === "LOST" && competitor && input.competitorWinningPrices?.length) {
    for (const w of input.competitorWinningPrices) {
      const line = p.lines.find((l) => l.competitorCode === w.competitorCode);
      await recordObservation(actor.id, { competitorName: competitor.name, competitorSku: w.competitorCode, price: w.price, currency: p.currency, accountId: p.accountId, gpoId: p.gpoIdSnapshot, region: p.account.region, observedAt: new Date(), sourceType: "WIN_LOSS_RECORD", sourceRef: `${p.reference} lost`, notes: input.priceReason ?? null, proposalLineId: line?.id ?? null });
    }
  }
  { const { requestAnalyticsRefresh } = await import("@/lib/analytics/snapshots"); await requestAnalyticsRefresh(["winloss", "pricing", "conversion"]); }
  return { outcome, contract };
}

type Tx = Prisma.TransactionClient;
type ProposalForContract = { id: string; reference: string; accountId: string; currency: string; ownerUserId: string | null; account: { name: string; accountNumber: string | null; id: string }; lines: { included: boolean; productId: string | null; productFamily: string | null; proposedPrice: unknown; quantity: unknown }[] };

export function contractNumberFor(p: { reference: string; account: { accountNumber: string | null; id: string } }): string {
  return `LOC-${p.account.accountNumber ?? p.account.id.slice(-6)}-${p.reference}`;
}

/** Contract + ACTIVE/APPROVED entries + commitments on the given client; idempotent on the contract number. */
async function contractFromProposalIn(tx: Tx, actor: Actor, p: ProposalForContract, months: number) {
  const from = new Date();
  const to = new Date(from); to.setMonth(to.getMonth() + months);
  const contractNumber = contractNumberFor(p);
  const existing = await tx.contract.findUnique({ where: { contractNumber } });
  if (existing) return existing;
  const created = await tx.contract.create({ data: { contractNumber, name: `${p.account.name} — ${p.reference}`, type: "LOCAL", status: "ACTIVE", accountId: p.accountId, currency: p.currency, effectiveFrom: from, effectiveTo: to, sourceSystem: "crosswalk", externalId: p.id, ownerUserId: p.ownerUserId, createdByUserId: actor.id, notes: `Created from won proposal ${p.reference}` } });
  const lines = p.lines.filter((l) => l.included && l.productId && money(l.proposedPrice as never));
  await tx.priceEntry.createMany({ data: lines.map((l) => ({ contractId: created.id, accountId: p.accountId, productId: l.productId!, productFamily: l.productFamily, price: toDb(l.proposedPrice as never)!, currency: p.currency, effectiveFrom: from, effectiveTo: to, source: "proposal", status: "ACTIVE", approvalState: "APPROVED" })) });
  await tx.contractCommitment.createMany({ data: lines.map((l) => ({ contractId: created.id, productId: l.productId!, productFamily: l.productFamily, committedUnits: toDb(l.quantity as never), committedValue: toDb(money(l.quantity as never)!.times(money(l.proposedPrice as never)!)), periodStart: from, periodEnd: to })) });
  await tx.auditEvent.create({ data: { actorUserId: actor.id, entityType: "Contract", entityId: created.id, action: "CREATED_FROM_PROPOSAL", afterJson: JSON.stringify({ contractNumber, proposal: p.reference, lines: lines.length }) } });
  return created;
}

/** The approved prices become a LOCAL contract for the account, effective today, so the waterfall now resolves to them. Idempotent. */
export async function contractFromProposal(actor: Actor, proposalId: string, months = 12) {
  requirePermission(actor, "record_outcomes");
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("contractMonths must be a whole number of months between 1 and 120");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true } });
  return prisma.$transaction((tx) => contractFromProposalIn(tx, actor, p, months), { timeout: 30_000 });
}

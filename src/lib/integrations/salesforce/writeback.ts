/**
 * Quote write-back (2.1 outbound). An approved proposal becomes a CRM quote through
 * CRMAdapter.createOrUpdateQuote with the proposal id as idempotency key: retries and
 * re-approvals update the same quote. Margin leaves Crosswalk only when the integration's
 * `pushMargin` setting says so. Every attempt is a SyncLog row and an audit entry.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { audit } from "@/lib/audit";
import { economicsToJson } from "@/lib/proposals/economics";
import type { CRMAdapter } from "../core/contracts";
import type { QuoteWriteback, QuoteWritebackResult } from "../types";
import { ValidationError, asIntegrationError } from "../core/errors";
import { createHash } from "node:crypto";

const hash = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");

export async function buildQuoteWriteback(proposalId: string, pushMargin: boolean): Promise<QuoteWriteback> {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true, opportunity: true, lines: { orderBy: { lineNo: "asc" } }, approvals: { orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (!["APPROVED", "WON"].includes(p.status)) throw new ValidationError(`proposal ${p.reference} is ${p.status}; only approved proposals are written to the CRM`);
  if (!p.account.externalCrmId) throw new ValidationError(`account ${p.account.name} is not linked to a CRM record — sync accounts first`);
  const econ = p.economicsJson ? (JSON.parse(p.economicsJson) as ReturnType<typeof economicsToJson>) : null;
  const approval = p.approvals[0];
  return {
    idempotencyKey: p.id, proposalId: p.id, reference: p.reference, accountExternalId: p.account.externalCrmId, opportunityExternalId: p.opportunity?.externalCrmId ?? null,
    status: p.status, proposalStatus: p.status, approvalStatus: approval?.status ?? (p.status === "APPROVED" ? "APPROVED" : "NONE"), currency: p.currency,
    totalValue: econ?.revenue ?? "0", contractValue: econ?.revenue ?? "0", customerSavings: econ?.customerSavings ?? null, blendedMarginPct: pushMargin ? econ?.blendedMarginPct ?? null : null,
    validThrough: p.validThrough?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), approvedAt: approval?.decidedAt?.toISOString() ?? null,
    lines: p.lines.filter((l) => l.included).map((l) => ({ sku: l.sku, description: l.description, competitorCode: l.competitorCode, quantity: l.quantity.toString(), unitPrice: l.proposedPrice?.toString() ?? null, matchType: l.matchType, equivalenceLevel: l.equivalenceLevel, approvalState: l.approvalState })),
  };
}

/** Push (or re-push) a proposal. Unchanged payloads are skipped by hash; changed ones update the same CRM quote. */
export async function writeBackQuote(crm: CRMAdapter, system: string, actorUserId: string | null, proposalId: string, pushMargin: boolean, opts: { force?: boolean } = {}): Promise<{ externalId: string; skipped: boolean; created: boolean }> {
  const payload = await buildQuoteWriteback(proposalId, pushMargin);
  const h = hash(payload);
  const ref = await prisma.externalRef.findFirst({ where: { system, entityType: "Proposal", entityId: proposalId } });
  if (ref?.syncHash === h && !opts.force) {
    await prisma.syncLog.create({ data: { system, direction: "OUT", entityType: "Proposal", entityId: proposalId, externalId: ref.externalId, status: "SKIPPED", error: "unchanged", payloadHash: h } });
    return { externalId: ref.externalId, skipped: true, created: false };
  }
  const t0 = Date.now();
  let res: QuoteWritebackResult;
  try {
    res = await crm.createOrUpdateQuote(payload);
  } catch (e) {
    const err = asIntegrationError(e);
    await prisma.syncLog.create({ data: { system, direction: "OUT", entityType: "Proposal", entityId: proposalId, status: "FAILED", error: err.message.slice(0, 2000), payloadHash: h } });
    log.warn("integration.quote_writeback_failed", { integration: "salesforce", proposalId, category: err.category, error: err.message, ms: Date.now() - t0 });
    await audit({ actorUserId, entityType: "Proposal", entityId: proposalId, action: "CRM_PUSH_FAILED", context: { system, category: err.category, message: err.message } });
    throw err;
  }
  await prisma.externalRef.upsert({ where: { system_entityType_externalId: { system, entityType: "Proposal", externalId: res.externalId } }, create: { system, entityType: "Proposal", externalId: res.externalId, entityId: proposalId, syncHash: h, metaJson: JSON.stringify({ lines: res.lineExternalIds?.length ?? payload.lines.length, providerRef: res.providerRef ?? null }) }, update: { entityId: proposalId, syncHash: h, syncedAt: new Date(), metaJson: JSON.stringify({ lines: res.lineExternalIds?.length ?? payload.lines.length, providerRef: res.providerRef ?? null }) } });
  await prisma.syncLog.create({ data: { system, direction: "OUT", entityType: "Proposal", entityId: proposalId, externalId: res.externalId, status: "OK", payloadHash: h } });
  log.info("integration.quote_writeback", { integration: "salesforce", proposalId, externalId: res.externalId, created: res.created, lines: payload.lines.length, ms: Date.now() - t0 });
  await audit({ actorUserId, entityType: "Proposal", entityId: proposalId, action: "PUSHED_TO_CRM", after: { system, externalId: res.externalId, created: res.created, marginIncluded: pushMargin } });
  return { externalId: res.externalId, skipped: false, created: res.created };
}

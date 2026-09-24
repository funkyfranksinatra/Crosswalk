/**
 * Deal desk: submission, routing, decisions, locking. Uses the pure rules in
 * ./rules.ts and writes the audit trail for every step.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { scopeFor, proposalWhere, assertProposalVisible } from "@/lib/auth/scope";
import { type Actor, requirePermission, hasAuthority, AuthError } from "@/lib/auth";
import { money } from "@/lib/money";
import { proposalStatusFrom, canFinalize } from "./rules";
import { recomputeAllLines, refreshEconomics, type Db } from "@/lib/proposals/service";
import { authorityFor, effectiveAuthority } from "./delegation";

/**
 * Submit a proposal. Every included line is re-evaluated against its policy; lines
 * within the submitter's own authority are approved on the spot (audited); the rest
 * get an ApprovalRequest routed to the lowest role that can decide them.
 */
export async function submitForApproval(actor: Actor, proposalId: string, notes?: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true } });
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(p.status)) throw new Error(`Proposal is ${p.status}; only drafts can be submitted`);
  const included = p.lines.filter((l) => l.included);
  if (!included.length) throw new Error("Nothing to submit: no included lines");
  if (included.some((l) => money(l.proposedPrice) === null)) throw new Error("Every included line needs a proposed price before submission");

  // One transaction: claim + lock, withdraw earlier requests, recompute every line, decide each
  // line's route, create the requests, set the status, audit. A failure anywhere rolls all of it
  // back — the proposal is never left locked, half-routed, or with its earlier requests withdrawn.
  const result = await prisma.$transaction(async (tx) => {
    // Claim the proposal atomically: two concurrent submissions must not both route requests. The
    // second waits on the row lock, re-evaluates `lockedAt IS NULL` after the first commits, and fails.
    const claimed = await tx.proposal.updateMany({ where: { id: proposalId, status: { in: ["DRAFT", "CHANGES_REQUESTED"] }, lockedAt: null }, data: { lockedAt: new Date(), status: "SUBMITTED" } });
    if (claimed.count !== 1) throw new Error("Proposal is already being submitted");
    // Every request from a previous submission is superseded — lines are re-evaluated below, so an
    // old REJECTED / CHANGES_REQUESTED / APPROVED decision must not keep deciding this proposal's status.
    await tx.approvalRequest.updateMany({ where: { proposalId, status: { in: ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] } }, data: { status: "WITHDRAWN" } });
    const econ = await refreshEconomics(proposalId, undefined, tx);
    const recomputed = (await recomputeAllLines(proposalId, { dealValue: econ.revenue, strategicAccount: p.account.isStrategic }, tx)).filter((l) => l.included);
    let routed = 0, auto = 0;
    const notRequired: string[] = [], autoIds: string[] = [];
    const autoEvents: Parameters<typeof audit>[0][] = [];
    const toRoute: { line: (typeof recomputed)[number]; snapshot: Record<string, unknown> }[] = [];
    for (const line of recomputed) {
      if (!line.requiredAuthority) { notRequired.push(line.id); continue; }
      const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
      const snapshot = { proposedPrice: str(line.proposedPrice), recommendedPrice: str(line.recommendedPrice), floorPrice: str(line.floorPrice), marginPct: line.marginPct === null ? null : money(line.marginPct)!.toString(), discountFromListPct: line.discountFromListPct === null ? null : money(line.discountFromListPct)!.toString(), discountFromContractPct: line.discountFromContractPct === null ? null : money(line.discountFromContractPct)!.toString(), policyId: line.policyId, dealRevenue: econ.revenue.toString() };
      if (hasAuthority(actor, line.requiredAuthority)) {
        auto++; autoIds.push(line.id);
        autoEvents.push({ actorUserId: actor.id, entityType: "ProposalLine", entityId: line.id, action: "AUTO_APPROVED", reason: `submitter holds ${line.requiredAuthority} authority`, context: snapshot });
      } else { routed++; toRoute.push({ line, snapshot }); }
    }
    if (notRequired.length) await tx.proposalLine.updateMany({ where: { id: { in: notRequired } }, data: { approvalState: "NOT_REQUIRED" } });
    if (autoIds.length) await tx.proposalLine.updateMany({ where: { id: { in: autoIds } }, data: { approvalState: "APPROVED" } });
    for (const e of autoEvents) await auditIn(tx, e);
    for (const { line, snapshot } of toRoute) {
      const req = await tx.approvalRequest.create({ data: { proposalId, proposalLineId: line.id, requiredRole: line.requiredAuthority!, reason: reasonFor({ ...line, proposedPrice: line.proposedPrice, floorPrice: line.floorPrice }), notes: notes ?? null, requestedByUserId: actor.id, snapshotJson: JSON.stringify(snapshot), policyId: line.policyId } });
      await auditIn(tx, { actorUserId: actor.id, entityType: "ApprovalRequest", entityId: req.id, action: "REQUESTED", context: { line: line.id, requiredRole: line.requiredAuthority, ...snapshot } });
    }
    if (toRoute.length) await tx.proposalLine.updateMany({ where: { id: { in: toRoute.map((r) => r.line.id) } }, data: { approvalState: "PENDING" } });
    const requests = await tx.approvalRequest.findMany({ where: { proposalId, status: { notIn: ["WITHDRAWN", "EXPIRED"] } } });
    const status = routed === 0 ? "APPROVED" : proposalStatusFrom(requests);
    await tx.proposal.update({ where: { id: proposalId }, data: { status, submittedAt: new Date(), lockedAt: new Date(), decidedAt: status === "APPROVED" ? new Date() : null } });
    // The stored rollup carries approval counts: re-roll after the line states moved (REQUIRED → PENDING / APPROVED).
    await refreshEconomics(proposalId, undefined, tx);
    await auditIn(tx, { actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "SUBMITTED", after: { status }, context: { routed, autoApproved: auto, revenue: econ.revenue.toString(), blendedMarginPct: econ.blendedMarginPct?.toString() ?? null } });
    return { status, routed, autoApproved: auto };
  }, { timeout: 60_000, maxWait: 15_000 });
  if (result.routed > 0) { const { notifyApprovalRequested } = await import("@/lib/notifications"); await notifyApprovalRequested(proposalId).catch(() => undefined); }
  return result;
}

/** `audit()` on a transaction client (the audit module writes through the shared client). */
async function auditIn(tx: Db, e: Parameters<typeof audit>[0]) {
  return tx.auditEvent.create({ data: { actorUserId: e.actorUserId ?? null, entityType: e.entityType, entityId: e.entityId, action: e.action, beforeJson: e.before === undefined ? null : JSON.stringify(e.before), afterJson: e.after === undefined ? null : JSON.stringify(e.after), reason: e.reason ?? null, contextJson: e.context === undefined ? null : JSON.stringify(e.context) } });
}

function reasonFor(line: { discountFromListPct: unknown; floorPrice: unknown; proposedPrice: unknown; marginPct: unknown; requiredAuthority: string | null }): string {
  const parts: string[] = [];
  const d = money(line.discountFromListPct as never), f = money(line.floorPrice as never), p = money(line.proposedPrice as never), m = money(line.marginPct as never);
  if (p && f && p.lt(f)) parts.push(`below floor (${p.toFixed(2)} < ${f.toFixed(2)})`);
  if (d) parts.push(`${d.times(100).toFixed(1)}% off list`);
  if (m) parts.push(`margin ${m.times(100).toFixed(1)}%`);
  return parts.join(", ") || `requires ${line.requiredAuthority}`;
}

/** Minimum length of the written reason an ADMIN must give to approve their own request. */
export const BREAK_GLASS_MIN_REASON = 20;

export async function decide(actor: Actor, requestId: string, decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED", comments?: string) {
  if (!["APPROVED", "REJECTED", "CHANGES_REQUESTED"].includes(decision)) throw new Error("decision must be APPROVED, REJECTED or CHANGES_REQUESTED");
  const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId }, include: { proposalLine: true, proposal: { select: { reference: true, status: true } } } });
  await assertProposalVisible(actor, req.proposalId); // a scoped approver decides only inside their book of business
  if (req.status !== "PENDING") throw new Error(`Request already ${req.status.toLowerCase()}`);
  if (["DRAFT", "WON", "LOST"].includes(req.proposal.status)) throw new Error(`Proposal ${req.proposal.reference} is ${req.proposal.status.toLowerCase()}; this request is no longer open for decision`);
  const belowFloor = req.proposalLine && money(req.proposalLine.floorPrice) && money(req.proposalLine.proposedPrice)?.lt(money(req.proposalLine.floorPrice)!);
  // Authority may be the actor's own or lent by an active delegation (out-of-office); the request records which.
  const perm = belowFloor ? "approve_below_floor" : "approve_discount";
  // A delegator who submitted this request lends nothing for it (no approval by proxy); another delegator may still.
  const auth = await authorityFor(actor, req.requiredRole, perm, req.requestedByUserId ? [req.requestedByUserId] : []);
  if (!actor.permissions.has(perm) && !auth.ok) requirePermission(actor, perm);
  if (!auth.ok) throw new AuthError(`This line needs ${req.requiredRole.replace(/_/g, " ").toLowerCase()} authority`);
  const onBehalfOf = auth.onBehalfOf;
  // Nobody decides their own request — except an ADMIN approving it as an audited break-glass
  // action: a written reason is mandatory, the request is flagged, and the other administrators
  // and pricing directors are told. Rejecting or sending back one's own request needs none of that.
  let breakGlass = false;
  if (req.requestedByUserId === actor.id) {
    if (!actor.roles.includes("ADMIN")) throw new AuthError("You cannot approve your own request");
    if (decision === "APPROVED") {
      if ((comments ?? "").trim().length < BREAK_GLASS_MIN_REASON) throw new AuthError(`Approving your own request is a break-glass action: give a reason of at least ${BREAK_GLASS_MIN_REASON} characters. It is recorded in the audit trail and reported to the other administrators.`, 400);
      breakGlass = true;
    }
  }
  // The approver decides the price they reviewed. If the line moved since the request was made
  // (possible while a sibling's changes-requested left the proposal unlocked), the request is void.
  const snap = req.snapshotJson ? (JSON.parse(req.snapshotJson) as { proposedPrice?: string | null }) : null;
  const current = req.proposalLine ? money(req.proposalLine.proposedPrice) : null;
  if (snap?.proposedPrice != null && (current === null || !current.eq(money(snap.proposedPrice)!))) {
    await prisma.approvalRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: `line price changed from ${snap.proposedPrice} to ${current ?? "none"} after the request; resubmit` } });
    throw new Error(`The line's price changed from ${snap.proposedPrice} to ${current ?? "none"} after this request was made; the proposal must be resubmitted`);
  }

  // Claim the request atomically — two approvers deciding at once must yield one decision — and
  // write the decision, the line state, the proposal status and the audit events together.
  const status = await prisma.$transaction(async (tx) => {
    // Serialise decisions per proposal: two approvers deciding two lines at the same moment each
    // derived the proposal status from a snapshot that did not yet see the other's claim and left
    // the proposal PARTIALLY_APPROVED for ever (review REV-01). The row lock makes the second
    // decision wait for the first and see it.
    await tx.$queryRawUnsafe(`SELECT "id" FROM "Proposal" WHERE "id" = $1 FOR UPDATE`, req.proposalId);
    const claimed = await tx.approvalRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: decision, decidedByUserId: actor.id, onBehalfOfUserId: onBehalfOf, decidedAt: new Date(), decisionComments: comments ?? null, breakGlass } });
    if (claimed.count !== 1) throw new Error("Request was decided by someone else a moment ago");
    if (req.proposalLineId) await tx.proposalLine.update({ where: { id: req.proposalLineId }, data: { approvalState: decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "REQUIRED" } });
    const all = await tx.approvalRequest.findMany({ where: { proposalId: req.proposalId, status: { notIn: ["WITHDRAWN", "EXPIRED"] } } });
    const status = proposalStatusFrom(all);
    // Re-derive the status only while the proposal is still in the approval cycle: a proposal that was
    // reopened (DRAFT) or closed (WON / LOST) between the claim and this write keeps its state.
    await tx.proposal.updateMany({ where: { id: req.proposalId, status: { in: ["SUBMITTED", "PARTIALLY_APPROVED", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] } }, data: { status, decidedAt: status === "APPROVED" || status === "REJECTED" ? new Date() : null, ...(status === "CHANGES_REQUESTED" ? { lockedAt: null } : {}) } });
    // The stored rollup carries approval counts: re-roll after the line state moved.
    await refreshEconomics(req.proposalId, undefined, tx);
    await auditIn(tx, { actorUserId: actor.id, entityType: "ApprovalRequest", entityId: requestId, action: decision, reason: comments ?? null, context: { proposalId: req.proposalId, line: req.proposalLineId, requiredRole: req.requiredRole, onBehalfOfUserId: onBehalfOf, breakGlass, snapshot: req.snapshotJson ? JSON.parse(req.snapshotJson) : null } });
    if (breakGlass) await auditIn(tx, { actorUserId: actor.id, entityType: "Proposal", entityId: req.proposalId, action: "BREAK_GLASS_APPROVAL", reason: comments ?? null, context: { approvalRequestId: requestId, line: req.proposalLineId, requiredRole: req.requiredRole, reference: req.proposal.reference } });
    return status;
  }, { timeout: 30_000, maxWait: 15_000 });
  { const { notifyApprovalDecided, notifyBreakGlass } = await import("@/lib/notifications"); await notifyApprovalDecided(requestId).catch(() => undefined); if (breakGlass) await notifyBreakGlass(requestId).catch(() => undefined); }
  if (status === "APPROVED" || status === "REJECTED") { const { requestAnalyticsRefresh } = await import("@/lib/analytics/snapshots"); await requestAnalyticsRefresh(["pricing"]); }
  return { status };
}

/** Reopen a submitted/rejected proposal for editing (withdraws pending requests). */
export async function reopen(actor: Actor, proposalId: string, reason?: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId } });
  if (["WON", "LOST"].includes(p.status)) throw new Error("Closed proposals cannot be reopened; create a new version");
  // One transaction, with the proposal row locked so a decision or an outcome in flight waits and
  // then sees DRAFT (review REV-12): a failure half-way used to leave requests withdrawn and lines
  // REQUIRED under the old status and lock.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "Proposal" WHERE "id" = $1 FOR UPDATE`, proposalId);
    const fresh = await tx.proposal.findUniqueOrThrow({ where: { id: proposalId }, select: { status: true } });
    if (["WON", "LOST"].includes(fresh.status)) throw new Error("Closed proposals cannot be reopened; create a new version");
    await tx.approvalRequest.updateMany({ where: { proposalId, status: { in: ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] } }, data: { status: "WITHDRAWN" } });
    await tx.proposalLine.updateMany({ where: { proposalId, approvalState: { in: ["PENDING", "APPROVED", "REJECTED"] } }, data: { approvalState: "REQUIRED" } });
    await tx.proposal.update({ where: { id: proposalId }, data: { status: "DRAFT", lockedAt: null, submittedAt: null, decidedAt: null } });
    await refreshEconomics(proposalId, undefined, tx);
    await auditIn(tx, { actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "REOPENED", reason: reason ?? null, before: { status: fresh.status } });
  }, { timeout: 30_000, maxWait: 15_000 });
}

export async function finalizeCheck(proposalId: string) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true } });
  return canFinalize({ status: p.status, validThrough: p.validThrough, lines: p.lines.map((l) => ({ included: l.included, approvalState: l.approvalState, proposedPrice: money(l.proposedPrice) })) });
}

export async function queueFor(actor: Actor) {
  const roles = actor.roles;
  const eff = await effectiveAuthority(actor);
  // A scoped approver (regional manager) sees only requests on proposals in their book of business.
  const all = await prisma.approvalRequest.findMany({ where: { status: "PENDING", proposal: proposalWhere(await scopeFor(actor)) }, include: { proposal: { include: { account: true } }, proposalLine: true }, orderBy: { requestedAt: "asc" } });
  const delegators = new Map(eff.delegations.map((d) => [d.fromUserId, d.from.name]));
  return all
    .filter((r) => roles.includes("ADMIN") || hasAuthority(actor, r.requiredRole) || eff.onBehalfOf(r.requiredRole, r.requestedByUserId ? [r.requestedByUserId] : []) !== null)
    .map((r) => { const via = roles.includes("ADMIN") || hasAuthority(actor, r.requiredRole) ? null : eff.onBehalfOf(r.requiredRole, r.requestedByUserId ? [r.requestedByUserId] : []); return { ...r, onBehalfOf: via ? { userId: via, name: delegators.get(via) ?? null } : null, selfSubmitted: r.requestedByUserId === actor.id, breakGlassAllowed: r.requestedByUserId === actor.id && roles.includes("ADMIN") }; });
}

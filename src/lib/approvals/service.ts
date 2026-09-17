/**
 * Deal desk: submission, routing, decisions, locking. Uses the pure rules in
 * ./rules.ts and writes the audit trail for every step.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission, hasAuthority, AuthError } from "@/lib/auth";
import { money } from "@/lib/money";
import { proposalStatusFrom, canFinalize } from "./rules";
import { recomputeAllLines, refreshEconomics } from "@/lib/proposals/service";

/**
 * Submit a proposal. Every included line is re-evaluated against its policy; lines
 * within the submitter's own authority are approved on the spot (audited); the rest
 * get an ApprovalRequest routed to the lowest role that can decide them.
 */
export async function submitForApproval(actor: Actor, proposalId: string, notes?: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true, account: true } });
  if (!["DRAFT", "CHANGES_REQUESTED"].includes(p.status)) throw new Error(`Proposal is ${p.status}; only drafts can be submitted`);
  const econ = await refreshEconomics(proposalId);
  const included = p.lines.filter((l) => l.included);
  if (!included.length) throw new Error("Nothing to submit: no included lines");
  if (included.some((l) => money(l.proposedPrice) === null)) throw new Error("Every included line needs a proposed price before submission");

  // Claim the proposal atomically: two concurrent submissions must not both route requests.
  const claimed = await prisma.proposal.updateMany({ where: { id: proposalId, status: { in: ["DRAFT", "CHANGES_REQUESTED"] }, lockedAt: null }, data: { lockedAt: new Date(), status: "SUBMITTED" } });
  if (claimed.count !== 1) throw new Error("Proposal is already being submitted");

  // Every request from a previous submission is superseded — lines are re-evaluated below, so an
  // old REJECTED / CHANGES_REQUESTED / APPROVED decision must not keep deciding this proposal's status.
  await prisma.approvalRequest.updateMany({ where: { proposalId, status: { in: ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] } }, data: { status: "WITHDRAWN" } });

  let routed = 0, auto = 0;
  try {
  const recomputed = (await recomputeAllLines(proposalId, { dealValue: econ.revenue, strategicAccount: p.account.isStrategic })).filter((l) => l.included);
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
  if (notRequired.length) await prisma.proposalLine.updateMany({ where: { id: { in: notRequired } }, data: { approvalState: "NOT_REQUIRED" } });
  if (autoIds.length) await prisma.proposalLine.updateMany({ where: { id: { in: autoIds } }, data: { approvalState: "APPROVED" } });
  for (const e of autoEvents) await audit(e);
  for (const { line, snapshot } of toRoute) {
    const req = await prisma.approvalRequest.create({ data: { proposalId, proposalLineId: line.id, requiredRole: line.requiredAuthority!, reason: reasonFor({ ...line, proposedPrice: line.proposedPrice, floorPrice: line.floorPrice }), notes: notes ?? null, requestedByUserId: actor.id, snapshotJson: JSON.stringify(snapshot), policyId: line.policyId } });
    await audit({ actorUserId: actor.id, entityType: "ApprovalRequest", entityId: req.id, action: "REQUESTED", context: { line: line.id, requiredRole: line.requiredAuthority, ...snapshot } });
  }
  if (toRoute.length) await prisma.proposalLine.updateMany({ where: { id: { in: toRoute.map((r) => r.line.id) } }, data: { approvalState: "PENDING" } });
  const requests = await prisma.approvalRequest.findMany({ where: { proposalId, status: { notIn: ["WITHDRAWN", "EXPIRED"] } } });
  const status = routed === 0 ? "APPROVED" : proposalStatusFrom(requests);
  await prisma.proposal.update({ where: { id: proposalId }, data: { status, submittedAt: new Date(), lockedAt: new Date(), decidedAt: status === "APPROVED" ? new Date() : null } });
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "SUBMITTED", after: { status }, context: { routed, autoApproved: auto, revenue: econ.revenue.toString(), blendedMarginPct: econ.blendedMarginPct?.toString() ?? null } });
  if (routed > 0) { const { notifyApprovalRequested } = await import("@/lib/notifications"); await notifyApprovalRequested(proposalId).catch(() => undefined); }
  return { status, routed, autoApproved: auto };
  } catch (e) {
    // A half-routed submission must not leave the proposal locked with a partial set of requests.
    await prisma.approvalRequest.updateMany({ where: { proposalId, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: "submission failed" } });
    await prisma.proposalLine.updateMany({ where: { proposalId, approvalState: { in: ["PENDING", "APPROVED"] } }, data: { approvalState: "REQUIRED" } });
    await prisma.proposal.update({ where: { id: proposalId }, data: { status: p.status, lockedAt: null } });
    throw e;
  }
}

function reasonFor(line: { discountFromListPct: unknown; floorPrice: unknown; proposedPrice: unknown; marginPct: unknown; requiredAuthority: string | null }): string {
  const parts: string[] = [];
  const d = money(line.discountFromListPct as never), f = money(line.floorPrice as never), p = money(line.proposedPrice as never), m = money(line.marginPct as never);
  if (p && f && p.lt(f)) parts.push(`below floor (${p.toFixed(2)} < ${f.toFixed(2)})`);
  if (d) parts.push(`${d.times(100).toFixed(1)}% off list`);
  if (m) parts.push(`margin ${m.times(100).toFixed(1)}%`);
  return parts.join(", ") || `requires ${line.requiredAuthority}`;
}

export async function decide(actor: Actor, requestId: string, decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED", comments?: string) {
  if (!["APPROVED", "REJECTED", "CHANGES_REQUESTED"].includes(decision)) throw new Error("decision must be APPROVED, REJECTED or CHANGES_REQUESTED");
  const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId }, include: { proposalLine: true } });
  if (req.status !== "PENDING") throw new Error(`Request already ${req.status.toLowerCase()}`);
  const belowFloor = req.proposalLine && money(req.proposalLine.floorPrice) && money(req.proposalLine.proposedPrice)?.lt(money(req.proposalLine.floorPrice)!);
  requirePermission(actor, belowFloor ? "approve_below_floor" : "approve_discount");
  if (!hasAuthority(actor, req.requiredRole)) throw new AuthError(`This line needs ${req.requiredRole.replace(/_/g, " ").toLowerCase()} authority`);
  if (req.requestedByUserId === actor.id && !actor.roles.includes("ADMIN")) throw new AuthError("You cannot approve your own request");
  // The approver decides the price they reviewed. If the line moved since the request was made
  // (possible while a sibling's changes-requested left the proposal unlocked), the request is void.
  const snap = req.snapshotJson ? (JSON.parse(req.snapshotJson) as { proposedPrice?: string | null }) : null;
  const current = req.proposalLine ? money(req.proposalLine.proposedPrice) : null;
  if (snap?.proposedPrice != null && (current === null || !current.eq(money(snap.proposedPrice)!))) {
    await prisma.approvalRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "WITHDRAWN", decisionComments: `line price changed from ${snap.proposedPrice} to ${current ?? "none"} after the request; resubmit` } });
    throw new Error(`The line's price changed from ${snap.proposedPrice} to ${current ?? "none"} after this request was made; the proposal must be resubmitted`);
  }

  // Claim the request atomically — two approvers deciding at once must yield one decision.
  const claimed = await prisma.approvalRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: decision, decidedByUserId: actor.id, decidedAt: new Date(), decisionComments: comments ?? null } });
  if (claimed.count !== 1) throw new Error("Request was decided by someone else a moment ago");
  if (req.proposalLineId) await prisma.proposalLine.update({ where: { id: req.proposalLineId }, data: { approvalState: decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "REQUIRED" } });
  const all = await prisma.approvalRequest.findMany({ where: { proposalId: req.proposalId, status: { notIn: ["WITHDRAWN", "EXPIRED"] } } });
  const status = proposalStatusFrom(all);
  await prisma.proposal.update({ where: { id: req.proposalId }, data: { status, decidedAt: status === "APPROVED" || status === "REJECTED" ? new Date() : null, ...(status === "CHANGES_REQUESTED" ? { lockedAt: null } : {}) } });
  await audit({ actorUserId: actor.id, entityType: "ApprovalRequest", entityId: requestId, action: decision, reason: comments ?? null, context: { proposalId: req.proposalId, line: req.proposalLineId, requiredRole: req.requiredRole, snapshot: req.snapshotJson ? JSON.parse(req.snapshotJson) : null } });
  { const { notifyApprovalDecided } = await import("@/lib/notifications"); await notifyApprovalDecided(requestId).catch(() => undefined); }
  return { status };
}

/** Reopen a submitted/rejected proposal for editing (withdraws pending requests). */
export async function reopen(actor: Actor, proposalId: string, reason?: string) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId } });
  if (["WON", "LOST"].includes(p.status)) throw new Error("Closed proposals cannot be reopened; create a new version");
  await prisma.approvalRequest.updateMany({ where: { proposalId, status: { in: ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] } }, data: { status: "WITHDRAWN" } });
  await prisma.proposalLine.updateMany({ where: { proposalId, approvalState: { in: ["PENDING", "APPROVED", "REJECTED"] } }, data: { approvalState: "REQUIRED" } });
  await prisma.proposal.update({ where: { id: proposalId }, data: { status: "DRAFT", lockedAt: null, submittedAt: null, decidedAt: null } });
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "REOPENED", reason: reason ?? null, before: { status: p.status } });
}

export async function finalizeCheck(proposalId: string) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: true } });
  return canFinalize({ status: p.status, validThrough: p.validThrough, lines: p.lines.map((l) => ({ included: l.included, approvalState: l.approvalState, proposedPrice: money(l.proposedPrice) })) });
}

export async function queueFor(actor: Actor) {
  const roles = actor.roles;
  const all = await prisma.approvalRequest.findMany({ where: { status: "PENDING" }, include: { proposal: { include: { account: true } }, proposalLine: true }, orderBy: { requestedAt: "asc" } });
  return all.filter((r) => roles.includes("ADMIN") || hasAuthority(actor, r.requiredRole));
}

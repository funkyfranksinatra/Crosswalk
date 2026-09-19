/**
 * Notifications. The in-app inbox (Notification rows) is the system of record and always
 * on; email (SMTP) and Microsoft Teams (incoming webhook) are extra channels delivered by
 * the `notify.deliver` queue with retries, only when configured and only where the
 * recipient's preferences allow.
 *
 * Every event the platform emits goes through `notify()`, which decides recipients from
 * the entity (request creator, proposal owner, approvers with enough authority,
 * reviewers, admins) and never from a free-form list a caller could get wrong.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { satisfiesAuthority, ROLE_PERMISSIONS, type Role } from "@/lib/auth/permissions";
import { notificationsSent } from "@/lib/observability/metrics";

export const KINDS = ["RUN_COMPLETE", "RUN_FAILED", "APPROVAL_REQUESTED", "APPROVAL_DECIDED", "PROPOSAL_APPROVED", "CROSS_PROPOSED", "FEED_FAILED", "ALERT", "JOB_FAILED", "BREAK_GLASS"] as const;
export type Kind = (typeof KINDS)[number];
export type Channel = "email" | "teams";

export function baseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function channelsConfigured(): Record<Channel, boolean> {
  return { email: Boolean(process.env.SMTP_URL && process.env.MAIL_FROM), teams: Boolean(process.env.TEAMS_WEBHOOK_URL) };
}

/** Effective per-user switches for a kind: explicit row → "*" row → defaults. */
export async function preferencesFor(userId: string, kind: Kind): Promise<{ inApp: boolean; email: boolean; teams: boolean }> {
  const rows = await prisma.notificationPreference.findMany({ where: { userId, kind: { in: [kind, "*"] } } });
  const specific = rows.find((r) => r.kind === kind) ?? rows.find((r) => r.kind === "*");
  if (specific) return { inApp: specific.inApp, email: specific.email, teams: specific.teams };
  return { inApp: true, email: true, teams: kind === "ALERT" || kind === "FEED_FAILED" || kind === "JOB_FAILED" };
}

export type NotifyInput = { kind: Kind; userIds: string[]; title: string; body?: string | null; link?: string | null; entityType?: string | null; entityId?: string | null; dedupeKey?: string | null };

/**
 * Create one notification per recipient and queue external deliveries. `dedupeKey` (with
 * entityType/entityId) suppresses a repeat of the same message to the same person within
 * the last hour — alerts and feed failures re-evaluate every few minutes.
 */
export async function notify(input: NotifyInput): Promise<{ created: number }> {
  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (!userIds.length) return { created: 0 };
  const configured = channelsConfigured();
  let created = 0;
  for (const userId of userIds) {
    const prefs = await preferencesFor(userId, input.kind);
    if (!prefs.inApp && !prefs.email && !prefs.teams) continue;
    const dedupeKey = input.dedupeKey ? `${input.kind}:${input.entityType ?? ""}:${input.entityId ?? ""}:${input.dedupeKey}` : null;
    if (dedupeKey) {
      const recent = await prisma.notification.findFirst({ where: { userId, dedupeKey, createdAt: { gt: new Date(Date.now() - 3600_000) } }, select: { id: true } });
      if (recent) continue;
    }
    let row;
    try {
      row = await prisma.notification.create({ data: { userId, kind: input.kind, title: input.title.slice(0, 300), body: input.body?.slice(0, 4000) ?? null, link: input.link ?? null, entityType: input.entityType ?? null, entityId: input.entityId ?? null, dedupeKey, readAt: prefs.inApp ? null : new Date() } });
    } catch (e) {
      // A recipient that no longer exists (deleted user still referenced by a request) is skipped, never fatal.
      log.warn("notify.create_failed", { userId, kind: input.kind, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    created++;
    notificationsSent.inc({ kind: input.kind, channel: "inapp", outcome: "ok" });
    const channels: Channel[] = [];
    if (prefs.email && configured.email) channels.push("email");
    if (prefs.teams && configured.teams) channels.push("teams");
    for (const channel of channels) {
      try {
        const { enqueue, jobsEnabled } = await import("@/lib/jobs/boss");
        if (jobsEnabled()) await enqueue("notify.deliver", { notificationId: row.id, channel }, { singletonKey: `${row.id}:${channel}` });
      } catch (e) {
        log.warn("notify.enqueue_failed", { notificationId: row.id, channel, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  log.info("notify.created", { kind: input.kind, recipients: userIds.length, created, entityType: input.entityType ?? null, entityId: input.entityId ?? null });
  return { created };
}

// ---- recipients --------------------------------------------------------------------------

async function usersWithRoles(roles: Role[]): Promise<string[]> {
  const rows = await prisma.userRole.findMany({ where: { role: { in: roles }, user: { isActive: true } }, select: { userId: true } });
  return [...new Set(rows.map((r) => r.userId))];
}

/** Everyone who could decide a request needing `requiredRole` (authority ladder + approve permission). */
export async function approverIds(requiredRole: string, belowFloor: boolean): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, roles: { select: { role: true } } } });
  const perm = belowFloor ? "approve_below_floor" : "approve_discount";
  return users
    .filter((u) => {
      const roles = u.roles.map((r) => r.role);
      const hasPerm = roles.some((r) => (ROLE_PERMISSIONS[r as Role] ?? []).includes(perm as never));
      return hasPerm && (roles.includes("ADMIN") || satisfiesAuthority(roles, requiredRole));
    })
    .map((u) => u.id);
}

export async function adminIds(): Promise<string[]> {
  return usersWithRoles(["ADMIN", "PRICING_DIRECTOR"]);
}

// ---- event helpers (called from the domain modules) -------------------------------------

export async function notifyRunFinished(requestId: string) {
  const r = await prisma.request.findUnique({ where: { id: requestId }, select: { id: true, reference: true, status: true, error: true, createdByUserId: true, accountName: true, _count: { select: { lines: true } } } });
  if (!r || !r.createdByUserId) return;
  const matched = await prisma.requestLine.count({ where: { requestId, matchStatus: "matched" } });
  const ok = r.status === "complete";
  await notify({
    kind: ok ? "RUN_COMPLETE" : "RUN_FAILED",
    userIds: [r.createdByUserId],
    title: ok ? `${r.reference} is ready — ${matched} of ${r._count.lines} lines matched` : r.status === "cancelled" ? `${r.reference} was cancelled` : `${r.reference} failed`,
    body: ok ? `Cross-reference for ${r.accountName ?? "the account"} finished.` : r.error ?? null,
    link: `${baseUrl()}/requests/${r.id}`,
    entityType: "Request", entityId: r.id,
  });
}

export async function notifyApprovalRequested(proposalId: string) {
  const p = await prisma.proposal.findUnique({ where: { id: proposalId }, include: { account: { select: { name: true } }, approvals: { where: { status: "PENDING" }, include: { proposalLine: { select: { proposedPrice: true, floorPrice: true, sku: true } } } } } });
  if (!p || !p.approvals.length) return;
  // Each submission is a new ask: key the dedupe on it, so a resubmission within the hour is not swallowed.
  const submission = p.submittedAt?.toISOString() ?? String(Date.now());
  const submitters = new Set(p.approvals.map((r) => r.requestedByUserId).filter((x): x is string => Boolean(x)));
  const byRole = new Map<string, { count: number; belowFloor: boolean }>();
  for (const r of p.approvals) {
    const bf = Boolean(r.proposalLine?.floorPrice && r.proposalLine.proposedPrice && Number(r.proposalLine.proposedPrice) < Number(r.proposalLine.floorPrice));
    const cur = byRole.get(r.requiredRole) ?? { count: 0, belowFloor: false };
    byRole.set(r.requiredRole, { count: cur.count + 1, belowFloor: cur.belowFloor || bf });
  }
  for (const [role, { count, belowFloor }] of byRole) {
    // Never the submitter (decide() refuses self-approval) — the owner or whoever submitted on their behalf.
    // Delegates (out-of-office) are told too; the delegating user still gets theirs.
    const { delegatesFor } = await import("@/lib/approvals/delegation");
    const delegated = (await delegatesFor(role, belowFloor)).filter((d) => !submitters.has(d.fromUserId)).map((d) => d.toUserId);
    const ids = [...new Set([...(await approverIds(role, belowFloor)), ...delegated])].filter((id) => id !== p.ownerUserId && !submitters.has(id));
    await notify({ kind: "APPROVAL_REQUESTED", userIds: ids, title: `${p.reference} needs your approval — ${count} line${count === 1 ? "" : "s"} (${role.replace(/_/g, " ").toLowerCase()})`, body: `${p.account.name}${belowFloor ? " · includes a below-floor price" : ""}`, link: `${baseUrl()}/approvals`, entityType: "Proposal", entityId: p.id, dedupeKey: `req:${role}:${submission}` });
  }
}

export async function notifyApprovalDecided(requestId: string) {
  const r = await prisma.approvalRequest.findUnique({ where: { id: requestId }, include: { proposal: { select: { id: true, reference: true, ownerUserId: true, status: true } }, proposalLine: { select: { sku: true } } } });
  if (!r) return;
  const decidedBy = r.decidedByUserId ? await prisma.user.findUnique({ where: { id: r.decidedByUserId }, select: { name: true } }) : null;
  const recipients = [...new Set([r.proposal.ownerUserId, r.requestedByUserId].filter((x): x is string => Boolean(x)))];
  const verb = r.status === "APPROVED" ? "approved" : r.status === "REJECTED" ? "rejected" : "sent back with changes requested";
  await notify({ kind: "APPROVAL_DECIDED", userIds: recipients, title: `${r.proposal.reference}: ${r.proposalLine?.sku ?? "a line"} ${verb} by ${decidedBy?.name ?? "an approver"}`, body: r.decisionComments ?? null, link: `${baseUrl()}/proposals/${r.proposal.id}`, entityType: "ApprovalRequest", entityId: r.id });
  if (r.proposal.status === "APPROVED") await notify({ kind: "PROPOSAL_APPROVED", userIds: recipients, title: `${r.proposal.reference} is fully approved — ready to export`, link: `${baseUrl()}/proposals/${r.proposal.id}`, entityType: "Proposal", entityId: r.proposal.id, dedupeKey: `approved:${r.decidedAt?.toISOString() ?? ""}` });
}

/** An ADMIN approved their own request: every other ADMIN and PRICING_DIRECTOR hears about it. */
export async function notifyBreakGlass(requestId: string) {
  const r = await prisma.approvalRequest.findUnique({ where: { id: requestId }, include: { proposal: { select: { id: true, reference: true } }, proposalLine: { select: { sku: true } } } });
  if (!r || !r.breakGlass || !r.decidedByUserId) return;
  const who = await prisma.user.findUnique({ where: { id: r.decidedByUserId }, select: { name: true } });
  const recipients = (await adminIds()).filter((id) => id !== r.decidedByUserId);
  await notify({ kind: "BREAK_GLASS", userIds: recipients, title: `Break-glass: ${who?.name ?? "an administrator"} approved their own request on ${r.proposal.reference}${r.proposalLine ? ` (${r.proposalLine.sku})` : ""}`, body: r.decisionComments ?? null, link: `${baseUrl()}/proposals/${r.proposal.id}`, entityType: "ApprovalRequest", entityId: r.id });
}

export async function notifyCrossProposed(knownCrossId: string) {
  const k = await prisma.knownCross.findUnique({ where: { id: knownCrossId } });
  if (!k) return;
  const ids = await usersWithRoles(["CLINICAL_REVIEWER", "PRODUCT_MARKETING"]);
  await notify({ kind: "CROSS_PROPOSED", userIds: ids, title: `New cross to review: ${k.competitorName} ${k.competitorCode} → ${k.ownSku} (${k.matchType})`, body: k.justification ?? null, link: `${baseUrl()}/crosses`, entityType: "KnownCross", entityId: k.id, dedupeKey: "proposed" });
}

export async function notifyFeedFailed(feed: string, error: string, feedRunId: string | null) {
  await notify({ kind: "FEED_FAILED", userIds: await adminIds(), title: `Feed "${feed}" failed`, body: error, link: `${baseUrl()}/settings`, entityType: "FeedRun", entityId: feedRunId, dedupeKey: feed });
}

export async function notifyAlert(a: { fingerprint: string; severity: string; title: string; detail: string | null; id: string }) {
  await notify({ kind: "ALERT", userIds: await adminIds(), title: `[${a.severity}] ${a.title}`, body: a.detail, link: `${baseUrl()}/settings`, entityType: "Alert", entityId: a.id, dedupeKey: a.fingerprint });
}

export async function notifyJobFailed(queue: string, data: unknown, error: string) {
  const d = (data ?? {}) as Record<string, unknown>;
  const what = typeof d.requestId === "string" ? `request ${d.requestId}` : typeof d.importId === "string" ? `import ${d.importId}` : typeof d.feed === "string" ? `feed ${d.feed}` : queue;
  await notify({ kind: "JOB_FAILED", userIds: await adminIds(), title: `Background job failed after all retries: ${what}`, body: error, link: `${baseUrl()}/settings`, entityType: "Job", entityId: queue, dedupeKey: what });
}

// ---- inbox ------------------------------------------------------------------------------

export async function inboxFor(userId: string, opts: { unreadOnly?: boolean; take?: number } = {}) {
  return prisma.notification.findMany({ where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(200, opts.take ?? 50) });
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(userId: string, ids: string[] | "all") {
  const res = await prisma.notification.updateMany({ where: { userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) }, data: { readAt: new Date() } });
  return res.count;
}

export async function setPreference(userId: string, kind: Kind | "*", patch: { inApp?: boolean; email?: boolean; teams?: boolean }) {
  if (kind !== "*" && !KINDS.includes(kind)) throw new Error(`unknown notification kind ${kind}`);
  return prisma.notificationPreference.upsert({ where: { userId_kind: { userId, kind } }, create: { userId, kind, inApp: patch.inApp ?? true, email: patch.email ?? true, teams: patch.teams ?? false }, update: patch });
}

/** Both parties of a new delegation are told (the delegate needs to know the queue is theirs). */
export async function notifyDelegation(delegationId: string) {
  const d = await prisma.approvalDelegation.findUnique({ where: { id: delegationId }, include: { from: { select: { id: true, name: true } }, to: { select: { id: true, name: true } } } });
  if (!d) return;
  const window = `${d.startsAt.toISOString().slice(0, 10)} → ${d.endsAt.toISOString().slice(0, 10)}`;
  await notify({ kind: "APPROVAL_REQUESTED", userIds: [d.to.id], title: `${d.from.name} delegated their approvals to you (${window})`, body: d.reason ?? "Requests routed to their authority now appear in your deal desk queue.", link: `${baseUrl()}/approvals`, entityType: "ApprovalDelegation", entityId: d.id, dedupeKey: `delegation:${d.id}:to` });
  if (d.createdByUserId && d.createdByUserId !== d.from.id) await notify({ kind: "APPROVAL_REQUESTED", userIds: [d.from.id], title: `Your approvals were delegated to ${d.to.name} (${window})`, body: "Set by an administrator.", link: `${baseUrl()}/approvals`, entityType: "ApprovalDelegation", entityId: d.id, dedupeKey: `delegation:${d.id}:from` });
}

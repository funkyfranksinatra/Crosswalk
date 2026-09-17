/**
 * Approval delegation / out-of-office (Tier 3.9).
 *
 * A director on holiday blocks their queue. A delegation lends their APPROVAL AUTHORITY —
 * the discount-authority roles (SALES_REP … PRICING_COMMITTEE) and the approve permissions —
 * to a named colleague for a window. Everything else stays theirs: ADMIN is never delegated,
 * no other permission travels, and the delegate decides in their own name with the request
 * recording on whose behalf (`ApprovalRequest.onBehalfOfUserId`) — so the audit trail says
 * "Lee approved, with Dana's authority", never "Dana approved".
 *
 * Rules: only yourself (ADMIN: anyone) may be delegated; a window is at most 90 days; the
 * delegate must be an active user; a delegate cannot approve a request they submitted, nor
 * one the delegator submitted (self-approval by proxy).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, AuthError } from "@/lib/auth";
import { AUTHORITY_ORDER, ROLE_PERMISSIONS, satisfiesAuthority, type Role } from "@/lib/auth/permissions";
import { log } from "@/lib/log";

export const MAX_DELEGATION_DAYS = 90;
const DELEGABLE_ROLES = new Set<string>([...AUTHORITY_ORDER]);
const DELEGABLE_PERMS = ["approve_discount", "approve_below_floor"] as const;

export type Delegation = { id: string; fromUserId: string; toUserId: string; startsAt: Date; endsAt: Date; reason: string | null; revokedAt: Date | null; createdAt: Date; createdByUserId: string | null; from: { id: string; name: string; email: string }; to: { id: string; name: string; email: string } };

const include = { from: { select: { id: true, name: true, email: true } }, to: { select: { id: true, name: true, email: true } } } as const;

/** Delegations that lend authority TO this user right now. */
export async function activeDelegationsTo(userId: string, at = new Date()) {
  return prisma.approvalDelegation.findMany({ where: { toUserId: userId, revokedAt: null, startsAt: { lte: at }, endsAt: { gte: at } }, include, orderBy: { startsAt: "asc" } });
}

export type EffectiveAuthority = {
  /** Own roles plus the delegable roles of everyone who delegated to this user. */
  roles: string[];
  /** Approve permissions gained through a delegation (own permissions are on the actor). */
  permissions: Set<string>;
  /** Which delegator's authority satisfies a required role (null = the actor's own). */
  onBehalfOf: (requiredRole: string) => string | null;
  delegations: Delegation[];
};

/** The actor's authority including active delegations. Pure function of the loaded delegations. */
export function effectiveAuthorityFrom(actor: Actor, delegations: (Delegation & { fromRoles: string[] })[]): EffectiveAuthority {
  const roles = new Set(actor.roles);
  const permissions = new Set<string>();
  const byDelegator: { userId: string; roles: string[] }[] = [];
  for (const d of delegations) {
    const lent = d.fromRoles.filter((r) => DELEGABLE_ROLES.has(r));
    if (!lent.length) continue;
    for (const r of lent) roles.add(r);
    for (const r of lent) for (const p of ROLE_PERMISSIONS[r as Role] ?? []) if ((DELEGABLE_PERMS as readonly string[]).includes(p)) permissions.add(p);
    byDelegator.push({ userId: d.fromUserId, roles: lent });
  }
  return {
    roles: [...roles],
    permissions,
    delegations,
    onBehalfOf: (required: string) => {
      if (satisfiesAuthority(actor.roles, required)) return null; // own authority suffices
      for (const d of byDelegator) if (satisfiesAuthority(d.roles, required)) return d.userId;
      return null;
    },
  };
}

export async function effectiveAuthority(actor: Actor, at = new Date()): Promise<EffectiveAuthority> {
  const rows = await activeDelegationsTo(actor.id, at);
  if (!rows.length) return effectiveAuthorityFrom(actor, []);
  const fromIds = [...new Set(rows.map((r) => r.fromUserId))];
  const users = await prisma.user.findMany({ where: { id: { in: fromIds }, isActive: true }, select: { id: true, roles: { select: { role: true } } } });
  const rolesOf = new Map(users.map((u) => [u.id, u.roles.map((r) => r.role)]));
  return effectiveAuthorityFrom(actor, rows.filter((r) => rolesOf.has(r.fromUserId)).map((r) => ({ ...r, fromRoles: rolesOf.get(r.fromUserId) ?? [] })));
}

/** Does the actor, with delegations, hold `requiredRole` authority? Returns who lends it (null = own). */
export async function authorityFor(actor: Actor, requiredRole: string): Promise<{ ok: boolean; onBehalfOf: string | null; effective: EffectiveAuthority }> {
  const effective = await effectiveAuthority(actor);
  if (satisfiesAuthority(actor.roles, requiredRole)) return { ok: true, onBehalfOf: null, effective };
  const via = effective.onBehalfOf(requiredRole);
  return { ok: via !== null, onBehalfOf: via, effective };
}

export async function listDelegations(actor: Actor, opts: { all?: boolean } = {}) {
  const admin = actor.roles.includes("ADMIN");
  const where = opts.all && admin ? {} : { OR: [{ fromUserId: actor.id }, { toUserId: actor.id }] };
  const rows = await prisma.approvalDelegation.findMany({ where, include, orderBy: [{ endsAt: "desc" }], take: 200 });
  const now = Date.now();
  return rows.map((r) => ({ ...r, state: r.revokedAt ? "revoked" : r.endsAt.getTime() < now ? "expired" : r.startsAt.getTime() > now ? "scheduled" : "active" }));
}

export async function createDelegation(actor: Actor, input: { fromUserId?: string | null; toUserId: string; startsAt?: string | Date | null; endsAt: string | Date; reason?: string | null }) {
  const fromUserId = input.fromUserId?.trim() || actor.id;
  if (fromUserId !== actor.id && !actor.roles.includes("ADMIN")) throw new AuthError("Only an admin can delegate on someone else's behalf");
  if (!input.toUserId || typeof input.toUserId !== "string") throw new Error("toUserId is required");
  if (input.toUserId === fromUserId) throw new Error("You cannot delegate to yourself");
  const from = await prisma.user.findUnique({ where: { id: fromUserId }, include: { roles: true } });
  const to = await prisma.user.findUnique({ where: { id: input.toUserId }, include: { roles: true } });
  if (!from || !from.isActive) throw new Error("Delegating user not found");
  if (!to || !to.isActive) throw new Error("Delegate not found or inactive");
  const fromRoles = from.roles.map((r) => r.role);
  if (!fromRoles.some((r) => DELEGABLE_ROLES.has(r) && (ROLE_PERMISSIONS[r as Role] ?? []).includes("approve_discount"))) throw new Error(`${from.name} has no approval authority to delegate`);
  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error("startsAt / endsAt must be dates");
  if (endsAt <= startsAt) throw new Error("endsAt must be after startsAt");
  if (endsAt.getTime() - startsAt.getTime() > MAX_DELEGATION_DAYS * 86_400_000) throw new Error(`A delegation can cover at most ${MAX_DELEGATION_DAYS} days`);
  if (endsAt.getTime() < Date.now()) throw new Error("endsAt is in the past");
  const reason = input.reason ? String(input.reason).slice(0, 500) : null;
  // Two live delegations from the same person to the same delegate that overlap are one delegation.
  const overlap = await prisma.approvalDelegation.findFirst({ where: { fromUserId, toUserId: to.id, revokedAt: null, startsAt: { lte: endsAt }, endsAt: { gte: startsAt } } });
  if (overlap) throw new Error(`An overlapping delegation to ${to.name} already exists (${overlap.startsAt.toISOString().slice(0, 10)} – ${overlap.endsAt.toISOString().slice(0, 10)})`);
  const row = await prisma.approvalDelegation.create({ data: { fromUserId, toUserId: to.id, startsAt, endsAt, reason, createdByUserId: actor.id }, include });
  await audit({ actorUserId: actor.id, entityType: "ApprovalDelegation", entityId: row.id, action: "CREATED", after: { from: from.email, to: to.email, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason, lends: fromRoles.filter((r) => DELEGABLE_ROLES.has(r)) } });
  log.info("approvals.delegation_created", { from: fromUserId, to: to.id, endsAt: endsAt.toISOString() });
  { const { notifyDelegation } = await import("@/lib/notifications"); await notifyDelegation(row.id).catch(() => undefined); }
  return row;
}

export async function revokeDelegation(actor: Actor, id: string) {
  const row = await prisma.approvalDelegation.findUnique({ where: { id } });
  if (!row) throw new Error("Delegation not found");
  if (row.fromUserId !== actor.id && !actor.roles.includes("ADMIN")) throw new AuthError("Only the delegating user or an admin can revoke this");
  if (row.revokedAt) return row;
  const updated = await prisma.approvalDelegation.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit({ actorUserId: actor.id, entityType: "ApprovalDelegation", entityId: id, action: "REVOKED", before: { endsAt: row.endsAt.toISOString() } });
  return updated;
}

/** Users who currently hold `requiredRole` authority through a delegation (for notifications). */
export async function delegatesFor(requiredRole: string, belowFloor: boolean, at = new Date()): Promise<{ toUserId: string; fromUserId: string }[]> {
  const rows = await prisma.approvalDelegation.findMany({ where: { revokedAt: null, startsAt: { lte: at }, endsAt: { gte: at } }, select: { toUserId: true, fromUserId: true, from: { select: { isActive: true, roles: { select: { role: true } } } }, to: { select: { isActive: true } } } });
  const perm = belowFloor ? "approve_below_floor" : "approve_discount";
  return rows
    .filter((r) => r.from.isActive && r.to.isActive)
    .filter((r) => { const roles = r.from.roles.map((x) => x.role).filter((x) => DELEGABLE_ROLES.has(x)); return roles.some((x) => (ROLE_PERMISSIONS[x as Role] ?? []).includes(perm)) && satisfiesAuthority(roles, requiredRole); })
    .map((r) => ({ toUserId: r.toUserId, fromUserId: r.fromUserId }));
}

/**
 * Ownership / territory scoping (Tier 0.2) — horizontal access control.
 *
 * Permissions say WHAT a role may do; scope says WHICH accounts it may do it to. The rule
 * agreed with the business:
 *
 *   SALES_REP          accounts they own, accounts in their territory, and anything they created
 *   REGIONAL_MANAGER   accounts in their territory (and their own), plus what they created
 *   everyone else      everything (contracting, pricing, finance, marketing, clinical, executive, admin)
 *
 * An account nobody owns and that has no territory is visible to every scoped user until it is
 * assigned — a fresh intake must not disappear. A child account is visible when its parent is
 * (an IDN's hospitals follow the IDN). Requests, proposals, contracts, purchases and outcomes
 * follow their account; a request with no account yet is visible to its creator.
 *
 * Everything here returns Prisma `where` fragments or throws a 404-style AuthError, so a scoped
 * user cannot tell the difference between "does not exist" and "not yours". The unit test in
 * tests/unit/tier0-units.test.ts pins the fragments; the DB test pins the behaviour.
 */
import { prisma } from "@/lib/db";
import { AuthError, type Actor } from "./index";

/** Roles whose view is limited to their own book of business. */
export const SCOPED_ROLES = new Set(["SALES_REP", "REGIONAL_MANAGER"]);

export type Scope = { mode: "all" } | { mode: "scoped"; userId: string; territories: string[] };

/** Territories are on the User row (`territory`, comma-separated allowed) — not on the actor by default. */
export async function scopeFor(actor: Actor): Promise<Scope> {
  if (!actor.roles.some((r) => SCOPED_ROLES.has(r)) || actor.roles.some((r) => !SCOPED_ROLES.has(r))) return { mode: "all" };
  const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { territory: true } });
  const territories = (u?.territory ?? "").split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  return { mode: "scoped", userId: actor.id, territories };
}

/** Account rows this scope may see (Prisma where fragment; `{}` for "all"). */
export function accountWhere(scope: Scope): Record<string, unknown> {
  if (scope.mode === "all") return {};
  const own: Record<string, unknown>[] = [
    { ownerUserId: scope.userId },
    ...(scope.territories.length ? [{ territory: { in: scope.territories, mode: "insensitive" } }] : []),
    { ownerUserId: null, territory: null }, // unassigned: visible until someone owns it
  ];
  return { OR: [...own, { parent: { OR: own } }] };
}

export function requestWhere(scope: Scope): Record<string, unknown> {
  if (scope.mode === "all") return {};
  return { OR: [{ createdByUserId: scope.userId }, { account: accountWhere(scope) }] };
}

export function proposalWhere(scope: Scope): Record<string, unknown> {
  if (scope.mode === "all") return {};
  return { OR: [{ ownerUserId: scope.userId }, { createdByUserId: scope.userId }, { account: accountWhere(scope) }] };
}

export function contractWhere(scope: Scope): Record<string, unknown> {
  if (scope.mode === "all") return {};
  // National and GPO contracts have no account: everyone may see the price lists they might sell under.
  return { OR: [{ accountId: null, parentAccountId: null }, { account: accountWhere(scope) }, { parentAccount: accountWhere(scope) }] };
}

const notFound = () => new AuthError("not found", 404);

/** Load-or-404 helpers for detail routes. The same 404 whether the row is missing or out of scope. */
export async function assertAccountVisible(actor: Actor, id: string): Promise<void> {
  const scope = await scopeFor(actor);
  if (scope.mode === "all") return;
  const row = await prisma.account.findFirst({ where: { id, ...accountWhere(scope) }, select: { id: true } });
  if (!row) throw notFound();
}
export async function assertRequestVisible(actor: Actor, id: string): Promise<void> {
  const scope = await scopeFor(actor);
  if (scope.mode === "all") return;
  const row = await prisma.request.findFirst({ where: { id, ...requestWhere(scope) }, select: { id: true } });
  if (!row) throw notFound();
}
export async function assertProposalVisible(actor: Actor, id: string): Promise<void> {
  const scope = await scopeFor(actor);
  if (scope.mode === "all") return;
  const row = await prisma.proposal.findFirst({ where: { id, ...proposalWhere(scope) }, select: { id: true } });
  if (!row) throw notFound();
}
export async function assertContractVisible(actor: Actor, id: string): Promise<void> {
  const scope = await scopeFor(actor);
  if (scope.mode === "all") return;
  const row = await prisma.contract.findFirst({ where: { id, ...contractWhere(scope) }, select: { id: true } });
  if (!row) throw notFound();
}

/** May this actor create a request / proposal against this account? Same rule as reading it. */
export async function assertAccountWritable(actor: Actor, accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  await assertAccountVisible(actor, accountId);
}

/**
 * The central hook (src/lib/api.ts): `/api/<entity>/<id>/…` is checked against the actor's scope
 * whatever the route does. Ids are cuids (20+ chars); anything shorter is a sub-resource name.
 */
const PATH_ENTITY = /^\/api\/(accounts|requests|proposals|contracts)\/([a-z0-9]{20,})(?:\/|$)/i;
export async function enforceScopeForPath(actor: Actor, pathname: string | null): Promise<void> {
  if (!pathname) return;
  const m = pathname.match(PATH_ENTITY);
  if (!m) return;
  const id = m[2];
  switch (m[1].toLowerCase()) {
    case "accounts": return assertAccountVisible(actor, id);
    case "requests": return assertRequestVisible(actor, id);
    case "proposals": return assertProposalVisible(actor, id);
    case "contracts": return assertContractVisible(actor, id);
  }
}

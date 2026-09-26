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
 * owned or in territory (an IDN's hospitals follow the IDN). Whether an *unassigned* parent also
 * broadens its children is a per-company choice (Settings → Account visibility,
 * `scopeUnassignedParent`): by default ("inherit") it does, as it always has — the IDN's members
 * are visible to every scoped user while the IDN is unassigned; "own" narrows that so a hospital
 * with its own owner or territory stays with them. The default keeps an upgrade from silently
 * taking accounts out of anyone's view (a manager with no territory would lose the approvals on
 * them — CI, Sept 26). Requests, proposals, contracts, purchases and outcomes
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

export type Scope = { mode: "all" } | { mode: "scoped"; userId: string; territories: string[]; unassignedParentBroadens?: boolean };

/** Settings key: "inherit" (default — children of an unassigned parent are visible, as the parent is) or "own" (the child's own owner/territory governs). */
export const SCOPE_UNASSIGNED_PARENT_KEY = "scopeUnassignedParent";

/**
 * Territories are on the User row (`territory`, comma-separated allowed) — not on the actor by
 * default. A user with no roles at all is scoped to nothing rather than to everything.
 */
export async function scopeFor(actor: Actor): Promise<Scope> {
  if (actor.roles.length && actor.roles.every((r) => !SCOPED_ROLES.has(r))) return { mode: "all" };
  if (actor.roles.some((r) => !SCOPED_ROLES.has(r))) return { mode: "all" }; // any unscoped role widens the view
  const [u, setting] = await Promise.all([
    prisma.user.findUnique({ where: { id: actor.id }, select: { territory: true } }),
    prisma.setting.findUnique({ where: { key: SCOPE_UNASSIGNED_PARENT_KEY }, select: { value: true } }),
  ]);
  const territories = (u?.territory ?? "").split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  return { mode: "scoped", userId: actor.id, territories, unassignedParentBroadens: setting?.value !== "own" };
}

/** Account rows this scope may see (Prisma where fragment; `{}` for "all"). */
export function accountWhere(scope: Scope): Record<string, unknown> {
  if (scope.mode === "all") return {};
  const assigned: Record<string, unknown>[] = [
    { ownerUserId: scope.userId },
    ...(scope.territories.length ? [{ territory: { in: scope.territories, mode: "insensitive" } }] : []),
  ];
  const unassigned = { ownerUserId: null, territory: null }; // visible until someone owns it
  const own = [...assigned, unassigned];
  // Children follow an owned / in-territory parent, and an unassigned one unless the company chose
  // "own" (then the child's own assignment governs). Absent means the default: broadens.
  return { OR: [...own, { parent: { OR: scope.unassignedParentBroadens === false ? assigned : own } }] };
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
 * The central hook (src/lib/api.ts): `/api/<entity>/<segment>/…` is checked against the actor's
 * scope whatever the route does. The path is decoded first (Next decodes route params, so an
 * encoded id would otherwise reach the handler unchecked). A segment that is a short plain word
 * is a collection sub-route (`/api/accounts/sync`); anything else is treated as an id and must be
 * visible — a malformed or unknown id is a 404, never a pass.
 */
const PATH_ENTITY = /^\/api\/(accounts|requests|proposals|contracts)\/([^/]+)(?:\/|$)/i;
const SUBROUTE_WORD = /^[a-z][a-z-]{0,15}$/;
export async function enforceScopeForPath(actor: Actor, pathname: string | null): Promise<void> {
  if (!pathname) return;
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { throw notFound(); }
  // "/api/proposals//<id>": duplicate slashes must not push the id out of the slot the pattern checks.
  decoded = decoded.replace(/\/{2,}/g, "/");
  const m = decoded.match(PATH_ENTITY);
  if (!m) return;
  const id = m[2];
  if (SUBROUTE_WORD.test(id)) return;
  if (!/^[a-z0-9]{20,40}$/i.test(id)) throw notFound();
  switch (m[1].toLowerCase()) {
    case "accounts": return assertAccountVisible(actor, id);
    case "requests": return assertRequestVisible(actor, id);
    case "proposals": return assertProposalVisible(actor, id);
    case "contracts": return assertContractVisible(actor, id);
  }
}

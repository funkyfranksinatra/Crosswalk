/**
 * Who is acting, and what may they do.
 *
 * `AuthProvider` resolves the current user from the request. Two implementations:
 *  - DevAuthProvider — reads the `crosswalk_dev_user` cookie set by the sidebar's
 *    *Development sign-in*. Only active when no SSO provider is configured; every
 *    page shows a banner while it is in use.
 *  - SsoAuthProvider — placeholder that documents what an Entra/Okta (OIDC) adapter
 *    must implement (subject → User by externalId/email). Throws NotConfigured.
 *
 * Services call `requirePermission(actor, "…")`; API routes call `getActor()` first.
 * Authorization is always server-side.
 */
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import { permissionsFor, satisfiesAuthority, type Permission } from "./permissions";

export type Actor = {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: Set<Permission>;
  isDev: boolean;
};

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 403) { super(message); this.status = status; }
}

export const DEV_COOKIE = "crosswalk_dev_user";

export function ssoConfigured(): boolean {
  return Boolean(process.env.SSO_ISSUER && process.env.SSO_CLIENT_ID);
}

async function loadActor(userId: string | null, isDev: boolean): Promise<Actor | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
  if (!u || !u.isActive) return null;
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev };
}

/** Resolve the acting user for the current request (server components + route handlers). */
export async function getActor(): Promise<Actor | null> {
  if (ssoConfigured()) {
    // SSO adapter contract: validate the session (cookie / bearer), map subject → User.externalId.
    // Not implemented in this build; see docs/INTEGRATIONS.md "SSO".
    const h = await headers();
    const sub = h.get("x-sso-subject"); // set by an authenticating reverse proxy in front of the app
    if (!sub) return null;
    const u = await prisma.user.findFirst({ where: { OR: [{ externalId: sub }, { email: sub }] } });
    return loadActor(u?.id ?? null, false);
  }
  const c = await cookies();
  const id = c.get(DEV_COOKIE)?.value ?? null;
  return loadActor(id, true);
}

export async function requireActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) throw new AuthError("Sign in required", 401);
  return a;
}

export function can(actor: Actor | null, perm: Permission): boolean {
  return Boolean(actor?.permissions.has(perm));
}

export function requirePermission(actor: Actor | null, perm: Permission): Actor {
  if (!actor) throw new AuthError("Sign in required", 401);
  if (!actor.permissions.has(perm)) throw new AuthError(`Missing permission: ${perm}`, 403);
  return actor;
}

export function hasAuthority(actor: Actor, requiredRole: string): boolean {
  return satisfiesAuthority(actor.roles, requiredRole);
}

/** Strip cost/margin fields for actors who may not see them. */
export function redactForActor<T extends Record<string, unknown>>(actor: Actor | null, obj: T): T {
  const hideCost = !can(actor, "view_cost");
  const hideMargin = !can(actor, "view_margin");
  if (!hideCost && !hideMargin) return obj;
  const out: Record<string, unknown> = { ...obj };
  if (hideCost) for (const k of ["cost", "costBasisJson", "floorPrice"]) if (k in out) out[k] = null;
  if (hideMargin) for (const k of ["marginAmount", "marginPct"]) if (k in out) out[k] = null;
  return out as T;
}

/** Route-handler helper: turn AuthError into a JSON response, rethrow anything else. */
export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
  return null;
}

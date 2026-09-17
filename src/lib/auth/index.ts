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
import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * The development session cookie is `<userId>.<hmac>`; a bare user id — which anyone can
 * read off the sign-in list — is not a session. The key is SESSION_SECRET; a dev box
 * without one gets a fixed insecure key (and a warning) so `next dev` restarts keep you
 * signed in; a production build without SSO refuses dev sessions unless ALLOW_DEV_SIGNIN.
 */
function sessionKey(): string | null {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_SIGNIN !== "true") return null;
  return "crosswalk-dev-insecure-session-key";
}
export function devSessionsAllowed(): boolean {
  return !ssoConfigured() && sessionKey() !== null;
}
export function signSession(userId: string): string {
  const key = sessionKey();
  if (!key) throw new AuthError("Development sessions are disabled", 403);
  return `${userId}.${createHmac("sha256", key).update(userId).digest("base64url")}`;
}
export function verifySession(value: string | undefined | null): string | null {
  const key = sessionKey();
  if (!value || !key) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", key).update(id).digest("base64url"));
  return sig.length === want.length && timingSafeEqual(sig, want) ? id : null;
}

async function loadActor(userId: string | null, isDev: boolean): Promise<Actor | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
  if (!u || !u.isActive) return null;
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev };
}

/** Test seam: route handlers under Vitest have no request headers. Inert outside the test runner. */
let testActor: Actor | null = null;
export function setActorForTests(a: Actor | null) {
  if (!process.env.VITEST || process.env.NODE_ENV === "production") throw new Error("setActorForTests is only available under Vitest");
  testActor = a;
}

/** Resolve the acting user for the current request (server components + route handlers). */
export async function getActor(): Promise<Actor | null> {
  if (testActor && process.env.VITEST && process.env.NODE_ENV !== "production") return testActor;
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
  const id = verifySession(c.get(DEV_COOKIE)?.value);
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
  // Nested JSON on a line (recommendation, waterfall) carries the same figures.
  for (const k of ["recommendationJson", "waterfallJson", "competitorIntelJson"]) {
    if (typeof out[k] === "string") { try { out[k] = JSON.stringify(redactJsonForActor(actor, JSON.parse(out[k] as string))); } catch { /* leave as is */ } }
  }
  return out as T;
}

const COST_KEYS = new Set(["cost", "costBasisJson", "floorPrice", "floor", "cogs", "standardCost", "unitCost"]);
const MARGIN_KEYS = new Set(["marginAmount", "marginPct", "grossProfit", "blendedMarginPct", "margin", "targetMarginPct", "minMarginPct"]);

/**
 * Deep redaction for JSON blobs (audit before/after/context, economics): cost and margin never
 * reach a role without the permission, however deeply they are nested.
 */
export function redactJsonForActor(actor: Actor | null, value: unknown): unknown {
  const hideCost = !can(actor, "view_cost"), hideMargin = !can(actor, "view_margin");
  if (!hideCost && !hideMargin) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = (hideCost && COST_KEYS.has(k)) || (hideMargin && MARGIN_KEYS.has(k)) ? null : walk(x);
      // A recommendation's prose carries margin and floor figures; swap in the public wording.
      if (typeof out.explanation === "string" && typeof out.explanationPublic === "string") out.explanation = out.explanationPublic;
      else if (typeof out.explanation === "string" && /margin|floor/i.test(out.explanation)) out.explanation = out.explanation.replace(/Gross margin [^.,]*,?\s*/i, "").replace(/\$[\d,.]+ (above|BELOW) the [^.]*floor \$[\d,.]+/i, "$1 the floor".replace("$1", "near")).replace(/Margin unknown \(no cost on file\),?\s*/i, "");
      return out;
    }
    return v;
  };
  return walk(value);
}

/** An audit event with its JSON payloads redacted for the actor. */
export function redactAuditEvent<T extends { beforeJson: string | null; afterJson: string | null; contextJson: string | null }>(actor: Actor | null, e: T): T {
  if (can(actor, "view_cost") && can(actor, "view_margin")) return e;
  const red = (s: string | null) => { if (!s) return s; try { return JSON.stringify(redactJsonForActor(actor, JSON.parse(s))); } catch { return null; } };
  return { ...e, beforeJson: red(e.beforeJson), afterJson: red(e.afterJson), contextJson: red(e.contextJson) };
}

/** Route-handler helper: turn AuthError into a JSON response, rethrow anything else. */
export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
  return null;
}

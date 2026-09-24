/**
 * Who is acting, and what may they do.
 *
 * `getActor()` resolves the current user from the request. Three modes:
 *  - no SSO configured — the `crosswalk_dev_user` cookie set by the sidebar's *Development
 *    sign-in* (seeded users; refused in a production build unless ALLOW_DEV_SIGNIN=true).
 *  - SSO_MODE=oidc (default when SSO_ISSUER + SSO_CLIENT_ID are set) — the built-in OIDC
 *    client in ./oidc.ts signs users in and issues the `crosswalk_session` cookie read here.
 *  - SSO_MODE=proxy — an authenticating reverse proxy in front of the app sets
 *    `x-sso-subject`; the subject is matched to User.externalId or email.
 *
 * Services call `requirePermission(actor, "…")`; API routes call `getActor()` first.
 * Authorization is always server-side.
 */
import { cookies, headers } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { permissionsFor, satisfiesAuthority, type Permission } from "./permissions";
import { readSession, ssoMode, SESSION_COOKIE } from "./oidc";

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

/** Header an authenticating reverse proxy sets (SSO_MODE=proxy): the signed-in subject. */
export const SSO_SUBJECT_HEADER = "x-sso-subject";
/** Header that same proxy must also set, carrying SSO_PROXY_SHARED_SECRET, to prove the subject came from it. */
export const SSO_PROXY_SECRET_HEADER = "x-sso-proxy-secret";

let warnedNoProxySecret = false;
/**
 * The subject asserted by the authenticating proxy, or null. The app cannot see the socket peer
 * (a load balancer sits in front), so the proxy proves itself with a shared secret header,
 * compared in constant time. With no SSO_PROXY_SHARED_SECRET configured the mode is fail-closed:
 * nobody is signed in, and the misconfiguration is logged once — a subject header alone is
 * something any HTTP client can send.
 */
export function proxySubjectFromHeaders(h: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const sub = h.get(SSO_SUBJECT_HEADER)?.trim();
  if (!sub) return null;
  const secret = env.SSO_PROXY_SHARED_SECRET ?? "";
  if (secret.length < 16) {
    if (!warnedNoProxySecret) { warnedNoProxySecret = true; console.error("[auth] SSO_MODE=proxy but SSO_PROXY_SHARED_SECRET is unset or shorter than 16 characters: refusing every subject header"); }
    return null;
  }
  const given = Buffer.from(h.get(SSO_PROXY_SECRET_HEADER) ?? ""), want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  if (sub.length > 320) return null;
  return sub;
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
let testActorSet = false;
/** Pass null to act as an anonymous caller (no cookies, no headers); `clearActorForTests` restores real resolution. */
export function setActorForTests(a: Actor | null) {
  if (!process.env.VITEST || process.env.NODE_ENV === "production") throw new Error("setActorForTests is only available under Vitest");
  testActor = a; testActorSet = true;
}
export function clearActorForTests() { testActor = null; testActorSet = false; }

/** Resolve the acting user for the current request (server components + route handlers). */
export async function getActor(): Promise<Actor | null> {
  if (testActorSet && process.env.VITEST && process.env.NODE_ENV !== "production") return testActor;
  const mode = ssoMode();
  if (mode === "oidc") {
    const c = await cookies();
    return loadActor(readSession(c.get(SESSION_COOKIE)?.value), false);
  }
  if (mode === "proxy") {
    // An authenticating reverse proxy terminates OIDC and asserts the subject per request.
    // The subject header is only believed when the hop that set it proves itself with the
    // shared secret (see proxySubjectFromHeaders): otherwise any client could name any user.
    const h = await headers();
    const sub = proxySubjectFromHeaders(h);
    if (!sub) return null;
    const u = await prisma.user.findFirst({ where: { OR: [{ externalId: sub }, { email: { equals: sub, mode: "insensitive" } }] } });
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
  if (hideCost) for (const k of COST_KEYS) if (k in out) out[k] = null;
  if (hideMargin) for (const k of MARGIN_KEYS) if (k in out) out[k] = null;
  // Nested JSON on a line (recommendation, waterfall) carries the same figures.
  for (const k of ["recommendationJson", "waterfallJson", "competitorIntelJson"]) {
    if (typeof out[k] === "string") { try { out[k] = JSON.stringify(redactJsonForActor(actor, JSON.parse(out[k] as string))); } catch { /* leave as is */ } }
  }
  return out as T;
}

// targetPrice = cost / (1 − target margin): with the policy margins it reconstructs the cost exactly (review REV-02).
const COST_KEYS = new Set(["cost", "costBasisJson", "floorPrice", "floor", "cogs", "standardCost", "unitCost", "targetPrice"]);
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

/**
 * Prose that quotes a margin or floor figure ("margin 41.2%", "below floor (80.00 < 95.00)",
 * "42% margin" in a matcher rationale) gives the cost away to anyone who knows the price. Strip
 * those clauses for actors without the permission; the rest of the sentence stays.
 */
export function redactSensitiveText(actor: Actor | null, text: string | null | undefined): string | null {
  if (text == null) return text ?? null;
  const hideCost = !can(actor, "view_cost"), hideMargin = !can(actor, "view_margin");
  if (!hideCost && !hideMargin) return text;
  let out = text;
  if (hideCost) out = out.replace(/below floor\s*\([^)]*\)/gi, "below floor").replace(/\$?[\d,]+(?:\.\d+)? (above|below) the [^.,;]*floor \$?[\d,]+(?:\.\d+)?/gi, "$1 the floor");
  if (hideMargin) out = out.replace(/\b(gross\s+)?margin\s*(?:of\s*)?-?[\d.,]+\s*%/gi, "$1margin").replace(/-?[\d.,]+\s*%\s*(gross\s+)?margin\b/gi, "$1margin").replace(/\bmargin\s+unknown\s*\([^)]*\)/gi, "margin unknown");
  return out.replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim();
}

/**
 * Strip cost and margin from a persisted match candidate for a role without the permission:
 * the COGS and the cost/margin fit scores, and the prose — `rationale` and the `notes` inside
 * `factorsJson` both carry "42% margin", which with the unit price IS the COGS (review REV-03).
 */
export function redactCandidateForActor<T extends { scoreCogs?: number | null; scoreMargin?: number | null; rationale?: string | null; factorsJson?: string | null; ownProduct?: { cogs?: unknown } | null }>(actor: Actor | null, c: T): T {
  const hideCost = !can(actor, "view_cost"), hideMargin = !can(actor, "view_margin");
  if (!hideCost && !hideMargin) return c;
  if (hideCost) { if (c.ownProduct && "cogs" in c.ownProduct) c.ownProduct.cogs = null; if ("scoreCogs" in c) c.scoreCogs = null; }
  if (hideMargin && "scoreMargin" in c) c.scoreMargin = null;
  if ("rationale" in c) c.rationale = redactSensitiveText(actor, c.rationale);
  if (c.factorsJson) {
    try {
      const f = JSON.parse(c.factorsJson) as Record<string, unknown>;
      if (Array.isArray(f.notes)) f.notes = (f.notes as unknown[]).map((n) => (typeof n === "string" ? redactSensitiveText(actor, n) : n)).filter((n) => n !== "" && n !== null);
      for (const k of Object.keys(f)) if ((hideCost && COST_KEYS.has(k)) || (hideMargin && MARGIN_KEYS.has(k))) f[k] = null;
      c.factorsJson = JSON.stringify(f);
    } catch { c.factorsJson = null; }
  }
  return c;
}

/** A JSON column (economicsJson, snapshotJson…) redacted for the actor; unparsable → null rather than leaked. */
export function redactJsonString(actor: Actor | null, s: string | null | undefined): string | null {
  if (s == null) return s ?? null;
  if (can(actor, "view_cost") && can(actor, "view_margin")) return s;
  try { return JSON.stringify(redactJsonForActor(actor, JSON.parse(s))); } catch { return null; }
}

/**
 * An approval request as a role without cost/margin permissions may see it: the snapshot JSON
 * (floorPrice, marginPct) is redacted like any JSON blob and the routing reason loses its figures.
 */
export function redactApprovalRequest<T extends { snapshotJson?: string | null; reason?: string | null }>(actor: Actor | null, r: T): T {
  if (can(actor, "view_cost") && can(actor, "view_margin")) return r;
  const out: Record<string, unknown> = { ...r };
  if (typeof r.snapshotJson === "string") { try { out.snapshotJson = JSON.stringify(redactJsonForActor(actor, JSON.parse(r.snapshotJson))); } catch { out.snapshotJson = null; } }
  if (typeof r.reason === "string") out.reason = redactSensitiveText(actor, r.reason);
  return out as T;
}

/** Route-handler helper: turn AuthError into a JSON response, rethrow anything else. */
export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
  return null;
}

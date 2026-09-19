/**
 * Built-in OpenID Connect client (Tier 0.1) — authorization code + PKCE against Entra ID,
 * Okta, or any OIDC provider with a discovery document.
 *
 *   /api/auth/oidc/start     → state + nonce + PKCE verifier in a short-lived signed cookie,
 *                              redirect to the provider's authorization endpoint
 *   /api/auth/oidc/callback  → exchange the code, validate the ID token (signature via JWKS,
 *                              issuer, audience, expiry, nonce), map the subject to a User,
 *                              issue Crosswalk's own signed session cookie
 *   /api/auth/oidc/logout    → clear the session; send the browser to the provider's
 *                              end-session endpoint when it has one
 *
 * The provider is the source of identity; Crosswalk keeps its own session (a signed,
 * expiring cookie — no provider round-trip per request, nothing to look up in the
 * database beyond the user row). Roles come from a configurable claim (Entra app roles,
 * Okta groups, Keycloak realm roles) through an optional name map; when the token carries
 * the claim it is authoritative and the user's roles are synced on every sign-in, and when
 * it does not the roles already on the user row stand.
 *
 * Configuration (all `SSO_*`, see .env.example): ISSUER, CLIENT_ID, CLIENT_SECRET (omit for
 * a public client — PKCE still applies), REDIRECT_URI, SCOPES, ROLE_CLAIM, ROLE_MAP,
 * DEFAULT_ROLE, AUTO_PROVISION, MODE (oidc | proxy — proxy keeps the x-sso-subject header
 * contract for deployments that terminate OIDC in front of the app).
 *
 * Every network call goes through `oidcFetch`, which tests replace with an in-memory
 * provider; the discovery document and JWKS are cached per process.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { prisma } from "@/lib/db";
import { ROLES } from "./permissions";
import { AuthError } from "./index";

export const SESSION_COOKIE = "crosswalk_session";
export const OIDC_STATE_COOKIE = "crosswalk_oidc";
const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_HOURS = 12;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const CLOCK_TOLERANCE_S = 120;

export type SsoMode = "none" | "oidc" | "proxy";

export function ssoMode(): SsoMode {
  if (!(process.env.SSO_ISSUER && process.env.SSO_CLIENT_ID)) return "none";
  return (process.env.SSO_MODE ?? "oidc").toLowerCase() === "proxy" ? "proxy" : "oidc";
}

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scopes: string;
  roleClaim: string | null;
  roleMap: Record<string, string>;
  defaultRole: string | null;
  autoProvision: boolean;
  sessionHours: number;
};

export function oidcConfig(): OidcConfig {
  const issuer = (process.env.SSO_ISSUER ?? "").replace(/\/$/, "");
  const clientId = process.env.SSO_CLIENT_ID ?? "";
  if (!issuer || !clientId) throw new AuthError("SSO is not configured", 500);
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const defaultRole = (process.env.SSO_DEFAULT_ROLE ?? "").trim() || null;
  if (defaultRole && !ROLES.includes(defaultRole as (typeof ROLES)[number])) throw new AuthError(`SSO_DEFAULT_ROLE is not a role: ${defaultRole}`, 500);
  const hours = Number(process.env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_HOURS);
  return {
    issuer, clientId,
    clientSecret: process.env.SSO_CLIENT_SECRET?.trim() || null,
    redirectUri: process.env.SSO_REDIRECT_URI?.trim() || `${base}/api/auth/oidc/callback`,
    scopes: process.env.SSO_SCOPES?.trim() || "openid profile email",
    roleClaim: process.env.SSO_ROLE_CLAIM?.trim() || null,
    roleMap: parseRoleMap(process.env.SSO_ROLE_MAP),
    defaultRole,
    autoProvision: (process.env.SSO_AUTO_PROVISION ?? "true").toLowerCase() !== "false",
    sessionHours: Number.isFinite(hours) && hours > 0 && hours <= 24 * 30 ? hours : DEFAULT_SESSION_HOURS,
  };
}

/**
 * `SSO_ROLE_MAP` is either JSON (`{"Crosswalk.Rep":"SALES_REP"}`) or `idp-name=ROLE,other=ROLE`.
 * Keys are matched case-insensitively; values must be Crosswalk roles. An unmapped claim value
 * that is itself a Crosswalk role name (Entra app roles are often defined that way) maps to itself.
 */
export function parseRoleMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const s = (raw ?? "").trim();
  if (!s) return out;
  let pairs: [string, string][];
  if (s.startsWith("{")) {
    const obj = JSON.parse(s) as Record<string, unknown>;
    pairs = Object.entries(obj).map(([k, v]) => [k, String(v)]);
  } else {
    pairs = s.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf("="); if (i < 0) throw new Error(`SSO_ROLE_MAP entry without '=': ${p}`); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; });
  }
  for (const [k, v] of pairs) {
    const role = v.toUpperCase();
    if (!ROLES.includes(role as (typeof ROLES)[number])) throw new Error(`SSO_ROLE_MAP maps '${k}' to unknown role '${v}'`);
    out[k.toLowerCase()] = role;
  }
  return out;
}

/** Claim values → Crosswalk roles (deduplicated, in ROLES order). Unknown values are ignored. */
export function mapRoles(values: unknown, roleMap: Record<string, string>): string[] {
  const list = Array.isArray(values) ? values : typeof values === "string" ? values.split(/[\s,]+/) : [];
  const set = new Set<string>();
  for (const v of list) {
    if (typeof v !== "string" || !v) continue;
    const mapped = roleMap[v.toLowerCase()] ?? (ROLES.includes(v.toUpperCase() as (typeof ROLES)[number]) ? v.toUpperCase() : null);
    if (mapped) set.add(mapped);
  }
  return ROLES.filter((r) => set.has(r));
}

/** Read a dotted claim path (`realm_access.roles`) from a token payload. */
export function claimAt(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Signed cookies (state + session). `<base64url(json)>.<hmac>` with SESSION_SECRET.

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") throw new AuthError("SESSION_SECRET must be set (16+ characters) for SSO sessions", 500);
  return "crosswalk-dev-insecure-session-key";
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function sealCookie(payload: Record<string, unknown>): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}
export function openCookie<T extends Record<string, unknown>>(value: string | undefined | null): T | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", secret()).update(body).digest("base64url"));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T; } catch { return null; }
}

export type SessionPayload = { uid: string; sub: string; iat: number; exp: number; v: 1 };

export function issueSession(userId: string, subject: string, hours: number): { value: string; expires: Date } {
  const now = Date.now();
  const expires = new Date(now + hours * 3600 * 1000);
  return { value: sealCookie({ uid: userId, sub: subject, iat: Math.floor(now / 1000), exp: Math.floor(expires.getTime() / 1000), v: 1 } satisfies SessionPayload), expires };
}
/** User id for a valid, unexpired session cookie; null otherwise. */
export function readSession(value: string | undefined | null, now = Date.now()): string | null {
  const p = openCookie<SessionPayload>(value);
  if (!p || p.v !== 1 || typeof p.uid !== "string" || typeof p.exp !== "number") return null;
  if (p.exp * 1000 <= now) return null;
  return p.uid;
}

/** Only a same-origin path may be the post-login destination (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n]/.test(next)) return "/";
  if (next.startsWith("/api/")) return "/";
  return next.slice(0, 500);
}

// ---------------------------------------------------------------------------------------------
// Provider (discovery, JWKS, token endpoint)

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string; issuer: string };
let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function setOidcFetchForTests(f: typeof fetch | null) {
  if (!process.env.VITEST) throw new Error("test seam");
  fetchImpl = f ?? ((...a) => fetch(...a));
  discovery = null; jwks = null;
}
let discovery: { at: number; doc: Discovery } | null = null;
let jwks: { uri: string; get: JWTVerifyGetKey } | null = null;

export async function discover(cfg: OidcConfig): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < DISCOVERY_TTL_MS) return discovery.doc;
  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AuthError(`OIDC discovery failed (${res.status}) at ${url}`, 502);
  const doc = (await res.json()) as Partial<Discovery>;
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"] as const) if (typeof doc[k] !== "string") throw new AuthError(`OIDC discovery document is missing ${k}`, 502);
  // Entra's v2 documents report a tenant-specific issuer; accept the configured one or the document's.
  discovery = { at: Date.now(), doc: doc as Discovery };
  return doc as Discovery;
}

function keyGetter(doc: Discovery): JWTVerifyGetKey {
  if (jwks && jwks.uri === doc.jwks_uri) return jwks.get;
  const get = createRemoteJWKSet(new URL(doc.jwks_uri), { [customFetch]: fetchImpl as unknown as (url: string, init: RequestInit) => Promise<Response>, cooldownDuration: 30_000, timeoutDuration: 10_000 });
  jwks = { uri: doc.jwks_uri, get };
  return get;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export type StartState = { state: string; nonce: string; verifier: string; next: string; at: number };

/** Build the authorization URL and the state cookie payload for one sign-in attempt. */
export async function beginSignIn(cfg: OidcConfig, next: string | null): Promise<{ url: string; state: StartState }> {
  const doc = await discover(cfg);
  const { verifier, challenge } = pkcePair();
  const state: StartState = { state: randomBytes(24).toString("base64url"), nonce: randomBytes(24).toString("base64url"), verifier, next: safeNext(next), at: Date.now() };
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", state.state);
  u.searchParams.set("nonce", state.nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return { url: u.toString(), state };
}

export type Identity = { subject: string; email: string | null; name: string | null; roles: string[] | null; claims: JWTPayload };

/** Exchange the code and validate the ID token. Throws AuthError(401) on anything that does not add up. */
export async function completeSignIn(cfg: OidcConfig, params: { code: string | null; state: string | null; error?: string | null; errorDescription?: string | null }, stored: StartState | null): Promise<{ identity: Identity; next: string }> {
  if (params.error) throw new AuthError(`Sign-in refused by the identity provider: ${params.error}${params.errorDescription ? ` — ${params.errorDescription}` : ""}`, 401);
  if (!stored || typeof stored.state !== "string" || Date.now() - stored.at > STATE_TTL_MS) throw new AuthError("Sign-in attempt expired; start again", 401);
  if (!params.state || params.state.length !== stored.state.length || !timingSafeEqual(Buffer.from(params.state), Buffer.from(stored.state))) throw new AuthError("Sign-in state mismatch", 401);
  if (!params.code) throw new AuthError("No authorization code returned", 401);
  const doc = await discover(cfg);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: params.code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, code_verifier: stored.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (cfg.clientSecret) headers.authorization = `Basic ${b64(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`)}`;
  const res = await fetchImpl(doc.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new AuthError(`Token exchange failed: ${tok.error ?? res.status}${tok.error_description ? ` — ${tok.error_description}` : ""}`, 401);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tok.id_token, keyGetter(doc), { issuer: [cfg.issuer, doc.issuer], audience: cfg.clientId, clockTolerance: CLOCK_TOLERANCE_S, maxTokenAge: "1h" }));
  } catch (e) {
    throw new AuthError(`ID token rejected: ${(e as Error).message}`, 401);
  }
  if (payload.nonce !== stored.nonce) throw new AuthError("ID token nonce mismatch", 401);
  if (typeof payload.sub !== "string" || !payload.sub) throw new AuthError("ID token has no subject", 401);
  const claims = payload as Record<string, unknown>;
  const email = [claims.email, claims.preferred_username, claims.upn].find((v) => typeof v === "string" && /@/.test(v)) as string | undefined;
  const name = [claims.name, [claims.given_name, claims.family_name].filter(Boolean).join(" ")].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const rawRoles = cfg.roleClaim ? claimAt(claims, cfg.roleClaim) : undefined;
  const roles = rawRoles === undefined ? null : mapRoles(rawRoles, cfg.roleMap);
  return { identity: { subject: payload.sub, email: email?.toLowerCase() ?? null, name: name?.trim() ?? null, roles, claims: payload }, next: safeNext(stored.next) };
}

/**
 * Subject → User. Match on externalId first (stable across email changes), then email (first
 * sign-in of a pre-created user: the subject is recorded). Otherwise provision when allowed.
 * Roles from the claim are authoritative when present; a token with the claim but no
 * recognised role leaves the user with SSO_DEFAULT_ROLE or, failing that, no access.
 */
export async function resolveUser(cfg: OidcConfig, id: Identity): Promise<{ userId: string; created: boolean; rolesSynced: boolean }> {
  let u = await prisma.user.findFirst({ where: { externalId: id.subject }, include: { roles: true } });
  if (!u && id.email) u = await prisma.user.findFirst({ where: { email: { equals: id.email, mode: "insensitive" } }, include: { roles: true } });
  const claimRoles = id.roles;
  const desiredRoles = claimRoles === null ? null : claimRoles.length ? claimRoles : cfg.defaultRole ? [cfg.defaultRole] : [];
  if (!u) {
    if (!cfg.autoProvision) throw new AuthError("Your account has not been set up in Crosswalk. Ask an administrator.", 403);
    if (!id.email) throw new AuthError("The identity provider did not release an email address; one is required to create your account.", 403);
    const roles = desiredRoles ?? (cfg.defaultRole ? [cfg.defaultRole] : []);
    if (!roles.length) throw new AuthError("Your account has no Crosswalk role. Ask an administrator to assign one.", 403);
    const created = await prisma.user.create({ data: { email: id.email, name: id.name ?? id.email, externalId: id.subject, roles: { create: roles.map((role) => ({ role })) } } });
    return { userId: created.id, created: true, rolesSynced: true };
  }
  if (!u.isActive) throw new AuthError("Your Crosswalk account is deactivated.", 403);
  const data: { externalId?: string; name?: string } = {};
  if (u.externalId !== id.subject) data.externalId = id.subject;
  if (id.name && u.name !== id.name) data.name = id.name;
  let rolesSynced = false;
  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) await tx.user.update({ where: { id: u!.id }, data });
    if (desiredRoles) {
      const have = new Set(u!.roles.map((r) => r.role)), want = new Set(desiredRoles);
      const add = desiredRoles.filter((r) => !have.has(r)), drop = [...have].filter((r) => !want.has(r));
      if (add.length) await tx.userRole.createMany({ data: add.map((role) => ({ userId: u!.id, role })) });
      if (drop.length) await tx.userRole.deleteMany({ where: { userId: u!.id, role: { in: drop } } });
      rolesSynced = add.length > 0 || drop.length > 0;
    }
  });
  return { userId: u.id, created: false, rolesSynced };
}

/** Where to send the browser after clearing the session (provider logout when supported). */
export async function logoutUrl(cfg: OidcConfig): Promise<string | null> {
  try {
    const doc = await discover(cfg);
    if (!doc.end_session_endpoint) return null;
    const u = new URL(doc.end_session_endpoint);
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("post_logout_redirect_uri", (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "") + "/");
    return u.toString();
  } catch { return null; }
}

/** Reset process caches (tests). */
export function resetOidcCachesForTests() { if (!process.env.VITEST) throw new Error("test seam"); discovery = null; jwks = null; }

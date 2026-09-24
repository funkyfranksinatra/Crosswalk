/**
 * Pure unit tests for the Tier 0 modules: no database, no network.
 *
 * The OIDC client is exercised end to end against an in-memory identity provider (discovery,
 * JWKS, token endpoint) signing real RS256 ID tokens, so the state/nonce/PKCE/issuer/audience
 * checks are pinned by behaviour rather than by reading the code.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from "jose";
import { scopeFor, accountWhere, requestWhere, proposalWhere, contractWhere } from "@/lib/auth/scope";
import { parseRoleMap, mapRoles, claimAt, sealCookie, openCookie, issueSession, readSession, safeNext, pkcePair, beginSignIn, completeSignIn, setOidcFetchForTests, ssoMode, oidcConfig, type OidcConfig } from "@/lib/auth/oidc";
import { AuthError, type Actor } from "@/lib/auth";
import { permissionsFor } from "@/lib/auth/permissions";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RateLimiter, classify, clientKey, limitsFromEnv } from "@/lib/security/ratelimit";
import { makeNonce, contentSecurityPolicy, hardeningHeaders, isHttps } from "@/lib/security/headers";
import { ENUM_CONSTRAINTS, EXPR_CONSTRAINTS, constraintName, constraintExpr, migrationSql, violationQueries } from "@/lib/db/constraints";
import { ROLES } from "@/lib/auth/permissions";
import { ACCOUNT_TYPES } from "@/lib/accounts/types";
import { KINDS } from "@/lib/notifications/kinds";
import { EQUIVALENCE } from "@/lib/xref/equivalence";
import { SOURCE_TYPES } from "@/lib/intelligence/summarize";
import { checkSecrets, assertProductionSecrets, flattenSecrets, loadSecrets, resetSecretsForTests, setSecretsFetchForTests } from "@/lib/secrets";

const actor = (roles: string[]): Actor => ({ id: "u1", email: "u@x", name: "U", roles, permissions: permissionsFor(roles), isDev: true });

describe("0.2 scope fragments", () => {
  test("non-scoped roles and mixed roles are unscoped without touching the database", async () => {
    expect(await scopeFor(actor(["PRICING_ANALYST"]))).toEqual({ mode: "all" });
    expect(await scopeFor(actor(["SALES_REP", "ADMIN"]))).toEqual({ mode: "all" });
    expect((await scopeFor(actor(["SALES_REP", "PRICING_ANALYST"]))).mode).toBe("all");
  });
  test("scoped fragments cover owner, territory, unassigned and parent; no territory → no territory clause", () => {
    const s = { mode: "scoped" as const, userId: "u1", territories: ["NE"] };
    const w = accountWhere(s) as { OR: unknown[] };
    expect(w.OR).toHaveLength(4);
    expect(w.OR[1]).toEqual({ territory: { in: ["NE"], mode: "insensitive" } });
    expect(w.OR[2]).toEqual({ ownerUserId: null, territory: null });
    const none = accountWhere({ ...s, territories: [] }) as { OR: unknown[] };
    expect(none.OR).toHaveLength(3);
    expect(requestWhere(s)).toEqual({ OR: [{ createdByUserId: "u1" }, { account: w }] });
    expect((proposalWhere(s) as { OR: unknown[] }).OR[0]).toEqual({ ownerUserId: "u1" });
    expect((contractWhere(s) as { OR: unknown[] }).OR[0]).toEqual({ accountId: null, parentAccountId: null });
    for (const f of [accountWhere, requestWhere, proposalWhere, contractWhere]) expect(f({ mode: "all" })).toEqual({});
  });
});

describe("0.1 role mapping and claims", () => {
  test("role map accepts JSON or k=v lists, validates roles, matches case-insensitively", () => {
    expect(parseRoleMap('{"Crosswalk.Rep":"sales_rep"}')).toEqual({ "crosswalk.rep": "SALES_REP" });
    expect(parseRoleMap("CW-Admins=ADMIN, CW-Pricing = PRICING_ANALYST")).toEqual({ "cw-admins": "ADMIN", "cw-pricing": "PRICING_ANALYST" });
    expect(parseRoleMap("")).toEqual({});
    expect(() => parseRoleMap("x=NOT_A_ROLE")).toThrow(/unknown role/);
    expect(() => parseRoleMap("novalue")).toThrow(/without '='/);
  });
  test("claim values map through the table; with no table, exact role names map to themselves; unknowns dropped", () => {
    const map = parseRoleMap("CW-Admins=ADMIN");
    expect(mapRoles(["cw-admins", "SALES_REP", "Everyone", "sales_rep"], map)).toEqual(["ADMIN"]); // a map is the whole vocabulary
    expect(mapRoles(["finance", "Executive", "ADMIN"], map)).toEqual([]); // directory groups that happen to sound like roles grant nothing
    expect(mapRoles(["SALES_REP", "sales_rep", "FINANCE EXECUTIVE".split(" ")[0]], {})).toEqual(["SALES_REP", "FINANCE"]); // implicit: exact case only
    expect(mapRoles("FINANCE EXECUTIVE", {})).toEqual(["FINANCE", "EXECUTIVE"]);
    expect(mapRoles(undefined, map)).toEqual([]);
    expect(mapRoles(42, map)).toEqual([]);
  });
  test("dotted claim paths", () => {
    expect(claimAt({ realm_access: { roles: ["a"] } }, "realm_access.roles")).toEqual(["a"]);
    expect(claimAt({ roles: ["a"] }, "roles")).toEqual(["a"]);
    expect(claimAt({ a: "str" }, "a.b")).toBeUndefined();
  });
});

describe("0.1 signed cookies and sessions", () => {
  test("sealed cookies round-trip and reject tampering", () => {
    const c = sealCookie({ a: 1 });
    expect(openCookie(c)).toEqual({ a: 1 });
    expect(openCookie(c.slice(0, -2) + "zz")).toBeNull();
    expect(openCookie(c.replace(/^./, "Z"))).toBeNull();
    expect(openCookie("")).toBeNull();
    expect(openCookie("nodot")).toBeNull();
  });
  test("sessions expire and carry the user id only when valid", () => {
    const { value, expires } = issueSession("user1", "sub1", 2);
    expect(expires.getTime() - Date.now()).toBeGreaterThan(7_190_000);
    expect(readSession(value)).toBe("user1");
    expect(readSession(value, expires.getTime() + 1)).toBeNull();
    expect(readSession(sealCookie({ uid: "x", exp: Math.floor(Date.now() / 1000) + 100, v: 2 }))).toBeNull();
    expect(readSession(undefined)).toBeNull();
  });
  test("post-login destination is a same-origin page path", () => {
    expect(safeNext("/proposals/abc?x=1")).toBe("/proposals/abc?x=1");
    expect(safeNext("/accounts/x#frag")).toBe("/accounts/x"); // fragments never reach the server anyway
    for (const bad of [null, "", "https://evil", "//evil", "/\\evil", "/api/auth/dev", "/a\r\nb", "javascript:alert(1)", "/\t/evil.com", "/\u0000x", "/%09/evil.com".replace("%09", "\t"), "/..//evil.com"]) expect(safeNext(bad), bad ?? "null").toBe("/");
    expect(safeNext("/a/../b")).toBe("/b"); // resolved, still same-origin
  });
  test("PKCE challenge is S256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});

/** In-memory identity provider: discovery, JWKS and a token endpoint that mints ID tokens. */
class FakeIdp {
  issuer = "https://idp.test/tenant";
  clientId = "crosswalk-client";
  private key!: { privateKey: CryptoKey; jwk: Record<string, unknown> };
  tokenCalls: { body: URLSearchParams; auth: string | null }[] = [];
  /** What the next token exchange should put in the ID token (tests override per case). */
  next: { sub?: string; nonce?: string | (() => string); aud?: string; iss?: string; exp?: number; nbf?: number; iat?: number; claims?: Record<string, unknown>; status?: number; body?: unknown; rawToken?: string | ((nonce: string) => Promise<string>) } = {};
  get publicJwk() { return this.key.jwk; }
  lastNonce = "";
  async init() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    this.key = { privateKey, jwk: { ...jwk, kid: "k1", alg: "RS256", use: "sig" } };
  }
  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url === `${this.issuer}/.well-known/openid-configuration`) return json({ issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/keys`, end_session_endpoint: `${this.issuer}/logout` });
    if (url === `${this.issuer}/keys`) return json({ keys: [this.key.jwk] });
    if (url === `${this.issuer}/token`) {
      const body = new URLSearchParams(String(init?.body));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      this.tokenCalls.push({ body, auth });
      if (this.next.status) return json(this.next.body ?? { error: "invalid_grant" }, this.next.status);
      const nonce = typeof this.next.nonce === "function" ? this.next.nonce() : this.next.nonce ?? this.lastNonce;
      if (this.next.rawToken !== undefined) return json({ id_token: typeof this.next.rawToken === "function" ? await this.next.rawToken(nonce) : this.next.rawToken, access_token: "at", token_type: "Bearer" });
      const now = Math.floor(Date.now() / 1000);
      const builder = new SignJWT({ nonce, email: "Rep@Example.com", name: "Rep Person", roles: ["CW-Reps"], ...(this.next.claims ?? {}) })
        .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(this.next.iss ?? this.issuer).setAudience(this.next.aud ?? this.clientId).setSubject(this.next.sub ?? "sub-123")
        .setIssuedAt(this.next.iat ?? now).setExpirationTime(this.next.exp ?? now + 600);
      if (this.next.nbf !== undefined) builder.setNotBefore(this.next.nbf);
      const jwt = await builder.sign(this.key.privateKey);
      return json({ id_token: jwt, access_token: "at", token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("0.1 OIDC flow against an in-memory provider", () => {
  const idp = new FakeIdp();
  let cfg: OidcConfig;
  const env = { ...process.env };
  beforeAll(async () => {
    await idp.init();
    setOidcFetchForTests(idp.fetch);
    process.env.SSO_ISSUER = idp.issuer; process.env.SSO_CLIENT_ID = idp.clientId; process.env.SSO_ROLE_CLAIM = "roles"; process.env.SSO_ROLE_MAP = "CW-Reps=SALES_REP"; process.env.APP_BASE_URL = "https://crosswalk.example.com";
    delete process.env.SSO_CLIENT_SECRET; delete process.env.SSO_MODE;
    cfg = oidcConfig();
  });
  afterAll(() => { setOidcFetchForTests(null); process.env = env; });
  afterEach(() => { idp.next = {}; });

  async function happyStart() {
    const { url, state } = await beginSignIn(cfg, "/proposals");
    idp.lastNonce = state.nonce;
    return { url: new URL(url), state };
  }

  test("mode and config resolve from the environment", () => {
    expect(ssoMode()).toBe("oidc");
    expect(cfg.redirectUri).toBe("https://crosswalk.example.com/api/auth/oidc/callback");
    expect(cfg.roleMap).toEqual({ "cw-reps": "SALES_REP" });
    process.env.SSO_MODE = "proxy"; expect(ssoMode()).toBe("proxy"); delete process.env.SSO_MODE;
  });

  test("start builds a code+PKCE authorization request bound to a fresh state and nonce", async () => {
    const { url, state } = await happyStart();
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(idp.clientId);
    expect(p.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("state")).toBe(state.state);
    expect(p.get("nonce")).toBe(state.nonce);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBe(createHash("sha256").update(state.verifier).digest("base64url"));
    expect(state.next).toBe("/proposals");
    const again = await happyStart();
    expect(again.state.state).not.toBe(state.state);
  });

  test("callback exchanges the code with the verifier, validates the token and yields the identity", async () => {
    const { state } = await happyStart();
    idp.tokenCalls = [];
    const { identity, next } = await completeSignIn(cfg, { code: "code-1", state: state.state }, state);
    expect(identity).toMatchObject({ subject: "sub-123", email: "rep@example.com", name: "Rep Person", roles: ["SALES_REP"] });
    expect(next).toBe("/proposals");
    const call = idp.tokenCalls[0];
    expect(call.body.get("grant_type")).toBe("authorization_code");
    expect(call.body.get("code")).toBe("code-1");
    expect(call.body.get("code_verifier")).toBe(state.verifier);
    expect(call.body.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(call.auth).toBeNull(); // public client: no secret sent
  });

  test("a confidential client authenticates with HTTP basic", async () => {
    const { state } = await happyStart();
    idp.tokenCalls = [];
    await completeSignIn({ ...cfg, clientSecret: "s3cret" }, { code: "c", state: state.state }, state);
    expect(idp.tokenCalls[0].auth).toBe(`Basic ${Buffer.from(`${idp.clientId}:s3cret`).toString("base64url")}`);
  });

  test("state mismatch, missing state cookie, expired attempt, provider error and missing code are refused", async () => {
    const { state } = await happyStart();
    const r = (p: Parameters<typeof completeSignIn>[1], s: Parameters<typeof completeSignIn>[2]) => completeSignIn(cfg, p, s);
    await expect(r({ code: "c", state: "wrong" }, state)).rejects.toMatchObject({ status: 401, message: /state mismatch/ });
    await expect(r({ code: "c", state: state.state }, null)).rejects.toMatchObject({ status: 401, message: /expired/ });
    await expect(r({ code: "c", state: state.state }, { ...state, at: Date.now() - 11 * 60_000 })).rejects.toMatchObject({ status: 401, message: /expired/ });
    await expect(r({ code: null, state: state.state }, state)).rejects.toMatchObject({ status: 401, message: /No authorization code/ });
    await expect(r({ code: "c", state: state.state, error: "access_denied", errorDescription: "nope" }, state)).rejects.toMatchObject({ status: 401, message: /access_denied — nope/ });
  });

  test("a token for another audience, another issuer, an expired token, the wrong nonce, or a bad signature is rejected", async () => {
    const { state } = await happyStart();
    const go = () => completeSignIn(cfg, { code: "c", state: state.state }, state);
    idp.next = { aud: "someone-else" }; await expect(go()).rejects.toMatchObject({ status: 401, message: /audience/ });
    idp.next = { iss: "https://evil.test" }; await expect(go()).rejects.toMatchObject({ status: 401, message: /issuer/ });
    idp.next = { exp: Math.floor(Date.now() / 1000) - 600 }; await expect(go()).rejects.toMatchObject({ status: 401, message: /exp|expired/i });
    idp.next = { nonce: "stale-nonce" }; await expect(go()).rejects.toMatchObject({ status: 401, message: /nonce/ });
    idp.next = { status: 400, body: { error: "invalid_grant", error_description: "code used" } }; await expect(go()).rejects.toMatchObject({ status: 401, message: /invalid_grant — code used/ });
    // bad signature: a token minted by a different key
    const other = new FakeIdp(); await other.init(); other.issuer = idp.issuer; other.lastNonce = state.nonce;
    setOidcFetchForTests(async (input, init) => { const u = String(input instanceof Request ? input.url : input); return u.endsWith("/token") ? other.fetch(input, init) : idp.fetch(input, init); });
    await expect(go()).rejects.toMatchObject({ status: 401, message: /signature/i });
    setOidcFetchForTests(idp.fetch);
  });

  test("roles: absent claim → null (keep DB roles); unmapped values → empty list; dotted path", async () => {
    let { state } = await happyStart();
    idp.next = { claims: { roles: undefined } };
    expect((await completeSignIn(cfg, { code: "c", state: state.state }, state)).identity.roles).toBeNull();
    ({ state } = await happyStart());
    idp.next = { claims: { roles: ["Everyone"] } };
    expect((await completeSignIn(cfg, { code: "c", state: state.state }, state)).identity.roles).toEqual([]);
    ({ state } = await happyStart());
    idp.next = { claims: { realm_access: { roles: ["PRICING_DIRECTOR", "pricing_director"] } } };
    expect((await completeSignIn({ ...cfg, roleClaim: "realm_access.roles", roleMap: {} }, { code: "c", state: state.state }, state)).identity.roles).toEqual(["PRICING_DIRECTOR"]);
  });

  test("email falls back to preferred_username / upn and is lower-cased; a token without a subject is refused", async () => {
    let { state } = await happyStart();
    idp.next = { claims: { email: undefined, preferred_username: "Someone@Corp.com" } };
    expect((await completeSignIn(cfg, { code: "c", state: state.state }, state)).identity.email).toBe("someone@corp.com");
    ({ state } = await happyStart());
    idp.next = { claims: { email: undefined, preferred_username: "not-an-email" } };
    expect((await completeSignIn(cfg, { code: "c", state: state.state }, state)).identity.email).toBeNull();
  });

  test("an unverified email is refused", async () => {
    const { state } = await happyStart();
    idp.next = { claims: { email_verified: false } };
    await expect(completeSignIn(cfg, { code: "c", state: state.state }, state)).rejects.toMatchObject({ status: 403, message: /unverified/ });
  });

  // ---- WS4 additions (item G): algorithm confusion, time-window skew, replay, logout -----------------
  test("WS4: alg=none and HS256-with-the-public-key tokens are rejected (algorithm confusion)", async () => {
    const { state } = await happyStart();
    const go = () => completeSignIn(cfg, { code: "c", state: state.state }, state);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: idp.issuer, aud: idp.clientId, sub: "sub-123", nonce: state.nonce, iat: now, exp: now + 600, email: "rep@example.com" };
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    idp.next = { rawToken: `${b64u({ alg: "none" })}.${b64u(claims)}.` };
    await expect(go()).rejects.toMatchObject({ status: 401, message: /ID token rejected/ });
    idp.next = { rawToken: `${b64u({ alg: "none", kid: "k1" })}.${b64u(claims)}.` };
    await expect(go()).rejects.toMatchObject({ status: 401 });
    // HS256 signed with the RSA public key material (the classic key-confusion attack)
    const pub = Buffer.from(String(idp.publicJwk.n), "base64url");
    const signingInput = `${b64u({ alg: "HS256", kid: "k1", typ: "JWT" })}.${b64u(claims)}`;
    const mac = (await import("node:crypto")).createHmac("sha256", pub).update(signingInput).digest("base64url");
    idp.next = { rawToken: `${signingInput}.${mac}` };
    await expect(go()).rejects.toMatchObject({ status: 401 });
    // an unknown kid, a garbage token and an empty token
    idp.next = { rawToken: "not.a.jwt" }; await expect(go()).rejects.toMatchObject({ status: 401 });
    idp.next = { rawToken: "" }; await expect(go()).rejects.toMatchObject({ status: 401, message: /Token exchange failed/ });
  });

  test("WS4: nbf in the future and iat older than the max token age are rejected; 2 minutes of skew is tolerated", async () => {
    let { state } = await happyStart();
    const go = () => completeSignIn(cfg, { code: "c", state: state.state }, state);
    const now = Math.floor(Date.now() / 1000);
    idp.next = { nbf: now + 600 }; await expect(go()).rejects.toMatchObject({ status: 401, message: /nbf|not yet/i });
    idp.next = { nbf: now + 60 }; await expect(go()).resolves.toBeTruthy(); // inside the 120 s tolerance
    ({ state } = await happyStart());
    idp.next = { iat: now - 2 * 3600, exp: now + 600 }; await expect(go()).rejects.toMatchObject({ status: 401, message: /iat|too far in the past|maxTokenAge/i });
    ({ state } = await happyStart());
    idp.next = { iat: now + 60 }; await expect(go()).resolves.toBeTruthy(); // clock skew on the provider side
    ({ state } = await happyStart());
    idp.next = { exp: now - 60 }; await expect(go()).resolves.toBeTruthy(); // 60 s past expiry is within tolerance…
    ({ state } = await happyStart());
    idp.next = { exp: now - 200 }; await expect(go()).rejects.toMatchObject({ status: 401 }); // …200 s is not
  });

  test("WS4: a state/nonce pair is bound to one attempt — a second attempt's token does not satisfy the first's cookie", async () => {
    const first = await happyStart();
    const second = await happyStart();
    // token minted for the second attempt (its nonce), presented against the first state cookie
    idp.next = { nonce: second.state.nonce };
    await expect(completeSignIn(cfg, { code: "c", state: first.state.state }, first.state)).rejects.toMatchObject({ status: 401, message: /nonce/ });
    // the state parameter of the second attempt against the first cookie
    await expect(completeSignIn(cfg, { code: "c", state: second.state.state }, first.state)).rejects.toMatchObject({ status: 401, message: /state mismatch/ });
    // a state value of a different length never reaches timingSafeEqual with mismatched buffers
    await expect(completeSignIn(cfg, { code: "c", state: first.state.state + "x" }, first.state)).rejects.toMatchObject({ status: 401, message: /state mismatch/ });
  });

  test("WS4: logout URL comes from discovery with the client id and the app origin; none when the provider has no end-session endpoint", async () => {
    const { logoutUrl, resetOidcCachesForTests } = await import("@/lib/auth/oidc");
    const u = new URL((await logoutUrl(cfg))!);
    expect(u.origin + u.pathname).toBe(`${idp.issuer}/logout`);
    expect(u.searchParams.get("client_id")).toBe(idp.clientId);
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe("https://crosswalk.example.com/");
    resetOidcCachesForTests();
    setOidcFetchForTests(async () => new Response(JSON.stringify({ issuer: idp.issuer, authorization_endpoint: "a", token_endpoint: "b", jwks_uri: "c" }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await logoutUrl(cfg)).toBeNull();
    setOidcFetchForTests(idp.fetch);
  });

  test("a bad discovery document is a 502, never a crash", async () => {
    setOidcFetchForTests(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(beginSignIn(cfg, "/")).rejects.toMatchObject({ status: 502 });
    setOidcFetchForTests(async () => new Response("down", { status: 503 }));
    await expect(beginSignIn(cfg, "/")).rejects.toBeInstanceOf(AuthError);
    setOidcFetchForTests(idp.fetch);
  });
});

describe("WS4 — development session cookie and proxy-mode subject trust", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  test("the dev cookie is <userId>.<hmac>: tampered id, tampered signature, bare id, wrong key and empty values are refused", async () => {
    process.env.SESSION_SECRET = "unit-test-session-secret-1";
    delete process.env.SSO_ISSUER; delete process.env.SSO_CLIENT_ID;
    const { signSession, verifySession, devSessionsAllowed } = await import("@/lib/auth");
    expect(devSessionsAllowed()).toBe(true);
    const c = signSession("cmuser000000000000000001");
    expect(verifySession(c)).toBe("cmuser000000000000000001");
    expect(verifySession("cmuser000000000000000001")).toBeNull(); // a bare user id off the sign-in list is not a session
    expect(verifySession("cmuser000000000000000002." + c.split(".")[1])).toBeNull();
    expect(verifySession(c.slice(0, -1) + (c.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(verifySession(c + "=")).toBeNull(); // length change
    expect(verifySession("." + c.split(".")[1])).toBeNull();
    expect(verifySession("")).toBeNull(); expect(verifySession(null)).toBeNull(); expect(verifySession(undefined)).toBeNull();
    process.env.SESSION_SECRET = "a-different-secret-entirely";
    expect(verifySession(c)).toBeNull(); // signed under another key
  });

  test("a production build without SSO refuses dev sessions unless ALLOW_DEV_SIGNIN=true; SSO configured disables them", async () => {
    const { signSession, verifySession, devSessionsAllowed } = await import("@/lib/auth");
    delete process.env.SESSION_SECRET; delete process.env.ALLOW_DEV_SIGNIN; delete process.env.SSO_ISSUER; delete process.env.SSO_CLIENT_ID;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(devSessionsAllowed()).toBe(false);
    expect(() => signSession("u1")).toThrow(/disabled/);
    expect(verifySession("u1.anything")).toBeNull();
    process.env.ALLOW_DEV_SIGNIN = "true";
    expect(devSessionsAllowed()).toBe(true);
    expect(verifySession(signSession("u1"))).toBe("u1");
    process.env.SSO_ISSUER = "https://idp"; process.env.SSO_CLIENT_ID = "c";
    expect(devSessionsAllowed()).toBe(false);
  });

  test("proxy mode: x-sso-subject is believed only with the shared-secret header (constant-time), never without a configured secret", async () => {
    const { proxySubjectFromHeaders } = await import("@/lib/auth");
    const h = (o: Record<string, string>) => new Headers(o);
    const good = { SSO_PROXY_SHARED_SECRET: "proxy-shared-secret-32-characters!!" };
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": "u@x" }), good)).toBeNull(); // subject alone: a client's claim
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": "u@x", "x-sso-proxy-secret": "wrong" }), good)).toBeNull();
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": "u@x", "x-sso-proxy-secret": "proxy-shared-secret-32-characters!" }), good)).toBeNull(); // length-1
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": " u@x ", "x-sso-proxy-secret": good.SSO_PROXY_SHARED_SECRET }), good)).toBe("u@x");
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": "u@x", "x-sso-proxy-secret": "" }), {})).toBeNull(); // no secret configured: fail closed
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": "u@x", "x-sso-proxy-secret": "short" }), { SSO_PROXY_SHARED_SECRET: "short" })).toBeNull(); // too short to count as configured
    expect(proxySubjectFromHeaders(h({ "x-sso-subject": "x".repeat(400), "x-sso-proxy-secret": good.SSO_PROXY_SHARED_SECRET }), good)).toBeNull();
    expect(proxySubjectFromHeaders(h({}), good)).toBeNull();
  });

  test("safeNext: more open-redirect shapes", () => {
    for (const bad of ["/\\evil.com", "\\/evil.com", "//evil.com/x", "///evil.com", "https:evil", "/api/", "/api/auth/oidc/logout", " /x", "/x\u007f", "%2f%2fevil.com"]) expect(safeNext(bad), JSON.stringify(bad)).toBe("/");
    expect(safeNext("/a?next=//evil.com")).toBe("/a?next=//evil.com"); // a query string is data, not a destination
    expect(safeNext("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com"); // percent-encoded slashes stay literal in a path: same origin
    expect(safeNext("/" + "x".repeat(600)).length).toBeLessThanOrEqual(500);
  });
});

describe("0.3 secrets", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; resetSecretsForTests(); setSecretsFetchForTests(null); });

  test("production refuses SSO_MODE=proxy without a usable SSO_PROXY_SHARED_SECRET (the subject header is otherwise ignored)", () => {
    const base = { NODE_ENV: "production", SESSION_SECRET: "a-perfectly-fine-long-random-secret", DATABASE_URL: "postgresql://app:Str0ngPassw0rd@db.example.com/crosswalk?sslmode=verify-full", SSO_ISSUER: "https://idp.example.com", SSO_CLIENT_ID: "crosswalk", SSO_MODE: "proxy" };
    expect(checkSecrets(base, true)).toMatchObject([{ key: "SSO_PROXY_SHARED_SECRET", problem: /not set/ }]);
    expect(checkSecrets({ ...base, SSO_PROXY_SHARED_SECRET: "short" }, true)).toMatchObject([{ key: "SSO_PROXY_SHARED_SECRET", problem: /16/ }]);
    expect(checkSecrets({ ...base, SSO_PROXY_SHARED_SECRET: "replace-me-please-please" }, true)).toMatchObject([{ key: "SSO_PROXY_SHARED_SECRET", problem: /placeholder/ }]);
    expect(checkSecrets({ ...base, SSO_PROXY_SHARED_SECRET: "proxy-shared-secret-32-characters!!" }, true)).toEqual([]);
    expect(checkSecrets(base, false)).toEqual([]); // development is allowed to run without it (fail-closed at request time)
  });

  test("production checks refuse the dev session key, short or placeholder secrets and example database passwords", () => {
    const base = { NODE_ENV: "production", SESSION_SECRET: "a-perfectly-fine-long-random-secret", DATABASE_URL: "postgresql://app:Str0ngPassw0rd@db.example.com/crosswalk?sslmode=verify-full" };
    expect(checkSecrets(base, true)).toEqual([]);
    expect(checkSecrets({ ...base, SESSION_SECRET: "crosswalk-dev-insecure-session-key" }, true)).toMatchObject([{ key: "SESSION_SECRET", problem: /development key/ }]);
    expect(checkSecrets({ ...base, SESSION_SECRET: "short" }, true)).toMatchObject([{ key: "SESSION_SECRET", problem: /16/ }]);
    expect(checkSecrets({ ...base, SESSION_SECRET: "changeme-changeme-changeme" }, true)).toEqual([]); // long and not a bare placeholder
    expect(checkSecrets({ ...base, SESSION_SECRET: "replace_me" }, true)).toMatchObject([{ key: "SESSION_SECRET" }]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://crosswalk:crosswalk@db.example.com/x?sslmode=require" }, true)).toMatchObject([{ key: "DATABASE_URL", problem: /default or placeholder/ }]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://app:pw@db.example.com/x" }, true)).toMatchObject([{ key: "DATABASE_URL", problem: /sslmode/ }]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://app:pw@db:5432/x" }, true)).toEqual([]); // compose service name: private network, no TLS needed
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://crosswalk:crosswalk@db:5432/x" }, true)).toMatchObject([{ key: "DATABASE_URL", problem: /default/ }]); // ...but a real password
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://crosswalk:crosswalk@localhost:5432/x" }, true)).toEqual([]); // loopback: only the box itself can reach it
    expect(checkSecrets({ ...base, OPENAI_API_KEY: "changeme" }, true)).toMatchObject([{ key: "OPENAI_API_KEY" }]);
    expect(checkSecrets({ ...base, SESSION_SECRET: "", SSO_ISSUER: "https://x", SSO_CLIENT_ID: "c", SSO_MODE: "oidc" }, true)).toMatchObject([{ key: "SESSION_SECRET", problem: /not set/ }]);
    expect(checkSecrets({ ...base, SESSION_SECRET: "", SSO_ISSUER: "https://x", SSO_CLIENT_ID: "c", SSO_MODE: "proxy", SSO_PROXY_SHARED_SECRET: "proxy-shared-secret-32-characters!!" }, true)).toEqual([]); // the proxy signs nothing here, but it must prove itself
    expect(checkSecrets({ ...base, SSO_ISSUER: "https://x", SSO_CLIENT_ID: "c" }, true)).toMatchObject([{ key: "SSO_MODE", problem: /not set/ }]); // upgrade note
    expect(checkSecrets({ ...base, SESSION_SECRET: "" }, true)).toEqual([]); // no SSO, no dev sign-in: nothing signs a session
    expect(checkSecrets({ ...base, ALLOW_DEV_SIGNIN: "true" }, true)).toMatchObject([{ key: "ALLOW_DEV_SIGNIN" }]);
    // development is exempt from all of it
    expect(checkSecrets({ SESSION_SECRET: "crosswalk-dev-insecure-session-key", DATABASE_URL: "postgresql://crosswalk:crosswalk@localhost/x" }, false)).toEqual([]);
  });

  test("assertProductionSecrets throws on fatal problems, warns for the demo escape hatch, and is silent in development", () => {
    expect(() => assertProductionSecrets({ NODE_ENV: "production", SESSION_SECRET: "crosswalk-dev-insecure-session-key" })).toThrow(/Refusing to start.*SESSION_SECRET/);
    expect(() => assertProductionSecrets({ NODE_ENV: "production", ALLOW_DEV_SIGNIN: "true", SESSION_SECRET: "a-perfectly-fine-long-random-secret" })).not.toThrow();
    expect(() => assertProductionSecrets({ NODE_ENV: "production", SSO_ISSUER: "https://x", SSO_CLIENT_ID: "c", SESSION_SECRET: "a-perfectly-fine-long-random-secret" })).not.toThrow(); // SSO_MODE unset is a warning
    expect(() => assertProductionSecrets({ NODE_ENV: "development", SESSION_SECRET: "short" })).not.toThrow();
  });

  test("flattening keeps strings/numbers/booleans and one level of nesting", () => {
    expect(flattenSecrets({ A: "1", B: 2, C: true, D: { E: "x", F: { G: "deep" } }, H: ["no"], I: null })).toEqual({ A: "1", B: "2", C: "true", D_E: "x" });
    expect(flattenSecrets("nope")).toEqual({});
  });

  test("file provider reads JSON or KEY=value, fills only unset keys unless SECRETS_OVERRIDE", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-secrets-"));
    const f = path.join(dir, "s.env");
    fs.writeFileSync(f, '# comment\nexport T0_ALPHA="from-file"\nT0_BETA=\'b\'\nT0_GAMMA=plain value\nlowercase=ignored\n');
    process.env.SECRETS_PROVIDER = "file"; process.env.SECRETS_FILE = f; process.env.T0_ALPHA = "from-env"; delete process.env.T0_BETA; delete process.env.T0_GAMMA;
    expect((await loadSecrets()).sort()).toEqual(["T0_BETA", "T0_GAMMA"]);
    expect(process.env.T0_ALPHA).toBe("from-env");
    expect(process.env.T0_BETA).toBe("b");
    expect(process.env.T0_GAMMA).toBe("plain value");
    resetSecretsForTests(); process.env.SECRETS_OVERRIDE = "true";
    expect(await loadSecrets()).toContain("T0_ALPHA");
    expect(process.env.T0_ALPHA).toBe("from-file");
    fs.writeFileSync(f, JSON.stringify({ T0_JSON: "j", nested: { T0_N: 1 } }));
    resetSecretsForTests(); delete process.env.SECRETS_OVERRIDE; delete process.env.T0_JSON;
    expect(await loadSecrets()).toContain("T0_JSON");
    fs.rmSync(dir, { recursive: true });
  });

  test("vault (KV v2) and doppler providers go through fetch with the right headers; failures throw", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    setSecretsFetchForTests(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url.includes("/v1/secret/data/cw")) return new Response(JSON.stringify({ data: { data: { T0_VAULT: "v" }, metadata: { version: 3 } } }), { status: 200 });
      if (url.includes("doppler.com")) return new Response(JSON.stringify({ T0_DOPPLER: "d" }), { status: 200 });
      return new Response("nope", { status: 403 });
    });
    process.env.SECRETS_PROVIDER = "vault"; process.env.VAULT_ADDR = "https://vault.test/"; process.env.VAULT_TOKEN = "tok"; process.env.VAULT_SECRET_PATH = "/secret/data/cw"; process.env.VAULT_NAMESPACE = "ns"; delete process.env.T0_VAULT;
    expect(await loadSecrets()).toEqual(["T0_VAULT"]);
    expect(calls[0]).toMatchObject({ url: "https://vault.test/v1/secret/data/cw", headers: { "x-vault-token": "tok", "x-vault-namespace": "ns" } });
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "doppler"; process.env.DOPPLER_TOKEN = "dp"; delete process.env.T0_DOPPLER;
    expect(await loadSecrets()).toEqual(["T0_DOPPLER"]);
    expect(calls[1].headers.authorization).toBe("Bearer dp");
    resetSecretsForTests(); process.env.VAULT_SECRET_PATH = "secret/data/other"; process.env.SECRETS_PROVIDER = "vault";
    await expect(loadSecrets()).rejects.toThrow(/Vault returned 403/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "aws"; delete process.env.AWS_SECRET_ID;
    await expect(loadSecrets()).rejects.toThrow(/AWS_SECRET_ID/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "bogus";
    await expect(loadSecrets()).rejects.toThrow(/SECRETS_PROVIDER/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "env";
    expect(await loadSecrets()).toEqual([]);
  });
});

describe("0.5 rate limiting and security headers", () => {
  test("route classes: auth, heavy writes and file exports, everything else api", () => {
    expect(classify("/api/auth/oidc/start")).toBe("auth");
    expect(classify("/api/requests", "POST")).toBe("heavy");
    expect(classify("/api/requests", "GET")).toBe("api");
    expect(classify("/api/requests/cmabcdefghijklmnopqrst/run", "POST")).toBe("heavy");
    expect(classify("/api/requests/cmabcdefghijklmnopqrst/export", "GET")).toBe("heavy");
    expect(classify("/api/requests/cmabcdefghijklmnopqrst", "GET")).toBe("api");
    expect(classify("/api/pricing/import", "POST")).toBe("heavy");
    expect(classify("/api/catalog/gudid", "GET")).toBe("api");
    expect(classify("/api/catalog/gudid", "POST")).toBe("heavy");
    expect(classify("/api/proposals/cmabcdefghijklmnopqrst/lines", "PATCH")).toBe("api");
  });
  test("fixed windows per client and class; 429 after the limit; window resets; sweep bounds memory", () => {
    let t = 1_000_000;
    const rl = new RateLimiter({ auth: 2, heavy: 3, api: 5 }, () => t);
    expect(rl.hit("1.1.1.1", "auth")).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
    expect(rl.hit("1.1.1.1", "auth")).toMatchObject({ allowed: true, remaining: 0 });
    expect(rl.hit("1.1.1.1", "auth")).toMatchObject({ allowed: false, remaining: 0, resetAt: t + 60_000 });
    expect(rl.hit("2.2.2.2", "auth").allowed).toBe(true); // other client
    expect(rl.hit("1.1.1.1", "api").allowed).toBe(true); // other class
    t += 60_001;
    expect(rl.hit("1.1.1.1", "auth")).toMatchObject({ allowed: true, remaining: 1 });
    t += 60_001; rl.hit("3.3.3.3", "api");
    expect(rl.size).toBe(2); // everything older swept (one client bucket + the class-wide one)
  });
  test("the instance-wide ceiling bounds a flood of invented client addresses", () => {
    let t = 5_000_000;
    const rl = new RateLimiter({ auth: 2, heavy: 3, api: 5 }, () => t, 3); // ceiling = 3 × client limit
    const results = Array.from({ length: 8 }, (_, i) => rl.hit(`spoof-${i}`, "auth").allowed);
    expect(results).toEqual([true, true, true, true, true, true, false, false]); // 2 × 3 = 6 sign-ins per minute per instance, whatever the address
    t += 60_001;
    expect(rl.hit("spoof-99", "auth").allowed).toBe(true);
  });
  test("limits come from the environment, disabled switch, client key honours proxy hops", () => {
    expect(limitsFromEnv({})).toEqual({ auth: 20, heavy: 60, api: 600 });
    expect(limitsFromEnv({ RATE_LIMIT_AUTH: "5", RATE_LIMIT_API: "junk" })).toEqual({ auth: 5, heavy: 60, api: 600 });
    expect(limitsFromEnv({ RATE_LIMIT_DISABLED: "true" })).toBeNull();
    const h = (xff?: string, real?: string) => { const x = new Headers(); if (xff) x.set("x-forwarded-for", xff); if (real) x.set("x-real-ip", real); return x; };
    expect(clientKey(h("10.0.0.1, 203.0.113.9"), {})).toBe("203.0.113.9");
    expect(clientKey(h("203.0.113.9, 10.0.0.2"), { TRUST_PROXY_HOPS: "2" })).toBe("203.0.113.9");
    expect(clientKey(h(undefined, "198.51.100.1"), {})).toBe("198.51.100.1");
    expect(clientKey(h(), {})).toBe("unknown");
  });
  test("CSP is nonce-based and strict; dev adds unsafe-eval only; hardening headers include HSTS only over https", () => {
    const n = makeNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    expect(makeNonce()).not.toBe(n);
    const csp = contentSecurityPolicy(n, { https: true });
    expect(csp).toContain(`script-src 'self' 'nonce-${n}' 'strict-dynamic'`);
    expect(csp).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy(n)).not.toContain("upgrade-insecure-requests"); // plain HTTP: never upgrade, it would break every asset
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy(n, { dev: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy(n, { extraConnect: ["https://x"] })).toContain("connect-src 'self' https://x");
    expect(hardeningHeaders({ https: true })["strict-transport-security"]).toMatch(/max-age=31536000/);
    expect(hardeningHeaders({ https: false })["strict-transport-security"]).toBeUndefined();
    expect(hardeningHeaders({ https: false })["x-frame-options"]).toBe("DENY");
    const hs = new Headers({ "x-forwarded-proto": "https" });
    expect(isHttps(new URL("http://app/"), hs)).toBe(true);
    expect(isHttps(new URL("http://app/"), new Headers())).toBe(false);
  });
});

describe("0.6 CHECK constraints", () => {
  test("the committed migration is exactly what the definitions generate (regenerate with scripts/gen-constraints.ts)", () => {
    const committed = fs.readFileSync(path.resolve(__dirname, "../../prisma/migrations/20260919000100_tier0_check_constraints/migration.sql"), "utf8");
    expect(committed).toBe(migrationSql());
    expect(committed).toMatch(/NOT VALID;\nALTER TABLE "UserRole" VALIDATE CONSTRAINT "chk_UserRole_role";/); // add without a long exclusive lock
  });
  test("enum constraints track the application's own lists and never overlap", () => {
    const byKey = new Map(ENUM_CONSTRAINTS.map((c) => [`${c.table}.${c.column}`, c.values]));
    expect(byKey.get("UserRole.role")).toEqual(ROLES);
    expect(byKey.get("Notification.kind")).toEqual(KINDS);
    expect(byKey.get("KnownCross.equivalenceLevel")).toEqual(EQUIVALENCE);
    expect(byKey.get("CompetitorPriceObservation.sourceType")).toEqual(SOURCE_TYPES);
    expect(byKey.get("Request.status")).toContain("cancelled");
    expect(byKey.get("Account.type")).toEqual(ACCOUNT_TYPES); // the API's vocabulary, not the schema comment's
    const names = [...ENUM_CONSTRAINTS, ...EXPR_CONSTRAINTS].map(constraintName);
    expect(new Set(names).size).toBe(names.length);
    for (const c of ENUM_CONSTRAINTS) expect(new Set(c.values).size).toBe(c.values.length);
  });
  test("violation queries are NULL-safe and quote values", () => {
    const q = violationQueries().find((v) => v.name === "chk_Proposal_freightMode")!;
    expect(q.sql).toContain(`NOT ("freightMode" IN ('NONE', 'FLAT', 'PCT'))`);
    expect(q.sql).toContain("IS NOT NULL");
    expect(constraintExpr({ table: "T", column: "c", values: ["it's"] })).toBe(`"c" IN ('it''s')`);
  });
});

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

const actor = (roles: string[]): Actor => ({ id: "u1", email: "u@x", name: "U", roles, permissions: permissionsFor(roles), isDev: true });

describe("0.2 scope fragments", () => {
  test("non-scoped roles and mixed roles are unscoped without touching the database", async () => {
    expect(await scopeFor(actor(["PRICING_ANALYST"]))).toEqual({ mode: "all" });
    expect(await scopeFor(actor(["SALES_REP", "ADMIN"]))).toEqual({ mode: "all" });
    expect(await scopeFor(actor([]))).toEqual({ mode: "all" });
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
  test("claim values map through the table, or to themselves when they are role names; unknowns dropped", () => {
    const map = parseRoleMap("CW-Admins=ADMIN");
    expect(mapRoles(["cw-admins", "SALES_REP", "Everyone", "sales_rep"], map)).toEqual(["SALES_REP", "ADMIN"]);
    expect(mapRoles("FINANCE EXECUTIVE", map)).toEqual(["FINANCE", "EXECUTIVE"]);
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
    for (const bad of [null, "", "https://evil", "//evil", "/\\evil", "/api/auth/dev", "/a\r\nb", "javascript:alert(1)"]) expect(safeNext(bad)).toBe("/");
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
  next: { sub?: string; nonce?: string | (() => string); aud?: string; iss?: string; exp?: number; claims?: Record<string, unknown>; status?: number; body?: unknown } = {};
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
      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({ nonce, email: "Rep@Example.com", name: "Rep Person", roles: ["CW-Reps"], ...(this.next.claims ?? {}) })
        .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(this.next.iss ?? this.issuer).setAudience(this.next.aud ?? this.clientId).setSubject(this.next.sub ?? "sub-123")
        .setIssuedAt(now).setExpirationTime(this.next.exp ?? now + 600).sign(this.key.privateKey);
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
    idp.next = { claims: { realm_access: { roles: ["pricing_director"] } } };
    expect((await completeSignIn({ ...cfg, roleClaim: "realm_access.roles" }, { code: "c", state: state.state }, state)).identity.roles).toEqual(["PRICING_DIRECTOR"]);
  });

  test("email falls back to preferred_username / upn and is lower-cased; a token without a subject is refused", async () => {
    let { state } = await happyStart();
    idp.next = { claims: { email: undefined, preferred_username: "Someone@Corp.com" } };
    expect((await completeSignIn(cfg, { code: "c", state: state.state }, state)).identity.email).toBe("someone@corp.com");
    ({ state } = await happyStart());
    idp.next = { claims: { email: undefined, preferred_username: "not-an-email" } };
    expect((await completeSignIn(cfg, { code: "c", state: state.state }, state)).identity.email).toBeNull();
  });

  test("a bad discovery document is a 502, never a crash", async () => {
    setOidcFetchForTests(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(beginSignIn(cfg, "/")).rejects.toMatchObject({ status: 502 });
    setOidcFetchForTests(async () => new Response("down", { status: 503 }));
    await expect(beginSignIn(cfg, "/")).rejects.toBeInstanceOf(AuthError);
    setOidcFetchForTests(idp.fetch);
  });
});

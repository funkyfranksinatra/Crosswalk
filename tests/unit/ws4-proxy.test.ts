/**
 * WS4 — the request gate (src/proxy.ts) exercised as a function, no server, no database.
 *
 *   KN-01  POST /api/webhooks/salesforce is open at the proxy (exactly that path and method);
 *          every neighbour stays closed.
 *   G      x-sso-subject is only a session in SSO_MODE=proxy, and only with the proxy secret
 *          header; outside proxy mode both headers are stripped before the handler sees them.
 *   F      x-crosswalk-path / x-crosswalk-route / x-nonce supplied by a client are overwritten.
 *   I      cookie-bearing mutations from another site are refused (Sec-Fetch-Site / Origin).
 *   J      rate-limit headers, Retry-After, x-request-id validation, malformed path → 400.
 */
import { describe, test, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isOpenRoute, proxySsoMode } from "@/proxy";
import { crossSiteReason, expectedHosts } from "@/lib/security/csrf";

const env = { ...process.env };
afterAll(() => { process.env = env; });
beforeEach(() => { delete process.env.SSO_ISSUER; delete process.env.SSO_CLIENT_ID; delete process.env.SSO_MODE; });

type Init = { method?: string; headers?: Record<string, string>; cookie?: string; body?: string };
function req(path: string, init: Init = {}): NextRequest {
  const h = new Headers(init.headers ?? {});
  if (init.cookie) h.set("cookie", init.cookie);
  return new NextRequest(new URL(path, "http://localhost:3104"), { method: init.method ?? "GET", headers: h, body: init.body });
}
/** The headers the handler would see after the proxy ran (NextResponse.next rewrites them as x-middleware-request-*). */
function forwarded(res: Response): Record<string, string> {
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  for (const n of names) out[n] = res.headers.get(`x-middleware-request-${n}`) ?? "";
  return out;
}
const COOKIE = "crosswalk_dev_user=abc.def";

describe("WS4 proxy gate — open list", () => {
  test("only the exact webhook path and method are open; the /api/webhooks prefix is not", () => {
    expect(isOpenRoute("/api/webhooks/salesforce", "POST")).toBe(true);
    expect(isOpenRoute("/api/webhooks/salesforce", "GET")).toBe(false);
    expect(isOpenRoute("/api/webhooks/salesforce/", "POST")).toBe(false);
    expect(isOpenRoute("/api/webhooks/salesforce/x", "POST")).toBe(false);
    expect(isOpenRoute("/api/webhooks/sap", "POST")).toBe(false);
    expect(isOpenRoute("/api/webhooks", "POST")).toBe(false);
    expect(isOpenRoute("/api/auth/dev", "POST")).toBe(true);
    expect(isOpenRoute("/api/health", "GET")).toBe(true);
    expect(isOpenRoute("/api/healthz", "GET")).toBe(false);
    expect(isOpenRoute("/api/metrics", "GET")).toBe(true);
    expect(isOpenRoute("/api/requests", "POST")).toBe(false);
  });
  test("KN-01: an unauthenticated POST to the webhook reaches the handler; neighbours are 401", async () => {
    const ok = proxy(req("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": "00" }, body: "{}" }));
    expect(ok.status).toBe(200); // NextResponse.next()
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/api/webhooks/salesforce", { method: "GET" })).status).toBe(401);
    expect(proxy(req("/api/webhooks/sap", { method: "POST" })).status).toBe(401);
    expect(proxy(req("/api/requests", { method: "POST" })).status).toBe(401);
    expect(proxy(req("/api/requests")).status).toBe(401);
    expect(proxy(req("/api/settings")).status).toBe(401);
  });
  test("KN-01: a declared body over 256 KB is refused at the gate with 413", () => {
    const res = proxy(req("/api/webhooks/salesforce", { method: "POST", headers: { "content-length": String(256 * 1024 + 1) } }));
    expect(res.status).toBe(413);
    expect(proxy(req("/api/webhooks/salesforce", { method: "POST", headers: { "content-length": String(256 * 1024) } })).status).toBe(200);
  });
});

describe("WS4 proxy gate — sessions and SSO headers", () => {
  test("a dev or session cookie is a session; x-sso-subject alone is not outside proxy mode, and both SSO headers are stripped", () => {
    expect(proxy(req("/api/requests", { cookie: COOKIE })).status).toBe(200);
    expect(proxy(req("/api/requests", { cookie: "crosswalk_session=x.y" })).status).toBe(200);
    expect(proxy(req("/api/requests", { cookie: "crosswalk_dev_user=" })).status).toBe(401);
    const spoof = proxy(req("/api/requests", { headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": "whatever-whatever" } }));
    expect(spoof.status).toBe(401);
    const withCookie = proxy(req("/api/requests", { cookie: COOKIE, headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": "s" } }));
    const fwd = forwarded(withCookie);
    expect(fwd["x-sso-subject"]).toBeUndefined(); // absent from the override list = removed from the forwarded request
    expect(fwd["x-sso-proxy-secret"]).toBeUndefined();
  });
  test("proxy mode: the subject header counts only with the proxy-secret header alongside; the handler does the constant-time check", () => {
    process.env.SSO_ISSUER = "https://idp.test"; process.env.SSO_CLIENT_ID = "c"; process.env.SSO_MODE = "proxy";
    expect(proxySsoMode()).toBe(true);
    expect(proxy(req("/api/requests", { headers: { "x-sso-subject": "u@x" } })).status).toBe(401);
    const both = proxy(req("/api/requests", { headers: { "x-sso-subject": "u@x", "x-sso-proxy-secret": "shared-secret-value-1" } }));
    expect(both.status).toBe(200);
    expect(forwarded(both)["x-sso-subject"]).toBe("u@x");
    process.env.SSO_MODE = "oidc";
    expect(proxySsoMode()).toBe(false);
    expect(proxy(req("/api/requests", { headers: { "x-sso-subject": "u@x", "x-sso-proxy-secret": "shared-secret-value-1" } })).status).toBe(401);
  });
});

describe("WS4 proxy gate — forwarded headers cannot be spoofed", () => {
  test("x-crosswalk-path, x-crosswalk-route and x-nonce from the client are overwritten / dropped", () => {
    const res = proxy(req("/api/accounts/cmabcdefghijklmnopqrstuv/contracts", { cookie: COOKIE, headers: { "x-crosswalk-path": "/api/health", "x-crosswalk-route": "GET /api/health", "x-nonce": "attacker", "x-request-id": "bad id!" } }));
    const fwd = forwarded(res);
    expect(fwd["x-crosswalk-path"]).toBe("/api/accounts/cmabcdefghijklmnopqrstuv/contracts");
    expect(fwd["x-crosswalk-route"]).toBe("GET /api/accounts/:id/contracts");
    expect(fwd["x-nonce"]).toBeUndefined();
    expect(fwd["x-request-id"]).toMatch(/^[a-f0-9]{20}$/); // the malformed client id was replaced
    expect(res.headers.get("x-request-id")).toBe(fwd["x-request-id"]);
    // a client's own id is honoured only behind a declared proxy (review REV-10)
    const replaced = proxy(req("/api/health", { headers: { "x-request-id": "trace-123:abc" } }));
    expect(replaced.headers.get("x-request-id")).toMatch(/^[a-f0-9]{20}$/);
    const prev = process.env.TRUST_PROXY_HOPS; process.env.TRUST_PROXY_HOPS = "1";
    try { const kept = proxy(req("/api/health", { headers: { "x-request-id": "trace-123:abc" } })); expect(kept.headers.get("x-request-id")).toBe("trace-123:abc"); }
    finally { if (prev === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = prev; }
  });
  test("percent-encoded and double-encoded ids reach scoping decoded once; undecodable paths are 400", () => {
    const enc = proxy(req("/api/accounts/cmabcdefghijklmnopqrstu%76", { cookie: COOKIE }));
    expect(forwarded(enc)["x-crosswalk-path"]).toBe("/api/accounts/cmabcdefghijklmnopqrstuv");
    const dbl = proxy(req("/api/accounts/cmabcdefghijklmnopqrstu%2576", { cookie: COOKIE }));
    expect(forwarded(dbl)["x-crosswalk-path"]).toBe("/api/accounts/cmabcdefghijklmnopqrstu%76"); // still not a valid id → 404 in the hook
    expect(proxy(req("/api/accounts/x%ZZ", { cookie: COOKIE })).status).toBe(400);
    expect(proxy(req("/api/accounts/x%00y", { cookie: COOKIE })).status).toBe(400); // a NUL byte cannot travel in the path header: 400, not a thrown TypeError
    expect(proxy(req("/api/accounts/x%0d%0ay", { cookie: COOKIE })).status).toBe(400);
  });
});

describe("WS4 proxy gate — CSRF posture for cookie-authenticated mutations", () => {
  test("crossSiteReason: same-origin / none pass, cross-site and same-site refused, Origin must match the addressed host, non-browsers pass", () => {
    const url = new URL("http://app.internal:3000/api/requests");
    const h = (o: Record<string, string>) => new Headers(o);
    expect(crossSiteReason(h({ "sec-fetch-site": "same-origin" }), url)).toBeNull();
    expect(crossSiteReason(h({ "sec-fetch-site": "none" }), url)).toBeNull();
    expect(crossSiteReason(h({ "sec-fetch-site": "cross-site", origin: "http://app.internal:3000" }), url)).toMatch(/cross-site/);
    expect(crossSiteReason(h({ "sec-fetch-site": "same-site" }), url)).toMatch(/same-site/);
    expect(crossSiteReason(h({ origin: "http://app.internal:3000", host: "app.internal:3000" }), url)).toBeNull();
    // X-Forwarded-Host counts only behind a declared balancer (TRUST_PROXY_HOPS > 0); a client-sent one is ignored
    expect(crossSiteReason(h({ origin: "https://crosswalk.example.com", host: "app.internal:3000", "x-forwarded-host": "crosswalk.example.com" }), url, { TRUST_PROXY_HOPS: "1" })).toBeNull();
    expect(crossSiteReason(h({ origin: "https://crosswalk.example.com", host: "app.internal:3000", "x-forwarded-host": "crosswalk.example.com" }), url, {})).toBe("origin mismatch");
    expect(crossSiteReason(h({ origin: "https://evil.example", host: "app.internal:3000", "x-forwarded-host": "evil.example" }), url, {})).toBe("origin mismatch");
    expect(crossSiteReason(h({ origin: "https://evil.example", host: "app.internal:3000" }), url)).toBe("origin mismatch");
    expect(crossSiteReason(h({ origin: "null" }), url)).toBe("origin=null");
    expect(crossSiteReason(h({ origin: "not a url" }), url)).toBe("origin unparsable");
    expect(crossSiteReason(h({}), url)).toBeNull(); // curl with a copied cookie: the cookie is the credential
    expect(crossSiteReason(h({ origin: "https://crosswalk.example.com" }), url, { APP_BASE_URL: "https://crosswalk.example.com/" })).toBeNull();
    expect([...expectedHosts(h({ host: "A.b:1", "x-forwarded-host": "pub.example, inner" }), url, { TRUST_PROXY_HOPS: "1" })]).toEqual(["pub.example", "a.b:1", "app.internal:3000"]);
    expect([...expectedHosts(h({ host: "A.b:1", "x-forwarded-host": "pub.example, inner" }), url, {})]).toEqual(["a.b:1", "app.internal:3000"]);
  });
  test("the gate refuses a cross-site POST that carries the cookie, and never touches GET, open routes or cookie-less calls", () => {
    expect(proxy(req("/api/requests", { method: "POST", cookie: COOKIE, headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } })).status).toBe(403);
    expect(proxy(req("/api/requests", { method: "PATCH", cookie: COOKIE, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(proxy(req("/api/requests", { method: "DELETE", cookie: COOKIE, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(proxy(req("/api/requests", { method: "POST", cookie: COOKIE, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect(proxy(req("/api/requests", { method: "POST", cookie: COOKIE, headers: { origin: "http://localhost:3104" } })).status).toBe(200);
    expect(proxy(req("/api/requests", { method: "POST", cookie: COOKIE })).status).toBe(200); // script client
    expect(proxy(req("/api/requests", { method: "GET", cookie: COOKIE, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200); // reads are not forgeable
    expect(proxy(req("/api/auth/dev", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200); // open route: no cookie credential involved
    expect(proxy(req("/api/webhooks/salesforce", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
  });
  test("no CORS headers are ever emitted", () => {
    for (const r of [proxy(req("/api/requests", { cookie: COOKIE, headers: { origin: "https://evil.example" } })), proxy(req("/api/requests", { method: "OPTIONS", cookie: COOKIE, headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }))]) {
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("WS4 proxy gate — rate limiting and hardening headers", () => {
  test("every /api response carries x-ratelimit-* and the hardening set; pages get a nonce CSP", () => {
    const api = proxy(req("/api/requests", { cookie: COOKIE }));
    expect(api.headers.get("x-ratelimit-limit")).toBe("600");
    expect(Number(api.headers.get("x-ratelimit-remaining"))).toBeLessThan(600);
    expect(Number(api.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.now() / 1000 - 1);
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    expect(api.headers.get("content-security-policy")).toBeNull(); // JSON never runs script; pages carry the CSP
    const page = proxy(req("/proposals"));
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(forwarded(page)["x-nonce"]).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    expect(csp).toContain(`'nonce-${forwarded(page)["x-nonce"]}'`);
    expect(page.headers.get("strict-transport-security")).toBeNull(); // plain http
    expect(proxy(req("/proposals", { headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
  });
  test("client key: TRUST_PROXY_HOPS 0 behaves as 1 (the last forwarded entry); 2 skips one balancer; a client-appended entry cannot reach a bucket behind a balancer that appends", async () => {
    const { clientKey } = await import("@/lib/security/ratelimit");
    const h = (xff: string) => new Headers({ "x-forwarded-for": xff });
    expect(clientKey(h("198.51.100.7, 10.0.0.1"), { TRUST_PROXY_HOPS: "0" })).toBe("10.0.0.1");
    expect(clientKey(h("198.51.100.7, 10.0.0.1"), { TRUST_PROXY_HOPS: "1" })).toBe("10.0.0.1");
    expect(clientKey(h("198.51.100.7, 10.0.0.1"), { TRUST_PROXY_HOPS: "2" })).toBe("198.51.100.7");
    expect(clientKey(h("evil, 198.51.100.7, 10.0.0.1"), { TRUST_PROXY_HOPS: "2" })).toBe("198.51.100.7"); // attacker-prepended entries are ignored
    expect(clientKey(h("198.51.100.7"), { TRUST_PROXY_HOPS: "5" })).toBe("198.51.100.7"); // more hops than entries: the first entry, never "unknown"
    expect(clientKey(h("x".repeat(200)), {})).toHaveLength(64);
    expect(clientKey(new Headers({ "x-forwarded-for": " , , " }), {})).toBe("unknown");
  });
  test("the auth class trips at 20/min per client and answers 429 with Retry-After; another client address is unaffected", () => {
    const client = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) last = proxy(req("/api/auth/dev", { headers: { "x-forwarded-for": client } }));
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(last!.headers.get("x-ratelimit-limit")).toBe("20");
    expect(last!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(last!.headers.get("x-request-id")).toBeTruthy();
    expect(proxy(req("/api/auth/dev", { headers: { "x-forwarded-for": "198.51.100.77" } })).status).toBe(200);
  });
});

describe("WS4 — outbound URL policy (src/lib/security/urls.ts, offered to the integration field validator)", () => {
  test("loopback, link-local, private, metadata, non-http and credentialed URLs are refused; public https passes", async () => {
    const { outboundUrlProblem, assertOutboundUrl } = await import("@/lib/security/urls");
    for (const bad of ["http://127.0.0.1/", "http://127.1.2.3:8080/x", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://10.0.0.5/", "http://172.16.0.1/", "http://192.168.1.1/", "http://100.64.0.1/", "http://0.0.0.0/", "http://localhost:5432/", "http://sap.internal/", "http://metadata.google.internal/", "http://2130706433/", "http://0x7f000001/"]) expect(outboundUrlProblem(bad), bad).toBe("private");
    for (const bad of ["file:///etc/passwd", "ftp://x/", "gopher://x", "javascript:alert(1)"]) expect(outboundUrlProblem(bad), bad).toBe("scheme");
    expect(outboundUrlProblem("https://user:pw@api.example.com/")).toBe("credentials");
    expect(outboundUrlProblem("not a url")).toBe("unparsable");
    expect(outboundUrlProblem("https://api.example.com/odata")).toBeNull();
    expect(outboundUrlProblem("http://sap.example.com:44300/sap/opu")).toBeNull();
    expect(assertOutboundUrl("https://data-api.ecb.europa.eu/service/data/EXR").hostname).toBe("data-api.ecb.europa.eu");
    expect(() => assertOutboundUrl("http://169.254.169.254/", "Gateway base URL")).toThrow(/metadata/);
  });
});

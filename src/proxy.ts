/**
 * Request gate (defence in depth) and the security layer every response passes through.
 *
 *  - Every response gets the hardening headers (src/lib/security/headers.ts); page responses
 *    get a per-request nonce-based Content Security Policy.
 *  - Every /api route except sign-in, health, metrics and the HMAC-authenticated Salesforce
 *    webhook is refused without a session (dev cookie, OIDC session cookie, or — in
 *    SSO_MODE=proxy only — the subject header an authenticating proxy sets together with its
 *    shared-secret header). Route handlers still resolve and authorise the actor themselves
 *    via `handle()`; this layer exists so a route that forgets to is closed rather than open.
 *  - Cookie-authenticated mutations must come from this origin (Sec-Fetch-Site / Origin): a
 *    cross-site form post or fetch carrying the session cookie is refused (CSRF).
 *  - /api calls are rate limited per client and route class (src/lib/security/ratelimit.ts):
 *    sign-in tighter than the rest, expensive routes tighter than reads.
 *  - Each /api call carries a request id and the collapsed route / real path for logging,
 *    metrics and ownership scoping (src/lib/api.ts). Client-supplied copies of those headers
 *    (and of the SSO headers outside proxy mode) are dropped before the handler sees them.
 */
import { NextResponse, type NextRequest } from "next/server";
import { RateLimiter, classify, clientKey, limitsFromEnv } from "@/lib/security/ratelimit";
import { contentSecurityPolicy, hardeningHeaders, isHttps, makeNonce } from "@/lib/security/headers";
import { crossSiteReason } from "@/lib/security/csrf";

const DEV_COOKIE = "crosswalk_dev_user";
const SESSION_COOKIE = "crosswalk_session";
const SSO_SUBJECT_HEADER = "x-sso-subject";
const SSO_PROXY_SECRET_HEADER = "x-sso-proxy-secret";
/**
 * Unauthenticated by design: sign-in, liveness for the load balancer, the scrape endpoint
 * (token-guarded in its handler) and the Salesforce webhook (HMAC-guarded in its handler,
 * POST only — the exact path, not the /api/webhooks/ prefix).
 */
const OPEN: readonly { path: string; prefix?: boolean; methods?: readonly string[] }[] = [
  { path: "/api/auth/", prefix: true },
  { path: "/api/health" },
  { path: "/api/metrics" },
  { path: "/api/webhooks/salesforce", methods: ["POST"] },
];
export function isOpenRoute(pathname: string, method: string): boolean {
  return OPEN.some((o) => (o.prefix ? pathname.startsWith(o.path) : pathname === o.path) && (!o.methods || o.methods.includes(method.toUpperCase())));
}
/** The webhook handler refuses bodies over this size; a declared larger body is refused before it is read. */
const WEBHOOK_MAX_BYTES = 256 * 1024;

/** Headers only this file may set on the request the handler sees. */
const RESERVED_REQUEST_HEADERS = ["x-crosswalk-route", "x-crosswalk-path", "x-nonce"];

const limits = limitsFromEnv();
const limiter = limits ? new RateLimiter(limits) : null;

function requestId(req: NextRequest): string {
  // A client-chosen id would let it collide with or pose as another request in the logs; the
  // header is honoured only behind a declared proxy that sets it (review REV-10).
  const given = Number(process.env.TRUST_PROXY_HOPS ?? 0) > 0 ? req.headers.get("x-request-id") : null;
  if (given && /^[A-Za-z0-9_.:-]{6,64}$/.test(given)) return given;
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function harden(res: NextResponse, req: NextRequest, csp?: string): NextResponse {
  for (const [k, v] of Object.entries(hardeningHeaders({ https: isHttps(req.nextUrl, req.headers) }))) res.headers.set(k, v);
  if (csp) res.headers.set(process.env.CSP_REPORT_ONLY === "true" ? "content-security-policy-report-only" : "content-security-policy", csp);
  return res;
}

/** SSO_MODE=proxy is only in force when SSO is configured AND the mode is set (src/lib/auth/oidc ssoMode). */
export function proxySsoMode(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SSO_ISSUER && env.SSO_CLIENT_ID) && (env.SSO_MODE ?? "oidc").toLowerCase() === "proxy";
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) {
    // Pages: a fresh nonce per request; Next reads it from the CSP request header for its own scripts.
    const nonce = makeNonce();
    const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development", https: isHttps(req.nextUrl, req.headers) });
    const headers = new Headers(req.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    return harden(NextResponse.next({ request: { headers } }), req, csp);
  }

  const id = requestId(req);
  const withId = (res: NextResponse) => { res.headers.set("x-request-id", id); return harden(res, req); };
  // Next decodes route params before a handler sees them; scoping must see the same decoded path.
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(pathname); } catch { return withId(NextResponse.json({ error: "Malformed path" }, { status: 400 })); }
  // Control characters (%00, %0d%0a…) are not part of any route and cannot travel in a header: refuse rather than throw.
  if (/[\u0000-\u001f\u007f]/.test(decodedPath)) return withId(NextResponse.json({ error: "Malformed path" }, { status: 400 }));
  const method = req.method.toUpperCase();

  let rate: { limit: number; remaining: number; resetAt: number } | null = null;
  if (limiter) {
    const d = limiter.hit(clientKey(req.headers), classify(decodedPath, method));
    rate = d;
    if (!d.allowed) {
      const secs = Math.max(1, Math.ceil((d.resetAt - Date.now()) / 1000));
      const res = NextResponse.json({ error: "Too many requests", retryAfterSeconds: secs }, { status: 429 });
      res.headers.set("retry-after", String(secs));
      res.headers.set("x-ratelimit-limit", String(d.limit));
      res.headers.set("x-ratelimit-remaining", "0");
      res.headers.set("x-ratelimit-reset", String(Math.ceil(d.resetAt / 1000)));
      return withId(res);
    }
  }
  const withRate = (res: NextResponse) => {
    if (rate) { res.headers.set("x-ratelimit-limit", String(rate.limit)); res.headers.set("x-ratelimit-remaining", String(rate.remaining)); res.headers.set("x-ratelimit-reset", String(Math.ceil(rate.resetAt / 1000))); }
    return withId(res);
  };

  const headers = new Headers(req.headers);
  for (const h of RESERVED_REQUEST_HEADERS) headers.delete(h);
  headers.set("x-request-id", id);
  // The route with ids collapsed, for bounded-cardinality metrics and log lines (src/lib/api.ts).
  headers.set("x-crosswalk-route", `${method} ${decodedPath.replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, "/:id")}`.slice(0, 120));
  // The real path, for ownership scoping in src/lib/api.ts (a client cannot set it: overwritten here).
  headers.set("x-crosswalk-path", decodedPath.slice(0, 400));
  // Outside SSO_MODE=proxy nothing upstream asserts identities: a subject header is a client's claim, dropped.
  const proxyMode = proxySsoMode();
  if (!proxyMode) { headers.delete(SSO_SUBJECT_HEADER); headers.delete(SSO_PROXY_SECRET_HEADER); }
  const next = () => withRate(NextResponse.next({ request: { headers } }));

  if (isOpenRoute(decodedPath, method)) {
    if (decodedPath === "/api/webhooks/salesforce") {
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return withRate(NextResponse.json({ error: "payload too large" }, { status: 413 }));
    }
    return next();
  }
  const cookieSession = Boolean(req.cookies.get(DEV_COOKIE)?.value) || Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  const proxySession = proxyMode && Boolean(req.headers.get(SSO_SUBJECT_HEADER)) && Boolean(req.headers.get(SSO_PROXY_SECRET_HEADER));
  if (!cookieSession && !proxySession) return withRate(NextResponse.json({ error: "Sign in required" }, { status: 401 }));
  // A cookie is sent by the browser on any site's request; a mutation must originate here.
  if (cookieSession && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const reason = crossSiteReason(req.headers, req.nextUrl);
    if (reason) return withRate(NextResponse.json({ error: "Cross-site request refused", reason }, { status: 403 }));
  }
  return next();
}

export const config = {
  matcher: [
    // API: gate, rate limit, ids. Pages: CSP + hardening — skipping static assets and prefetches.
    "/api/:path*",
    { source: "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|css|js|map)$).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] },
  ],
};

/**
 * Request gate (defence in depth) and the security layer every response passes through.
 *
 *  - Every response gets the hardening headers (src/lib/security/headers.ts); page responses
 *    get a per-request nonce-based Content Security Policy.
 *  - Every /api route except sign-in, health and metrics is refused without a session (dev
 *    cookie, OIDC session cookie, or the SSO subject header an authenticating proxy sets).
 *    Route handlers still resolve and authorise the actor themselves via `handle()`; this
 *    layer exists so a route that forgets to is closed rather than open.
 *  - /api calls are rate limited per client and route class (src/lib/security/ratelimit.ts):
 *    sign-in tighter than the rest, expensive routes tighter than reads.
 *  - Each /api call carries a request id and the collapsed route / real path for logging,
 *    metrics and ownership scoping (src/lib/api.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { RateLimiter, classify, clientKey, limitsFromEnv } from "@/lib/security/ratelimit";
import { contentSecurityPolicy, hardeningHeaders, isHttps, makeNonce } from "@/lib/security/headers";

const DEV_COOKIE = "crosswalk_dev_user";
const SESSION_COOKIE = "crosswalk_session";
/** Unauthenticated by design: sign-in, liveness for the load balancer, and the scrape endpoint (token-guarded in its handler). */
const OPEN = ["/api/auth/", "/api/health", "/api/metrics"];

const limits = limitsFromEnv();
const limiter = limits ? new RateLimiter(limits) : null;

function requestId(req: NextRequest): string {
  const given = req.headers.get("x-request-id");
  if (given && /^[A-Za-z0-9_.:-]{6,64}$/.test(given)) return given;
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function harden(res: NextResponse, req: NextRequest, csp?: string): NextResponse {
  for (const [k, v] of Object.entries(hardeningHeaders({ https: isHttps(req.nextUrl, req.headers) }))) res.headers.set(k, v);
  if (csp) res.headers.set(process.env.CSP_REPORT_ONLY === "true" ? "content-security-policy-report-only" : "content-security-policy", csp);
  return res;
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

  if (limiter) {
    const d = limiter.hit(clientKey(req.headers), classify(decodedPath, req.method));
    if (!d.allowed) {
      const res = NextResponse.json({ error: "Too many requests", retryAfterSeconds: Math.ceil((d.resetAt - Date.now()) / 1000) }, { status: 429 });
      res.headers.set("retry-after", String(Math.max(1, Math.ceil((d.resetAt - Date.now()) / 1000))));
      res.headers.set("x-ratelimit-limit", String(d.limit));
      res.headers.set("x-ratelimit-remaining", "0");
      return withId(res);
    }
  }

  const headers = new Headers(req.headers);
  headers.set("x-request-id", id);
  // The route with ids collapsed, for bounded-cardinality metrics and log lines (src/lib/api.ts).
  headers.set("x-crosswalk-route", `${req.method} ${decodedPath.replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, "/:id")}`.slice(0, 120));
  // The real path, for ownership scoping in src/lib/api.ts (a client cannot set it: overwritten here).
  headers.set("x-crosswalk-path", decodedPath.slice(0, 400));
  const next = () => withId(NextResponse.next({ request: { headers } }));
  if (OPEN.some((p) => (p.endsWith("/") ? decodedPath.startsWith(p) : decodedPath === p))) return next();
  const hasSession = Boolean(req.cookies.get(DEV_COOKIE)?.value) || Boolean(req.cookies.get(SESSION_COOKIE)?.value) || Boolean(req.headers.get("x-sso-subject"));
  if (!hasSession) return withId(NextResponse.json({ error: "Sign in required" }, { status: 401 }));
  return next();
}

export const config = {
  matcher: [
    // API: gate, rate limit, ids. Pages: CSP + hardening — skipping static assets and prefetches.
    "/api/:path*",
    { source: "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|css|js|map)$).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] },
  ],
};

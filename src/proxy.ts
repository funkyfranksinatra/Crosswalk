/**
 * Request gate (defence in depth). Every /api route except sign-in is refused without a
 * session (dev cookie, or the SSO subject header an authenticating proxy sets). Route
 * handlers still resolve and authorise the actor themselves via `handle()`; this layer
 * exists so a route that forgets to is closed rather than open.
 */
import { NextResponse, type NextRequest } from "next/server";

const DEV_COOKIE = "crosswalk_dev_user";
/** Unauthenticated by design: liveness for the load balancer, and the scrape endpoint (token-guarded in its handler). */
const OPEN = ["/api/auth/", "/api/health", "/api/metrics"];

function requestId(req: NextRequest): string {
  const given = req.headers.get("x-request-id");
  if (given && /^[A-Za-z0-9_.:-]{6,64}$/.test(given)) return given;
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  // Every API call carries a request id, generated here or accepted from an upstream proxy,
  // so the JSON log lines of one call can be joined (src/lib/log.ts).
  const id = requestId(req);
  const headers = new Headers(req.headers);
  headers.set("x-request-id", id);
  // The route with ids collapsed, for bounded-cardinality metrics and log lines (src/lib/api.ts).
  headers.set("x-crosswalk-route", `${req.method} ${pathname.replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, "/:id")}`.slice(0, 120));
  const next = () => { const res = NextResponse.next({ request: { headers } }); res.headers.set("x-request-id", id); return res; };
  if (OPEN.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p))) return next();
  const hasSession = Boolean(req.cookies.get(DEV_COOKIE)?.value) || Boolean(req.headers.get("x-sso-subject"));
  if (!hasSession) { const res = NextResponse.json({ error: "Sign in required" }, { status: 401 }); res.headers.set("x-request-id", id); return res; }
  return next();
}

export const config = { matcher: ["/api/:path*"] };

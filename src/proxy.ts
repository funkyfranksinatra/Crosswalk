/**
 * Request gate (defence in depth). Every /api route except sign-in is refused without a
 * session (dev cookie, or the SSO subject header an authenticating proxy sets). Route
 * handlers still resolve and authorise the actor themselves via `handle()`; this layer
 * exists so a route that forgets to is closed rather than open.
 */
import { NextResponse, type NextRequest } from "next/server";

const DEV_COOKIE = "crosswalk_dev_user";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();
  const hasSession = Boolean(req.cookies.get(DEV_COOKIE)?.value) || Boolean(req.headers.get("x-sso-subject"));
  if (!hasSession) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };

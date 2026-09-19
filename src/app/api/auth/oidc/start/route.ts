import { NextResponse, type NextRequest } from "next/server";
import { ssoMode, oidcConfig, beginSignIn, sealCookie, OIDC_STATE_COOKIE } from "@/lib/auth/oidc";
import { authErrorResponse } from "@/lib/auth";
import { log } from "@/lib/log";

/** Begin an OIDC sign-in: `?next=/path` is where the browser lands afterwards (same-origin paths only). */
export async function GET(req: NextRequest) {
  if (ssoMode() !== "oidc") return NextResponse.json({ error: "SSO sign-in is not enabled" }, { status: 404 });
  try {
    const cfg = oidcConfig();
    const { url, state } = await beginSignIn(cfg, req.nextUrl.searchParams.get("next"));
    const res = NextResponse.redirect(url, { status: 302 });
    res.cookies.set(OIDC_STATE_COOKIE, sealCookie(state), { httpOnly: true, sameSite: "lax", path: "/api/auth/oidc", secure: process.env.NODE_ENV === "production", maxAge: 600 });
    return res;
  } catch (e) {
    log.warn("oidc.start.failed", { error: (e as Error).message });
    return authErrorResponse(e) ?? NextResponse.json({ error: "Could not start sign-in" }, { status: 502 });
  }
}

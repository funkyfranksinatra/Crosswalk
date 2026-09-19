import { NextResponse, type NextRequest } from "next/server";
import { ssoMode, oidcConfig, beginSignIn, sealCookie, cookiesSecure, OIDC_STATE_COOKIE } from "@/lib/auth/oidc";
import { AuthError } from "@/lib/auth";
import { log } from "@/lib/log";
import { signInFailedPage } from "@/lib/auth/oidc-page";

/** Begin an OIDC sign-in: `?next=/path` is where the browser lands afterwards (same-origin paths only). */
export async function GET(req: NextRequest) {
  if (ssoMode() !== "oidc") return NextResponse.json({ error: "SSO sign-in is not enabled" }, { status: 404 });
  try {
    const cfg = oidcConfig();
    const { url, state } = await beginSignIn(cfg, req.nextUrl.searchParams.get("next"));
    const res = NextResponse.redirect(url, { status: 302 });
    res.cookies.set(OIDC_STATE_COOKIE, sealCookie(state), { httpOnly: true, sameSite: "lax", path: "/api/auth/oidc", secure: cookiesSecure(), maxAge: 600 });
    return res;
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 502;
    log.warn("oidc.start.failed", { status, error: (e as Error).message });
    // A browser navigation lands here: answer with a page, not JSON. Configuration mistakes are logged, not shown.
    return signInFailedPage(e instanceof AuthError && status < 500 ? e.message : "Sign-in could not be started. The identity provider or its configuration is not reachable; the server log has the reason.", status);
  }
}

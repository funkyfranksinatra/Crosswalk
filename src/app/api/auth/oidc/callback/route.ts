import { NextResponse, type NextRequest } from "next/server";
import { ssoMode, oidcConfig, completeSignIn, resolveUser, issueSession, openCookie, appOrigin, cookiesSecure, OIDC_STATE_COOKIE, SESSION_COOKIE, type StartState } from "@/lib/auth/oidc";
import { AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";
import { signInFailedPage } from "@/lib/auth/oidc-page";

/**
 * The provider sends the browser back here with `code` + `state`. On success the session
 * cookie is set and the browser is redirected to the page it started from; on failure a small
 * HTML page explains why (a JSON body would be unreadable in a browser tab) and the state
 * cookie is cleared so the next attempt starts clean.
 */
export async function GET(req: NextRequest) {
  if (ssoMode() !== "oidc") return NextResponse.json({ error: "SSO sign-in is not enabled" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const rawState = req.cookies.get(OIDC_STATE_COOKIE)?.value;
  const stored = openCookie<StartState>(rawState);
  const clear = (res: NextResponse) => { res.cookies.set(OIDC_STATE_COOKIE, "", { maxAge: 0, path: "/api/auth/oidc" }); return res; };
  try {
    if (!rawState) throw new AuthError(`The sign-in state cookie did not come back. The app is served at ${appOrigin()}; if you reached it another way, or over plain HTTP while APP_BASE_URL is https, the browser drops the cookie. Start again from ${appOrigin()}.`, 401);
    const cfg = oidcConfig();
    const { identity, next } = await completeSignIn(cfg, { code: q.get("code"), state: q.get("state"), error: q.get("error"), errorDescription: q.get("error_description") }, stored);
    const { userId, created, rolesSynced } = await resolveUser(cfg, identity);
    const session = issueSession(userId, identity.subject, cfg.sessionHours);
    // Redirect on the public origin, never the request's (a TLS-terminating proxy makes that http).
    const res = clear(NextResponse.redirect(new URL(next, appOrigin() + "/"), { status: 302 }));
    res.cookies.set(SESSION_COOKIE, session.value, { httpOnly: true, sameSite: "lax", path: "/", secure: cookiesSecure(), expires: session.expires });
    await audit({ actorUserId: userId, entityType: "User", entityId: userId, action: "SSO_SIGN_IN", context: { issuer: cfg.issuer, created, rolesSynced, roles: identity.roles } });
    log.info("oidc.signin", { userId, created, rolesSynced });
    return res;
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    const message = e instanceof AuthError ? e.message : "Sign-in failed";
    log.warn("oidc.callback.failed", { status, error: (e as Error).message });
    return clear(signInFailedPage(message, status));
  }
}

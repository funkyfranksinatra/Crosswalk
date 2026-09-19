import { NextResponse, type NextRequest } from "next/server";
import { ssoMode, oidcConfig, completeSignIn, resolveUser, issueSession, openCookie, OIDC_STATE_COOKIE, SESSION_COOKIE, type StartState } from "@/lib/auth/oidc";
import { AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";

/**
 * The provider sends the browser back here with `code` + `state`. On success the session
 * cookie is set and the browser is redirected to the page it started from; on failure a small
 * HTML page explains why (a JSON body would be unreadable in a browser tab) and the state
 * cookie is cleared so the next attempt starts clean.
 */
export async function GET(req: NextRequest) {
  if (ssoMode() !== "oidc") return NextResponse.json({ error: "SSO sign-in is not enabled" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const stored = openCookie<StartState>(req.cookies.get(OIDC_STATE_COOKIE)?.value);
  const clear = (res: NextResponse) => { res.cookies.set(OIDC_STATE_COOKIE, "", { maxAge: 0, path: "/api/auth/oidc" }); return res; };
  try {
    const cfg = oidcConfig();
    const { identity, next } = await completeSignIn(cfg, { code: q.get("code"), state: q.get("state"), error: q.get("error"), errorDescription: q.get("error_description") }, stored);
    const { userId, created, rolesSynced } = await resolveUser(cfg, identity);
    const session = issueSession(userId, identity.subject, cfg.sessionHours);
    const res = clear(NextResponse.redirect(new URL(next, req.nextUrl.origin), { status: 302 }));
    res.cookies.set(SESSION_COOKIE, session.value, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production", expires: session.expires });
    await audit({ actorUserId: userId, entityType: "User", entityId: userId, action: "SSO_SIGN_IN", context: { issuer: cfg.issuer, created, rolesSynced, roles: identity.roles } });
    log.info("oidc.signin", { userId, created, rolesSynced });
    return res;
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    const message = e instanceof AuthError ? e.message : "Sign-in failed";
    log.warn("oidc.callback.failed", { status, error: (e as Error).message });
    const html = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:15px system-ui;max-width:32rem;margin:4rem auto;color:#222"><h1 style="font-size:20px">Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="/api/auth/oidc/start">Try again</a></p></body>`;
    return clear(new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  }
}

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

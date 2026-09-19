import { NextResponse, type NextRequest } from "next/server";
import { ssoMode, oidcConfig, logoutUrl, readSession, SESSION_COOKIE } from "@/lib/auth/oidc";
import { audit } from "@/lib/audit";

/** POST (from the sidebar) clears the session and answers with where to send the browser next. */
export async function POST(req: NextRequest) {
  if (ssoMode() !== "oidc") return NextResponse.json({ error: "SSO sign-in is not enabled" }, { status: 404 });
  const userId = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  const redirect = (await logoutUrl(oidcConfig())) ?? "/";
  const res = NextResponse.json({ ok: true, redirect });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  if (userId) await audit({ actorUserId: userId, entityType: "User", entityId: userId, action: "SSO_SIGN_OUT" });
  return res;
}

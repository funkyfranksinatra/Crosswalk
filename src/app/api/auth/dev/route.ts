import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEV_COOKIE, ssoConfigured, signSession } from "@/lib/auth";
import { audit } from "@/lib/audit";

/**
 * Development sign-in: pick a seeded user. Disabled when SSO is configured, and refused in a
 * production build unless ALLOW_DEV_SIGNIN=true is set deliberately (a demo box) — a
 * production deployment without SSO must not let anyone become any user.
 */
function devSignInAllowed(): string | null {
  if (ssoConfigured()) return "SSO is configured; development sign-in is disabled";
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_SIGNIN !== "true") return "Development sign-in is disabled in production (set ALLOW_DEV_SIGNIN=true only on a demo instance)";
  return null;
}

export async function GET() {
  const blocked = devSignInAllowed();
  if (blocked) return NextResponse.json({ error: blocked }, { status: 404 });
  const users = await prisma.user.findMany({ where: { isActive: true }, include: { roles: true }, orderBy: { name: "asc" } });
  return NextResponse.json(users.map((u) => ({ id: u.id, name: u.name, email: u.email, roles: u.roles.map((r) => r.role) })));
}
export async function POST(req: Request) {
  const blocked = devSignInAllowed();
  if (blocked) return NextResponse.json({ error: blocked }, { status: 404 });
  const { userId } = (await req.json()) as { userId?: string };
  const u = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!u) return NextResponse.json({ error: "unknown user" }, { status: 400 });
  const res = NextResponse.json({ ok: true, name: u.name });
  res.cookies.set(DEV_COOKIE, signSession(u.id), { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  await audit({ actorUserId: u.id, entityType: "User", entityId: u.id, action: "DEV_SIGN_IN" });
  return res;
}
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DEV_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}

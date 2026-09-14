import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEV_COOKIE, ssoConfigured } from "@/lib/auth";
import { audit } from "@/lib/audit";

/** Development sign-in: pick a seeded user. Disabled when SSO is configured. */
export async function GET() {
  if (ssoConfigured()) return NextResponse.json({ error: "SSO is configured; development sign-in is disabled" }, { status: 404 });
  const users = await prisma.user.findMany({ where: { isActive: true }, include: { roles: true }, orderBy: { name: "asc" } });
  return NextResponse.json(users.map((u) => ({ id: u.id, name: u.name, email: u.email, roles: u.roles.map((r) => r.role) })));
}
export async function POST(req: Request) {
  if (ssoConfigured()) return NextResponse.json({ error: "SSO is configured; development sign-in is disabled" }, { status: 404 });
  const { userId } = (await req.json()) as { userId?: string };
  const u = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!u) return NextResponse.json({ error: "unknown user" }, { status: 400 });
  const res = NextResponse.json({ ok: true, name: u.name });
  res.cookies.set(DEV_COOKIE, u.id, { httpOnly: true, sameSite: "lax", path: "/" });
  await audit({ actorUserId: u.id, entityType: "User", entityId: u.id, action: "DEV_SIGN_IN" });
  return res;
}
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DEV_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}

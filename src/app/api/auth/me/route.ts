import { NextResponse } from "next/server";
import { getActor, ssoConfigured } from "@/lib/auth";

export async function GET() {
  const a = await getActor();
  return NextResponse.json({ actor: a ? { id: a.id, name: a.name, email: a.email, roles: a.roles, permissions: [...a.permissions], isDev: a.isDev } : null, sso: ssoConfigured() });
}

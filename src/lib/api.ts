/**
 * Route-handler plumbing: resolve the actor, enforce a permission, serialize
 * Decimals, turn domain/auth errors into JSON. Every enterprise API route uses this.
 */
import { NextResponse } from "next/server";
import { getActor, AuthError, type Actor } from "@/lib/auth";
import type { Permission } from "@/lib/auth/permissions";
import { plain } from "@/lib/serialize";

export async function handle<T>(perm: Permission | null, fn: (actor: Actor) => Promise<T>): Promise<Response> {
  try {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    if (perm && !actor.permissions.has(perm)) return NextResponse.json({ error: `Missing permission: ${perm}` }, { status: 403 });
    const out = await fn(actor);
    return NextResponse.json(plain(out ?? { ok: true }));
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(msg) ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { return {} as T; }
}

export const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const date = (v: unknown): Date | null => { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };

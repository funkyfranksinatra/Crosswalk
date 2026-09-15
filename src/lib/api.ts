/**
 * Route-handler plumbing: resolve the actor, enforce a permission, serialize
 * Decimals, turn domain/auth errors into JSON. Every enterprise API route uses this.
 */
import { NextResponse } from "next/server";
import { getActor, AuthError, type Actor } from "@/lib/auth";
import type { Permission } from "@/lib/auth/permissions";
import { plain } from "@/lib/serialize";
import { money } from "@/lib/money";

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

/**
 * For handlers that return something other than JSON (files, CSV): resolve and authorise the
 * actor, or hand back the error response to return as-is.
 */
export async function authorize(perm: Permission | null): Promise<{ actor: Actor; deny: null } | { actor: null; deny: Response }> {
  const actor = await getActor();
  if (!actor) return { actor: null, deny: NextResponse.json({ error: "Sign in required" }, { status: 401 }) };
  if (perm && !actor.permissions.has(perm)) return { actor: null, deny: NextResponse.json({ error: `Missing permission: ${perm}` }, { status: 403 }) };
  return { actor, deny: null };
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { return {} as T; }
}

/** Small validators for route bodies — invalid input is a 400, never a 500 or a silent default. */
export const CURRENCY = /^[A-Z]{3}$/;
export function requireText(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required`);
  if (v.length > max) throw new Error(`${field} is too long (max ${max})`);
  return v.trim();
}
export function optText(v: unknown, field: string, max = 2000): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw new Error(`${field} must be text`);
  if (v.length > max) throw new Error(`${field} is too long (max ${max})`);
  return v;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (v === undefined || v === null || v === "") { if (fallback !== undefined) return fallback; throw new Error(`${field} is required`); }
  if (!allowed.includes(v as T)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return v as T;
}
export function currencyCode(v: unknown, fallback = "USD"): string {
  if (v === undefined || v === null || v === "") return fallback;
  const c = String(v).toUpperCase();
  if (!CURRENCY.test(c)) throw new Error(`currency "${String(v)}" is not a 3-letter code`);
  return c;
}
export function positiveMoney(v: unknown, field: string, max = "1000000000") {
  const d = money(v as never);
  if (d === null) throw new Error(`${field} must be a number`);
  if (d.lte(0)) throw new Error(`${field} must be positive`);
  if (d.gt(max)) throw new Error(`${field} exceeds the supported range`);
  return d;
}
export function nonNegativeMoney(v: unknown, field: string) {
  if (v === undefined || v === null || v === "") return null;
  const d = money(v as never);
  if (d === null) throw new Error(`${field} must be a number`);
  if (d.lt(0)) throw new Error(`${field} cannot be negative`);
  return d;
}

export const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const date = (v: unknown): Date | null => { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };

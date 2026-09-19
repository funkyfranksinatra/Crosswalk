/**
 * Route-handler plumbing: resolve the actor, enforce a permission, serialize
 * Decimals, turn domain/auth errors into JSON. Every enterprise API route uses this.
 */
import { NextResponse } from "next/server";
import { getActor, AuthError, type Actor } from "@/lib/auth";
import type { Permission } from "@/lib/auth/permissions";
import { plain } from "@/lib/serialize";
import { money } from "@/lib/money";
import { headers } from "next/headers";
import { log, withRequestContext, setContextActor } from "@/lib/log";
import { httpRequests, httpDuration } from "@/lib/observability/metrics";
import { enforceScopeForPath } from "@/lib/auth/scope";

/**
 * The request path the proxy recorded (null outside a request or when the proxy did not run).
 * The proxy runs for every /api request; its absence on one is logged, because scoping keys
 * off this header and a front proxy that strips it would open the detail routes.
 */
async function requestPath(): Promise<string | null> {
  try {
    const h = await headers();
    const p = h.get("x-crosswalk-path");
    if (!p && !process.env.VITEST) log.warn("api.no_path_header", { route: h.get("x-crosswalk-route") ?? null });
    return p;
  } catch { return null; }
}

/** The request id the proxy assigned (or null outside a request). */
export async function requestId(): Promise<string | null> {
  try { return (await headers()).get("x-request-id"); } catch { return null; }
}

async function routeLabel(): Promise<string> {
  // The pathname with ids collapsed, so metrics have bounded cardinality.
  try { return (await headers()).get("x-crosswalk-route") || "api"; } catch { return "api"; }
}

/**
 * Wrap a route: actor, permission, JSON, errors — plus a request-scoped log context and a
 * metrics sample. `perm` null = any signed-in user.
 */
export async function handle<T>(perm: Permission | null, fn: (actor: Actor) => Promise<T>): Promise<Response> {
  const rid = await requestId();
  const route = await routeLabel();
  const t0 = Date.now();
  return withRequestContext({ requestId: rid ?? undefined, route }, async () => {
    let status = 200;
    try {
      const actor = await getActor();
      if (!actor) { status = 401; return NextResponse.json({ error: "Sign in required" }, { status }); }
      setContextActor(actor.id);
      if (perm && !actor.permissions.has(perm)) { status = 403; return NextResponse.json({ error: `Missing permission: ${perm}` }, { status }); }
      // Ownership scoping (Tier 0.2): a detail route on an account / request / proposal / contract the
      // actor may not see is a 404 here, before the handler runs — every route, present and future.
      await enforceScopeForPath(actor, await requestPath());
      const out = await fn(actor);
      return NextResponse.json(plain(out ?? { ok: true }));
    } catch (e) {
      if (e instanceof AuthError) { status = e.status; return NextResponse.json({ error: e.message }, { status }); }
      const msg = publicErrorMessage(e);
      status = /not found/i.test(msg) ? 404 : /already|changed|decided by someone|being submitted|conflict/i.test(msg) ? 409 : 400;
      return NextResponse.json({ error: msg }, { status });
    } finally {
      const ms = Date.now() - t0;
      httpRequests.inc({ route, status });
      httpDuration.observe({ route }, ms / 1000);
      log[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]("api.request", { status, ms, perm: perm ?? null });
    }
  });
}

/**
 * What a client may see of an error. Domain errors are plain sentences and pass through; a
 * database/driver error would carry the query, file paths and column names — those are logged
 * server-side and replaced with a generic message.
 */
export function publicErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.constructor.name : "";
  if (/^Prisma/.test(name) || /Invalid `prisma\.|Invalid `__TURBOPACK|invocation in\n|PrismaClient/i.test(msg) || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection terminated|Connection terminated/i.test(msg)) {
    console.error("[api]", e);
    if (/Unique constraint/i.test(msg)) return "That record already exists (a unique value is taken)";
    if (/Foreign key constraint/i.test(msg)) return "That change would break a link to another record";
    if (/numeric field overflow/i.test(msg)) return "A value is out of the supported numeric range";
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|terminated/i.test(msg)) return "The database is unreachable right now; try again";
    if (/not found|No record/i.test(msg)) return "not found";
    return "The request could not be completed (database error; see server log)";
  }
  return msg.split("\n")[0].slice(0, 500);
}

/**
 * For handlers that return something other than JSON (files, CSV): resolve and authorise the
 * actor, or hand back the error response to return as-is.
 */
export async function authorize(perm: Permission | null): Promise<{ actor: Actor; deny: null } | { actor: null; deny: Response }> {
  const actor = await getActor();
  if (!actor) return { actor: null, deny: NextResponse.json({ error: "Sign in required" }, { status: 401 }) };
  if (perm && !actor.permissions.has(perm)) return { actor: null, deny: NextResponse.json({ error: `Missing permission: ${perm}` }, { status: 403 }) };
  try { await enforceScopeForPath(actor, await requestPath()); } catch (e) { if (e instanceof AuthError) return { actor: null, deny: NextResponse.json({ error: e.message }, { status: e.status }) }; throw e; }
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

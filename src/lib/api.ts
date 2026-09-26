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
/**
 * Test seam (Vitest only, like setActorForTests): the headers the proxy would have forwarded,
 * so route handlers called in-process run the ownership-scope hook against a real path.
 */
let testHeaders: Headers | null = null;
export function setRequestHeadersForTests(h: Headers | Record<string, string> | null) {
  if (!process.env.VITEST || process.env.NODE_ENV === "production") throw new Error("setRequestHeadersForTests is only available under Vitest");
  testHeaders = h === null ? null : h instanceof Headers ? h : new Headers(h);
}
async function requestHeaders(): Promise<Headers> {
  if (testHeaders && process.env.VITEST && process.env.NODE_ENV !== "production") return testHeaders;
  return headers();
}

async function requestPath(): Promise<string | null> {
  try {
    const h = await requestHeaders();
    const p = h.get("x-crosswalk-path");
    if (!p && !process.env.VITEST) log.warn("api.no_path_header", { route: h.get("x-crosswalk-route") ?? null });
    return p;
  } catch { return null; }
}

/** The request id the proxy assigned (or null outside a request). */
export async function requestId(): Promise<string | null> {
  try { return (await requestHeaders()).get("x-request-id"); } catch { return null; }
}

async function routeLabel(): Promise<string> {
  // The pathname with ids collapsed, so metrics have bounded cardinality.
  try { return (await requestHeaders()).get("x-crosswalk-route") || "api"; } catch { return "api"; }
}

/**
 * A route's permission requirement: one permission, or a list of which the actor needs ANY
 * (e.g. the crosswalk review queue is readable by pricing roles and by the reviewers who hold
 * no pricing permission). `null` = any signed-in user.
 */
export type PermissionRequirement = Permission | readonly Permission[] | null;

/** The permission the actor lacks, or null when the requirement is met. */
export function missingPermission(actor: Actor, perm: PermissionRequirement): Permission | null {
  if (!perm) return null;
  if (typeof perm === "string") return actor.permissions.has(perm) ? null : perm;
  if (perm.length === 0) return null;
  return perm.some((p) => actor.permissions.has(p)) ? null : perm[0];
}
const permLabel = (perm: PermissionRequirement) => (typeof perm === "string" ? perm : perm ? perm.join(" | ") : "");

/**
 * Wrap a route: actor, permission, JSON, errors — plus a request-scoped log context and a
 * metrics sample. `perm` null = any signed-in user; a list = any of them.
 */
export async function handle<T>(perm: PermissionRequirement, fn: (actor: Actor) => Promise<T>): Promise<Response> {
  const rid = await requestId();
  const route = await routeLabel();
  const t0 = Date.now();
  return withRequestContext({ requestId: rid ?? undefined, route }, async () => {
    let status = 200;
    try {
      const actor = await getActor();
      if (!actor) { status = 401; return NextResponse.json({ error: "Sign in required" }, { status }); }
      setContextActor(actor.id);
      if (missingPermission(actor, perm)) { status = 403; return NextResponse.json({ error: `Missing permission: ${permLabel(perm)}` }, { status }); }
      // Ownership scoping (Tier 0.2): a detail route on an account / request / proposal / contract the
      // actor may not see is a 404 here, before the handler runs — every route, present and future.
      await enforceScopeForPath(actor, await requestPath());
      const out = await fn(actor);
      return NextResponse.json(plain(out ?? { ok: true }));
    } catch (e) {
      if (e instanceof AuthError) { status = e.status; return NextResponse.json({ error: e.message }, { status }); }
      const mapped = errorResponse(e);
      status = mapped.status;
      return NextResponse.json({ error: mapped.message }, { status });
    } finally {
      const ms = Date.now() - t0;
      httpRequests.inc({ route, status });
      httpDuration.observe({ route }, ms / 1000);
      log[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]("api.request", { status, ms, perm: perm ?? null });
    }
  });
}

const isDbError = (e: unknown, msg: string, name: string) =>
  /^Prisma/.test(name) || /Invalid `prisma\.|Invalid `__TURBOPACK|invocation in\n|PrismaClient/i.test(msg) || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection terminated|Connection terminated/i.test(msg);
/** A JavaScript runtime fault (a bug), as opposed to a domain error thrown on purpose with `new Error("…")`. */
const isRuntimeFault = (e: unknown) => e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError;

/**
 * What a client may see of an error. Domain errors are plain sentences and pass through; a
 * database/driver error would carry the query, file paths and column names — those are logged
 * server-side and replaced with a generic message.
 */
export function publicErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (isDbError(e, msg, e instanceof Error ? e.constructor.name : "")) return errorResponse(e).message;
  return msg.split("\n")[0].slice(0, 500);
}

/**
 * Status + message for an error that escaped a handler. Domain errors (a plain `Error` with a
 * sentence) are the caller's fault: 404 for "not found", 409 for a state conflict, else 400.
 * Anything else is OUR fault and must say so with a 500 — a driver failure, an unmapped Prisma
 * error, or a runtime fault (TypeError & co.) — with a generic message; the detail goes to the
 * server log with the stack. Mapping those to 400 would hide server bugs behind "bad request".
 */
export function errorResponse(e: unknown): { status: number; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.constructor.name : "";
  if (isDbError(e, msg, name)) {
    // a "not found" from findUniqueOrThrow is an ordinary 404, not an incident
    if (!/not found|No record/i.test(msg)) console.error("[api]", e);
    if (/Unique constraint/i.test(msg)) return { status: 409, message: "That record already exists (a unique value is taken)" };
    if (/Foreign key constraint/i.test(msg)) return { status: 400, message: "That change would break a link to another record" };
    if (/numeric field overflow/i.test(msg)) return { status: 400, message: "A value is out of the supported numeric range" };
    if (/invalid byte sequence for encoding/i.test(msg)) return { status: 400, message: "Text contains characters that cannot be stored (control characters)" };
    if (/value too long for type/i.test(msg)) return { status: 400, message: "A value is too long for its field" };
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|terminated/i.test(msg)) return { status: 503, message: "The database is unreachable right now; try again" };
    if (/not found|No record/i.test(msg)) return { status: 404, message: "not found" };
    return { status: 500, message: "The request could not be completed (database error; see server log)" };
  }
  if (isRuntimeFault(e)) {
    // A body the runtime could not parse is the client's doing, not ours.
    if (/FormData|multipart|JSON|Unexpected token|Unexpected end of JSON/i.test(msg)) return { status: 400, message: "Malformed request body" };
    console.error("[api] runtime fault", e);
    return { status: 500, message: "The request could not be completed (internal error; see server log)" };
  }
  const message = msg.split("\n")[0].slice(0, 500);
  const status = /not found/i.test(message) ? 404 : /already|changed|decided by someone|being submitted|conflict/i.test(message) ? 409 : 400;
  return { status, message };
}

/**
 * For handlers that return something other than JSON (files, CSV): resolve and authorise the
 * actor, or hand back the error response to return as-is.
 */
export async function authorize(perm: PermissionRequirement): Promise<{ actor: Actor; deny: null } | { actor: null; deny: Response }> {
  const actor = await getActor();
  if (!actor) return { actor: null, deny: NextResponse.json({ error: "Sign in required" }, { status: 401 }) };
  if (missingPermission(actor, perm)) return { actor: null, deny: NextResponse.json({ error: `Missing permission: ${permLabel(perm)}` }, { status: 403 }) };
  try { await enforceScopeForPath(actor, await requestPath()); } catch (e) { if (e instanceof AuthError) return { actor: null, deny: NextResponse.json({ error: e.message }, { status: e.status }) }; throw e; }
  return { actor, deny: null };
}

/** The JSON object body, or `{}` when the body is missing, unparsable, or not an object (null, a number, a list): validation then reports the missing fields. */
export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { const v: unknown = await req.json(); return (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as T; } catch { return {} as T; }
}

/** A multipart / urlencoded form body, or null when the request carried something else (the caller answers 400). */
export async function formBody(req: Request): Promise<FormData | null> {
  try { return await req.formData(); } catch { return null; }
}
export const badRequest = (error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status: 400 });

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
/** Decimal.js also reads hex / binary / octal ("0x10" = 16) and locale digits: a money string must be plain decimal notation. */
const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function strictMoney(v: unknown) {
  if (typeof v === "string" && !PLAIN_DECIMAL.test(v.trim())) return null;
  if (typeof v !== "string" && typeof v !== "number" && !(v && typeof v === "object" && "isFinite" in (v as object))) return null;
  return money(v as never);
}
export function positiveMoney(v: unknown, field: string, max = "1000000000") {
  const d = strictMoney(v);
  if (d === null) throw new Error(`${field} must be a number`);
  if (d.lte(0)) throw new Error(`${field} must be positive`);
  if (d.gt(max)) throw new Error(`${field} exceeds the supported range`);
  return d;
}
export function nonNegativeMoney(v: unknown, field: string, max = "1000000000000") {
  if (v === undefined || v === null || v === "") return null;
  const d = strictMoney(v);
  if (d === null) throw new Error(`${field} must be a number`);
  if (d.lt(0)) throw new Error(`${field} cannot be negative`);
  if (d.gt(max)) throw new Error(`${field} exceeds the supported range`);
  return d;
}

export const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const date = (v: unknown): Date | null => { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };

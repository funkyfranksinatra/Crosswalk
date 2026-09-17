/**
 * Structured logging. One JSON object per line on stdout (`LOG_FORMAT=json`, the default
 * outside `next dev`) or a readable line (`LOG_FORMAT=pretty`), so the company's log
 * shipper (Datadog agent, Fluent Bit, CloudWatch…) can pick the stream up unchanged.
 *
 * Every line carries the request id when one is in scope (set by `withRequestContext`
 * in src/lib/api.ts from the `x-request-id` header the proxy assigns), so an API call,
 * its model calls and its audit rows can be joined in the log store.
 *
 * Nothing here is ever allowed to throw — logging failures must not break a request.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Ctx = { requestId: string; actorId?: string | null; route?: string | null };
const storage = new AsyncLocalStorage<Ctx>();

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

export function withRequestContext<T>(ctx: { requestId?: string | null; actorId?: string | null; route?: string | null }, fn: () => T): T {
  const requestId = ctx.requestId || newRequestId();
  return storage.run({ requestId, actorId: ctx.actorId ?? null, route: ctx.route ?? null }, fn);
}

export function setContextActor(actorId: string | null) {
  const s = storage.getStore();
  if (s) s.actorId = actorId;
}

export function newRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

function minLevel(): number {
  const l = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[l] ?? LEVELS.info;
}

function format(): "json" | "pretty" {
  const f = process.env.LOG_FORMAT?.toLowerCase();
  if (f === "json" || f === "pretty") return f;
  return process.env.NODE_ENV === "production" ? "json" : "pretty";
}

/** Keys whose values must never reach a log line, whatever module passes them. */
const SECRET_KEY = /(password|secret|token|api[_-]?key|authorization|cookie|connection[_-]?string|database[_-]?url)/i;

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) { out[k] = "[redacted]"; continue; }
    if (v instanceof Error) { out[k] = { message: v.message, name: v.name, stack: process.env.NODE_ENV === "production" ? undefined : v.stack?.split("\n").slice(0, 4).join("\n") }; continue; }
    if (typeof v === "string" && v.length > 2000) { out[k] = v.slice(0, 2000) + "…"; continue; }
    out[k] = v;
  }
  return out;
}

const listeners = new Set<(line: Record<string, unknown>) => void>();
/** Test hook / in-process tail: receive every emitted line. Returns an unsubscribe function. */
export function onLog(fn: (line: Record<string, unknown>) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(level: Level, event: string, fields: Record<string, unknown>) {
  try {
    if (LEVELS[level] < minLevel()) return;
    const ctx = storage.getStore();
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level, event, ...(ctx?.requestId ? { requestId: ctx.requestId } : {}), ...(ctx?.actorId ? { actorId: ctx.actorId } : {}), ...(ctx?.route ? { route: ctx.route } : {}), ...scrub(fields) };
    for (const l of listeners) { try { l(line); } catch { /* listener errors never surface */ } }
    if (process.env.LOG_SILENT === "true") return;
    if (format() === "json") {
      (level === "error" ? process.stderr : process.stdout).write(JSON.stringify(line) + "\n");
    } else {
      const { ts, level: lv, event: ev, requestId, ...rest } = line;
      const tail = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
      (lv === "error" ? process.stderr : process.stdout).write(`${String(ts).slice(11, 19)} ${String(lv).toUpperCase().padEnd(5)} ${ev}${requestId ? ` [${requestId}]` : ""}${tail}\n`);
    }
  } catch {
    /* never throw from a logger */
  }
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => emit("debug", event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
};

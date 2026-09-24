/**
 * Small, strict readers for the environment (docs/BUILD_NOTES.md §5). Every numeric setting has a
 * default and bounds; a malformed value never becomes NaN inside a connection pool or a timer —
 * it falls back to the default and is logged once (`env.invalid`). Booleans are only ever the
 * literal `true` / `false` (case-insensitive): "on", "yes" and "1" are not true, so a typo cannot
 * silently switch a safety setting.
 */
import { log } from "@/lib/log";

type Env = Record<string, string | undefined>;
const warned = new Set<string>();
function invalid(name: string, raw: string, why: string, fallback: unknown) {
  const key = `${name}=${raw}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn("env.invalid", { name, value: raw.slice(0, 40), problem: why, using: fallback });
}

/** An integer with a default and inclusive bounds; out-of-range or non-numeric → default. */
export function intEnv(name: string, def: number, opts: { min?: number; max?: number } = {}, env: Env = process.env): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) { invalid(name, raw, "not a whole number", def); return def; }
  if (opts.min !== undefined && n < opts.min) { invalid(name, raw, `below the minimum ${opts.min}`, def); return def; }
  if (opts.max !== undefined && n > opts.max) { invalid(name, raw, `above the maximum ${opts.max}`, def); return def; }
  return n;
}

/** Only "true"/"false" count; anything else is the default (and logged). */
export function boolEnv(name: string, def: boolean, env: Env = process.env): boolean {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return def;
  const v = raw.toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  invalid(name, raw, 'not "true" or "false"', def);
  return def;
}

/** One of a closed list of words (case-insensitive); anything else is the default (and logged). */
export function enumEnv<T extends string>(name: string, values: readonly T[], def: T, env: Env = process.env): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return def;
  const hit = values.find((v) => v.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  invalid(name, raw, `not one of ${values.join(" | ")}`, def);
  return def;
}

/** Test seam: forget which values were already warned about. */
export function resetEnvWarningsForTests() { warned.clear(); }

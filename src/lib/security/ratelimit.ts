/**
 * Request rate limiting (Tier 0.5) — fixed-window counters per client and route class, kept
 * in process memory. Enough to blunt credential stuffing on the sign-in routes and a runaway
 * client on the API; a multi-instance deployment gets one window per instance (documented in
 * docs/DEPLOYMENT.md — put a shared limiter at the load balancer when that matters).
 *
 * Route classes and defaults (requests per minute per client):
 *   auth     /api/auth/*                                     RATE_LIMIT_AUTH      20
 *   heavy    uploads, pipeline runs, imports, exports, pulls  RATE_LIMIT_HEAVY     60
 *   api      everything else under /api                      RATE_LIMIT_API       600
 * Plus a per-instance ceiling per class (RATE_LIMIT_GLOBAL_FACTOR × the client limit) so spoofed
 * client addresses cannot buy unlimited attempts. RATE_LIMIT_DISABLED=true turns it off (load
 * tests). Pure functions; the proxy wires it.
 */

type Env = Record<string, string | undefined>;

export type RouteClass = "auth" | "heavy" | "api";

const HEAVY = /^\/api\/(requests\/[^/]+\/(run|bulk|export|sheets)|requests$|(pricing|costs|purchases|competitor-sizes|intelligence|intelligence\/bids)\/import|catalog\/(add|enrich|gudid(\/(plan|adopt|prune))?)|integrations\/sync|feeds|observability\/export|proposals\/[^/]+\/(export|refresh-context))(\/|$)/i;

/** Reads are never heavy except the file exports; the write side of the same path is. */
export function classify(pathname: string, method = "GET"): RouteClass {
  if (pathname.startsWith("/api/auth/")) return "auth";
  if (HEAVY.test(pathname) && (method.toUpperCase() !== "GET" || /\/(export|sheets)(\/|$)/.test(pathname))) return "heavy";
  return "api";
}

export type Limits = Record<RouteClass, number>;
export function limitsFromEnv(env: Env = process.env): Limits | null {
  if ((env.RATE_LIMIT_DISABLED ?? "").toLowerCase() === "true") return null;
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
  return { auth: n("RATE_LIMIT_AUTH", 20), heavy: n("RATE_LIMIT_HEAVY", 60), api: n("RATE_LIMIT_API", 600) };
}

/**
 * Which address counts as the client. Next fills X-Forwarded-For with the socket peer when the
 * request carried none, so with no proxy the LAST entry is the peer — unless the client sent
 * the header itself, in which case a spoofer gets a bucket of their own (never someone else's;
 * the per-instance ceiling below still bounds them). Behind a load balancer the peer is the
 * balancer: set TRUST_PROXY_HOPS to how many proxies append to the header (1 = one balancer)
 * and the client is that entry from the end.
 */
export function clientKey(headers: Headers, env: Env = process.env): string {
  const hops = Math.max(1, Number(env.TRUST_PROXY_HOPS ?? 1) || 1);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const pick = parts[Math.max(0, parts.length - hops)];
    if (pick) return pick.slice(0, 64);
  }
  return headers.get("x-real-ip")?.slice(0, 64) || "unknown";
}

/**
 * Per-instance ceiling per class regardless of client (RATE_LIMIT_GLOBAL_FACTOR × the per-client
 * limit, default 20×): bounds a flood of spoofed client addresses.
 */
export function globalFactor(env: Env = process.env): number {
  const n = Number(env.RATE_LIMIT_GLOBAL_FACTOR ?? 20);
  return Number.isFinite(n) && n >= 1 ? n : 20;
}

export type Decision = { allowed: boolean; limit: number; remaining: number; resetAt: number };

type Bucket = { count: number; windowStart: number };
const WINDOW_MS = 60_000;

const MAX_BUCKETS = 100_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  constructor(private limits: Limits, private now: () => number = Date.now, private factor = globalFactor()) {}

  hit(client: string, cls: RouteClass): Decision {
    const t = this.now();
    if (t - this.lastSweep > WINDOW_MS) this.sweep(t);
    const limit = this.limits[cls];
    // The instance-wide window for the class first: a flood cannot dodge it by inventing clients.
    const g = this.bump(`${cls}:*`, t);
    const b = this.bump(`${cls}:${client}`, t);
    const allowed = b.count <= limit && g.count <= limit * this.factor;
    return { allowed, limit, remaining: Math.max(0, limit - b.count), resetAt: b.windowStart + WINDOW_MS };
  }

  private bump(key: string, t: number): Bucket {
    let b = this.buckets.get(key);
    if (!b || t - b.windowStart >= WINDOW_MS) {
      if (!b && this.buckets.size >= MAX_BUCKETS) this.evictOldest();
      b = { count: 0, windowStart: t }; this.buckets.set(key, b);
    }
    b.count += 1;
    return b;
  }

  /** Drop windows that have ended; bounded memory whatever the client churn. */
  private sweep(t: number) {
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (t - b.windowStart >= WINDOW_MS) this.buckets.delete(k);
  }
  /** Under a flood of new clients, forget the oldest windows rather than everyone's counters. */
  private evictOldest() {
    let n = Math.ceil(MAX_BUCKETS / 10);
    for (const k of this.buckets.keys()) { if (k.endsWith(":*")) continue; this.buckets.delete(k); if (--n <= 0) break; }
  }
  get size() { return this.buckets.size; }
}

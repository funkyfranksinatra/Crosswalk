import "dotenv/config";
/**
 * One Prisma client for the whole app (and for scripts/seed, which import it).
 *
 * PostgreSQL (Neon) through a Prisma driver adapter, chosen by DATABASE_ADAPTER:
 *   - pg        (default) @prisma/adapter-pg over TCP — the normal path on a laptop or server.
 *   - neon-ws   @prisma/adapter-neon over WebSocket (wss:443) — for sandboxes that only allow
 *               outbound HTTPS. Full transaction support.
 *   - neon-http @prisma/adapter-neon over plain HTTPS — no transactions; only for one-shot
 *               scripts (upserts and nested writes fail).
 * All take the same DATABASE_URL.
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaNeon, PrismaNeonHttp } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

/**
 * `pg` 8.x treats sslmode=prefer|require|verify-ca as verify-full and prints a security
 * warning on every boot saying so; v9 will weaken them to libpq semantics. We always want
 * the strict behaviour (Neon's certificates chain to public CAs), so say it explicitly.
 */
export function strictSsl(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    const mode = u.searchParams.get("sslmode");
    if (mode && ["prefer", "require", "verify-ca"].includes(mode) && !u.searchParams.has("uselibpqcompat")) {
      u.searchParams.set("sslmode", "verify-full");
      return u.toString();
    }
  } catch {
    /* not a URL we can parse — hand it to pg untouched */
  }
  return connectionString;
}

/** DATABASE_POOL_MAX (5): a whole number 1–200; anything else is the default rather than a NaN pool size. */
export function poolMax(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DATABASE_POOL_MAX?.trim();
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 5;
}

/** DATABASE_ADAPTER (pg): pg | neon-ws | neon-http; an unknown value is refused at load, not silently "pg". */
export function adapterKind(env: Record<string, string | undefined> = process.env): "pg" | "neon-ws" | "neon-http" {
  const kind = (env.DATABASE_ADAPTER ?? "pg").trim().toLowerCase();
  if (kind === "pg" || kind === "neon-ws" || kind === "neon-http") return kind;
  throw new Error(`DATABASE_ADAPTER must be pg, neon-ws or neon-http (got "${kind}")`);
}

function makeAdapter() {
  const kind = adapterKind();
  if (kind === "neon-http") return new PrismaNeonHttp(url!, {});
  if (kind === "neon-ws") {
    neonConfig.webSocketConstructor = ws;
    return new PrismaNeon({ connectionString: url, max: poolMax() });
  }
  return new PrismaPg({ connectionString: strictSsl(url!), max: poolMax() });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  (() => {
    // Errors are routed through an event so an expected "record not found" (P2025 — every
    // `findUniqueOrThrow` behind a 404) is not printed as a stack at error level on every miss.
    const client = new PrismaClient({
      adapter: makeAdapter(),
      log: process.env.PRISMA_LOG ? [{ level: "query", emit: "stdout" }, { level: "warn", emit: "stdout" }, { level: "error", emit: "event" }] : [{ level: "warn", emit: "stdout" }, { level: "error", emit: "event" }],
    });
    client.$on("error", (e) => { if (!/No record was found|P2025/.test(e.message)) console.error("prisma:error", e.message); });
    return client;
  })();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

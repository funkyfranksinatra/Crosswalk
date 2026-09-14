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

function makeAdapter() {
  const kind = (process.env.DATABASE_ADAPTER ?? "pg").toLowerCase();
  if (kind === "neon-http") return new PrismaNeonHttp(url!, {});
  if (kind === "neon-ws") {
    neonConfig.webSocketConstructor = ws;
    return new PrismaNeon({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 5) });
  }
  return new PrismaPg({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 5) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: makeAdapter(),
    log: process.env.PRISMA_LOG ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * The URL the Prisma CLI (migrate, db pull, studio) uses. The application itself connects through
 * driver adapters with DATABASE_URL (src/lib/db.ts) — this only governs the CLI.
 *
 * Migrations must not run through a transaction pooler: `prisma migrate` takes a session-level
 * advisory lock, and a pooled connection can hand that lock to another client if the migrate
 * process is interrupted (Neon + PgBouncer, seen Sept 2026 — "P1002 timed out trying to acquire a
 * postgres advisory lock"). So: DIRECT_DATABASE_URL when set; otherwise a Neon pooler host has its
 * "-pooler" suffix removed, which is Neon's direct endpoint for the same branch.
 */
function cliUrl(): string {
  const direct = process.env.DIRECT_DATABASE_URL?.trim();
  if (direct) return direct;
  const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/crosswalk";
  return url.replace(/(@[^/?#@]*?)-pooler(\.[^/?#]*neon\.tech)/, "$1$2");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: cliUrl(),
  },
});

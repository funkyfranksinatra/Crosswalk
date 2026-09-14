/**
 * Apply prisma/migrations/* over the Neon HTTP driver.
 *
 * `prisma migrate deploy` needs a TCP connection. Sandboxes that only allow outbound
 * HTTPS (CI runners behind a proxy, cloud agents) can't open one, so this script
 * applies the same migration files through Neon's serverless (fetch-based) driver and
 * records them in `_prisma_migrations` exactly like Prisma would — `migrate deploy`
 * and `migrate status` on a normal machine then see a consistent history.
 *
 * Usage:  DATABASE_URL=postgresql://… npx tsx scripts/migrate-http.ts [--dry-run]
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

const dir = path.resolve(process.cwd(), "prisma/migrations");
const dry = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = neon(url);

/** Prisma emits one statement per `;\n` (no functions/dollar quoting), so a simple split is safe. */
function statements(script: string): string[] {
  return script
    .split(/;\s*\n/)
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter(Boolean);
}

async function main() {
  await sql`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  )`;
  const applied = new Set((await sql`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`).map((r) => r.migration_name as string));
  const names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "migration.sql"))).sort();
  for (const name of names) {
    if (applied.has(name)) { console.log(`= ${name} (already applied)`); continue; }
    const script = fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8");
    const checksum = createHash("sha256").update(script).digest("hex");
    const stmts = statements(script);
    console.log(`${dry ? "would apply" : "applying"} ${name}: ${stmts.length} statements`);
    if (dry) continue;
    const id = randomUUID();
    await sql`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES (${id}, ${checksum}, ${name}, now(), 0)`;
    let n = 0;
    try {
      // Non-interactive transaction: all statements succeed or none are applied.
      await sql.transaction(stmts.map((s) => sql.query(s)));
      n = stmts.length;
    } catch (e) {
      await sql`UPDATE "_prisma_migrations" SET logs = ${String(e)} WHERE id = ${id}`;
      throw e;
    }
    await sql`UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = ${n} WHERE id = ${id}`;
    console.log(`  ✓ ${name}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

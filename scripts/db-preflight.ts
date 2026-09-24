/**
 * Rows that would violate the Tier 0.6 CHECK constraints — run before `prisma migrate deploy`
 * on a database with history. Exit code 1 when anything would fail, with the counts and the
 * constraint each row breaks, so the data can be corrected first.
 *
 *   npm run db:preflight
 */
import "dotenv/config";
import { loadSecrets } from "../src/lib/secrets";
import { violationQueries } from "../src/lib/db/constraints";

async function main() {
  await loadSecrets(); // DATABASE_URL may live in the secret manager; the client reads it at load
  const { prisma } = await import("../src/lib/db");
  // Which tables exist is checked once through information_schema: on an empty database (first
  // deploy) every query would otherwise fail and the Prisma client would print one `prisma:error`
  // block per constraint — 68 stack traces for a state that is simply "nothing to check yet".
  const present = new Set((await prisma.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`)).map((r) => r.table_name));
  let bad = 0;
  const skipped: string[] = [];
  for (const q of violationQueries()) {
    if (!present.has(q.table)) { skipped.push(q.name); continue; }
    let n = 0;
    try {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(q.sql);
      n = rows[0]?.n ?? 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // a column added by a migration that has not run yet
      if (/does not exist/.test(msg)) { skipped.push(q.name); continue; }
      throw e;
    }
    if (n > 0) { bad += n; console.log(`  FAIL  ${q.name}: ${n} row(s) — ${q.description}`); }
  }
  if (skipped.length) console.log(`  skip  ${skipped.length} constraint(s) whose table or column is not present yet (run migrations first): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`);
  console.log(bad ? `\n${bad} row(s) would violate the constraints; fix them before migrating.` : "No rows violate the CHECK constraints.");
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); });

/**
 * Rows that would violate the Tier 0.6 CHECK constraints — run before `prisma migrate deploy`
 * on a database with history. Exit code 1 when anything would fail, with the counts and the
 * constraint each row breaks, so the data can be corrected first.
 *
 *   npm run db:preflight
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { violationQueries } from "../src/lib/db/constraints";

async function main() {
  let bad = 0;
  for (const q of violationQueries()) {
    let n = 0;
    try {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(q.sql);
      n = rows[0]?.n ?? 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist/.test(msg)) { console.log(`  skip  ${q.name}: table or column not present yet (run migrations first)`); continue; }
      throw e;
    }
    if (n > 0) { bad += n; console.log(`  FAIL  ${q.name}: ${n} row(s) — ${q.description}`); }
  }
  console.log(bad ? `\n${bad} row(s) would violate the constraints; fix them before migrating.` : "No rows violate the CHECK constraints.");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }).finally(() => prisma.$disconnect());

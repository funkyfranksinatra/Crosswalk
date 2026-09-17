/**
 * One-off catalog hygiene for a database loaded before the placeholder guard existed:
 *
 *   npx tsx scripts/catalog-hygiene.ts            # report only
 *   npx tsx scripts/catalog-hygiene.ts --apply    # deactivate placeholder products/crosses, drop test fixtures
 *
 * - Own products whose SKU is a spreadsheet placeholder ("NOMATCH", "TOTAL", "N/A") are
 *   deactivated, never deleted: matching, the eval and the catalog list all read isActive,
 *   and any MatchCandidate rows that point at them keep their history.
 * - Known crosses whose own SKU is a placeholder are deactivated the same way.
 * - Crosses / version entries the enterprise test suite leaves behind (E2E-*) are deleted:
 *   they are fixtures, not data.
 */
import { prisma } from "../src/lib/db";
import { isPlaceholderSku } from "../src/lib/cfn";
import { isTestFixture } from "../src/lib/eval/model";

async function main() {
  const apply = process.argv.includes("--apply");
  const products = (await prisma.ownProduct.findMany({ where: { isActive: true }, select: { id: true, sku: true, description: true } })).filter((p) => isPlaceholderSku(p.sku));
  const crosses = (await prisma.knownCross.findMany({ where: { isActive: true }, select: { id: true, ownSku: true, competitorCodeNorm: true } })).filter((k) => isPlaceholderSku(k.ownSku) || isPlaceholderSku(k.competitorCodeNorm));
  const fixtures = (await prisma.knownCross.findMany({ select: { id: true, competitorCodeNorm: true } })).filter((k) => isTestFixture(k.competitorCodeNorm));
  const fixtureEntries = (await prisma.crosswalkVersionEntry.findMany({ select: { id: true, competitorCodeNorm: true } })).filter((e) => isTestFixture(e.competitorCodeNorm));

  console.log(`Placeholder own products (active): ${products.length}${products.length ? " — " + products.map((p) => `${p.sku} "${p.description}"`).join(", ") : ""}`);
  console.log(`Placeholder known crosses (active): ${crosses.length}${crosses.length ? " — " + crosses.map((k) => `${k.ownSku}←${k.competitorCodeNorm}`).join(", ") : ""}`);
  console.log(`Test-fixture crosses: ${fixtures.length}, version entries: ${fixtureEntries.length}`);
  if (!apply) { console.log("\nDry run. Re-run with --apply to deactivate the placeholders and delete the fixtures."); return; }

  const p = products.length ? await prisma.ownProduct.updateMany({ where: { id: { in: products.map((x) => x.id) } }, data: { isActive: false } }) : { count: 0 };
  const c = crosses.length ? await prisma.knownCross.updateMany({ where: { id: { in: crosses.map((x) => x.id) } }, data: { isActive: false } }) : { count: 0 };
  const fe = fixtureEntries.length ? await prisma.crosswalkVersionEntry.deleteMany({ where: { id: { in: fixtureEntries.map((x) => x.id) } } }) : { count: 0 };
  const f = fixtures.length ? await prisma.knownCross.deleteMany({ where: { id: { in: fixtures.map((x) => x.id) } } }) : { count: 0 };
  console.log(`\nDeactivated ${p.count} products and ${c.count} crosses; deleted ${f.count} fixture crosses and ${fe.count} fixture version entries.`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

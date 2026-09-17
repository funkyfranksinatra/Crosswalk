/**
 * Embed the catalog (and cached competitor products) for retrieval:
 *
 *   npx tsx scripts/embed.ts                 # both tables, only rows whose text changed
 *   npx tsx scripts/embed.ts --own           # own products only
 *   npx tsx scripts/embed.ts --competitor    # competitor products only
 *
 * Needs OPENAI_API_KEY (text-embedding-3-small by default; EMBEDDING_MODEL overrides) and
 * pgvector in the database (the Tier 3 migration enables it). Safe to re-run: unchanged
 * rows cost nothing. The nightly embed.refresh job does the same thing on a schedule.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { refreshEmbeddings, embeddingCoverage, embeddingsEnabled, pgvectorAvailable } from "../src/lib/match/embeddings";

async function main() {
  process.env.JOBS_WORKER ??= "off";
  if (!embeddingsEnabled()) { console.error("Embeddings need OPENAI_API_KEY (and EMBEDDINGS not 'off')."); process.exit(1); }
  if (!(await pgvectorAvailable())) { console.error("pgvector is not installed in this database: run the migrations (CREATE EXTENSION vector)."); process.exit(1); }
  const own = process.argv.includes("--own") || !process.argv.includes("--competitor");
  const comp = process.argv.includes("--competitor") || !process.argv.includes("--own");
  const progress = (label: string) => (done: number, total: number) => { process.stdout.write(`\r${label}: ${done}/${total} embedded`.padEnd(60)); };
  if (own) { const r = await refreshEmbeddings("OwnProduct", { onProgress: progress("own products") }); console.log(`\nOwn products: ${r.embedded} embedded, ${r.unchanged} unchanged (of ${r.scanned})`); }
  if (comp) { const r = await refreshEmbeddings("CompetitorProduct", { onProgress: progress("competitor products") }); console.log(`\nCompetitor products: ${r.embedded} embedded, ${r.unchanged} unchanged (of ${r.scanned})`); }
  const c = await embeddingCoverage();
  console.log(`Coverage: own ${c.own.embedded}/${c.own.total}, competitor ${c.competitor.embedded}/${c.competitor.total} (${c.model})`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

/**
 * Run the data-retention sweep by hand.
 *
 *   npm run retention -- --dry-run     report what the configured windows would delete
 *   npm run retention                  delete it (requires RETENTION_ENABLED=true, or --force)
 *
 * Windows come from the environment (see src/lib/retention.ts / .env.example).
 */
import "dotenv/config";
import { loadSecrets } from "../src/lib/secrets";

async function main() {
  await loadSecrets();
  const args = new Set(process.argv.slice(2));
  const { prisma } = await import("../src/lib/db");
  const { runRetention, retentionConfig } = await import("../src/lib/retention");
  const cfg = retentionConfig();
  if (args.has("--dry-run")) cfg.dryRun = true;
  const force = args.has("--force");
  if (!cfg.enabled && !force && !cfg.dryRun) { console.error("RETENTION_ENABLED is not true; pass --dry-run to preview or --force to run anyway."); process.exit(2); }
  console.log(`retention ${cfg.dryRun ? "DRY RUN" : "sweep"} — windows (days):`, cfg.days, `batch ${cfg.batch}`);
  const out = await runRetention(cfg, { force: force || cfg.dryRun });
  for (const [k, n] of Object.entries(out.counts)) console.log(`  ${k.padEnd(14)} ${String(n).padStart(7)}${out.more[k] ? "  (more remain: run again)" : ""}`);
  if (!Object.keys(out.counts).length) console.log("  nothing in scope");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

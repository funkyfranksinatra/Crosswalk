/**
 * Multi-list accuracy benchmark (Tier 1 §1.6).
 *
 *   npx tsx scripts/benchmark.ts [--dir data/benchmark] [--case name]... [--from-requests]
 *                                [--llm] [--keep] [--label "text"] [--out docs/benchmarks]
 *
 * Runs every case through the real pipeline and prints per-family / per-tier accuracy;
 * persists a BenchmarkRun row and (with --out) a markdown report.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { loadCases, casesFromRequests, runBenchmark, formatBenchmark } from "../src/lib/eval/benchmark";

function arg(name: string): string | null { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? null : null; }
function args(name: string): string[] { const out: string[] = []; process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); }); return out; }

async function main() {
  process.env.JOBS_WORKER ??= "off"; // the benchmark runs the pipeline in-process
  const dir = arg("dir") ?? path.resolve("data/benchmark");
  const cases = [...(await loadCases(dir, args("case"))), ...(process.argv.includes("--from-requests") ? await casesFromRequests() : [])];
  if (!cases.length) { console.error(`No benchmark cases in ${dir} (each case: intake.csv|xlsx + reference.csv|xlsx) and no reviewed requests. See data/benchmark/README.md.`); process.exit(2); }
  console.log(`${cases.length} case(s): ${cases.map((c) => `${c.name} (${c.intake.lines.length} lines, ${c.reference.length} reference rows)`).join(", ")}`);
  const r = await runBenchmark(cases, { useLlm: process.argv.includes("--llm"), keep: process.argv.includes("--keep"), label: arg("label"), onProgress: (m) => console.log("  " + m) });
  const md = formatBenchmark(r);
  console.log("\n" + md);
  const out = arg("out");
  if (out) { fs.mkdirSync(out, { recursive: true }); const f = path.join(out, `${new Date().toISOString().slice(0, 10)}-${r.runId.slice(-6)}.md`); fs.writeFileSync(f, md); console.log(`Report written to ${f}`); }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

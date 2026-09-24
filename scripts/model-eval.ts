/**
 * Model evaluation harness + gate (Tier 1 §1.7).
 *
 *   npx tsx scripts/model-eval.ts               measure the configured model on the curated crosses
 *   npx tsx scripts/model-eval.ts --accept      …and accept the result as the baseline (data/eval/model-baseline.json)
 *   npx tsx scripts/model-eval.ts --gate        check the code's prompt/bin/model versions against the baseline (no model needed)
 *   options: --n 40 --seed 7 --family "Hernia Mesh" --fresh (ignore the verdict cache) --notes "why"
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { evaluateModel, acceptBaseline, gate } from "../src/lib/eval/model";

function arg(name: string, def?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? def : def; }

async function main() {
  process.env.JOBS_WORKER ??= "off";
  if (process.argv.includes("--gate")) {
    const g = await gate({ checkDb: process.argv.includes("--db") });
    for (const w of g.warnings) console.log(`Model eval gate: WARNING — ${w}`);
    console.log(g.ok ? `Model eval gate: OK (prompt v${g.current.promptVersion}, bins v${g.current.binVersion}, ${g.current.model}; baseline top-1 ${g.baseline ? Math.round((g.baseline.top1Agree / Math.max(1, g.baseline.graded)) * 100) + "%" : "not measured yet"})` : `Model eval gate: FAILED\n  - ${g.reasons.join("\n  - ")}`);
    await prisma.$disconnect();
    process.exit(g.ok ? 0 : 1);
  }
  const r = await evaluateModel({ n: Number(arg("n", "40")), seed: Number(arg("seed", "7")), family: arg("family") ?? null, ignoreCache: process.argv.includes("--fresh"), onProgress: (m) => process.stdout.write(`\r${m.padEnd(70)}`) });
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  console.log(`\n\nModel ${r.model} · prompt v${r.promptVersion} · bins v${r.binVersion} · seed ${r.sampleSeed} · ${r.graded}/${r.sampleSize} graded in ${(r.durationMs / 1000).toFixed(0)}s`);
  console.log(`Top-1 agreement : ${r.top1Agree}/${r.graded} (${pct(r.top1Agree, r.graded)})`);
  console.log(`Tier agreement  : ${r.tierAgree}/${r.graded} (${pct(r.tierAgree, r.graded)})`);
  console.log(`False No Match  : ${r.noMatchFalse}`);
  const misses = r.details.filter((d) => !d.top1);
  if (misses.length) { console.log(`\nDisagreements (${misses.length}):`); for (const m of misses.slice(0, 40)) console.log(`  ${m.code.padEnd(14)} ${m.competitor.padEnd(16)} curated ${m.expected.join("/")} (${m.curatedType})  model ${m.pick ?? "No Match"} (${m.pickType ?? "-"})`); }
  if (process.argv.includes("--accept")) { const b = await acceptBaseline(r.id, arg("notes") ?? null); console.log(`\nAccepted as baseline (eval ${b.evalId}). Commit data/eval/model-baseline.json.`); }
  else console.log(`\nEval id ${r.id}. Re-run with --accept to make this the baseline.`);
  await prisma.$disconnect();
}
main().catch((e) => {
  // A missing model key or a configuration problem is a one-line message, not a stack trace.
  const msg = e instanceof Error ? e.message : String(e);
  if (/OPENAI_API_KEY|not configured|not set/i.test(msg)) console.error(`Model eval: ${msg}`);
  else console.error(e);
  process.exit(1);
});

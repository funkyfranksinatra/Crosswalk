/**
 * Profile the request pipeline end to end: stage timings from the run log, Prisma query counts by
 * statement/model, slow statements, openFDA activity. Runs in heuristic mode against DATABASE_URL.
 *
 *   npm run profile:run -- <intake.xlsx|csv> [label]
 *
 * Query counts are the number that matters on a remote database: every statement is a round trip.
 * Requests it creates are named "PROFILE" (account name) so they are easy to delete afterwards.
 */
import "dotenv/config";
import fs from "node:fs";
process.env.PRISMA_LOG ??= "1"; process.env.LOG_SILENT ??= "true"; process.env.JOBS_WORKER ??= "off";

async function main() {
// imported after the environment is set (PRISMA_LOG must be seen when the client is created)
const { prisma } = await import("../src/lib/db");
const { parseIntakeAny } = await import("../src/lib/excel/intake");
const { runRequest } = await import("../src/lib/pipeline/run");
const { getCompany } = await import("../src/lib/settings");
const { nextReference } = await import("../src/lib/requests");
const { onLog } = await import("../src/lib/log");
const file = process.argv[2];
if (!file) { console.error("usage: npx tsx scripts/profile-run.ts <intake file> [label]"); process.exit(2); }
const label = process.argv[3] ?? "run";
let queries = 0; const slow: { ms: number; q: string }[] = []; const byModel = new Map<string, number>();
// Prisma 7 query events come through the client's $on when log includes "query"
(prisma as unknown as { $on: (e: string, cb: (ev: { query: string; duration: number }) => void) => void }).$on("query", (ev) => {
  queries++;
  const m = ev.query.match(/"public"\."(\w+)"/); const k = `${ev.query.split(" ")[0]} ${m?.[1] ?? "?"}`;
  byModel.set(k, (byModel.get(k) ?? 0) + 1);
  if (ev.duration > 50) slow.push({ ms: ev.duration, q: ev.query.slice(0, 120) });
});
let fdaCalls = 0; const events: Record<string, number> = {};
onLog((l) => { const e = String(l.event); events[e] = (events[e] ?? 0) + 1; if (/openfda|gudid\.http/.test(e)) fdaCalls++; });

const bytes = fs.readFileSync(file);
const intake = await parseIntakeAny({ file: new File([bytes], file.split("/").pop()!) });
const company = await getCompany();
const req = await prisma.request.create({ data: { companyId: company.id, reference: await nextReference(), accountName: "PROFILE", accountType: "Sold-To", reportType: "profile", useLlm: false, createdBy: "profile", status: "queued", lines: { create: intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estCompetitorPrice: l.estPrice })) } } });
const t0 = Date.now();
await runRequest(req.id, { attempt: 1, finalAttempt: true });
const total = Date.now() - t0;
const done = await prisma.request.findUniqueOrThrow({ where: { id: req.id } });
const log = JSON.parse(done.logJson ?? "[]") as { t: string; m: string }[];
console.log(`\n=== ${label}: ${intake.lines.length} lines, ${total} ms, status ${done.status}, ${queries} queries, openFDA-ish events ${fdaCalls}`);
let prev = new Date(log[0]?.t ?? 0).getTime();
for (const l of log) { const t = new Date(l.t).getTime(); console.log(`  +${String(t - prev).padStart(6)} ms  ${l.m.slice(0, 110)}`); prev = t; }
console.log("queries by model:", [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(", "));
console.log("slow (>50ms):", slow.length, slow.sort((a, b) => b.ms - a.ms).slice(0, 5).map((s) => `${s.ms}ms ${s.q}`).join("\n  "));
console.log("log events:", Object.entries(events).filter(([k]) => /gudid|openfda|run\.|match|resolve/.test(k)).map(([k, v]) => `${k}=${v}`).join(", "));
console.log(`REQ=${req.id}`);
await prisma.$disconnect();

}
main().catch((e) => { console.error(e); process.exit(1); });

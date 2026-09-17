/**
 * Record openFDA responses for the offline pipeline tests (tests/recorded/openfda/).
 *
 *   npx tsx scripts/record-openfda.ts
 *
 * Runs the scenario in tests/recorded/openfda-scenario.ts with a fetch wrapper that stores
 * every openFDA request/response (URL without api key, status, body). The Vitest suite replays them
 * through `setFetchForTests` and fails on any URL that was not recorded — so the pipeline
 * tests never touch the network in CI.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "../src/lib/db";
import { setFetchForTests } from "../src/lib/gudid/http";
import { runScenario } from "../tests/recorded/openfda-scenario";

const DIR = path.resolve("tests/recorded/openfda");
const strip = (url: string) => url.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "");

async function main() {
  process.env.JOBS_WORKER = "off";
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const index: Record<string, string> = {};
  let recorded = 0;
  setFetchForTests(async (url, init) => {
    const res = await fetch(url, init);
    const body = await res.text();
    const key = strip(url);
    const file = `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`;
    fs.writeFileSync(path.join(DIR, file), JSON.stringify({ url: key, status: res.status, body }, null, 0));
    index[key] = file;
    recorded++;
    return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  });
  const result = await runScenario();
  for (const [code, r] of Object.entries(result)) console.log(`${code}: ${r.resolution} — ${r.manufacturer ?? ""} (${r.cfnMatched ?? ""}, ${r.confidence})`);
  fs.writeFileSync(path.join(DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");
  fs.writeFileSync(path.join(DIR, "expected.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`${recorded} responses recorded → ${path.relative(process.cwd(), DIR)}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

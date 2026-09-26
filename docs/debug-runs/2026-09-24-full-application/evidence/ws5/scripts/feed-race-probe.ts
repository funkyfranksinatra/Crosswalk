// Two concurrent ingestions of one feed on a warmed connection pool: does the "already being ingested" guard hold?
import "dotenv/config";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { prisma } from "../../../../../../src/lib/db";
import { ingestFeed } from "../../../../../../src/lib/feeds";
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws5-race-")); process.env.INTEGRATION_FEED_DIR = dir;
  fs.writeFileSync(path.join(dir, "pricing.csv"), "SKU,List Price\nPPM1510X3,101.25\n");
  await prisma.feedRun.deleteMany({ where: { feed: "pricing" } });
  await Promise.all([1, 2, 3, 4].map(() => prisma.$queryRaw`SELECT pg_sleep(0.2)::text`)); // warm 4 pool connections
  let both = 0;
  for (let i = 0; i < 5; i++) {
    const r = await Promise.allSettled([ingestFeed("pricing", { trigger: "manual", force: true }), ingestFeed("pricing", { trigger: "schedule", force: true })]);
    const ok = r.filter((x) => x.status === "fulfilled").length;
    console.log(`round ${i + 1}: fulfilled=${ok} rejected=${2 - ok}`);
    if (ok === 2) both++;
  }
  console.log(`rounds where BOTH ran concurrently: ${both}/5`);
  await prisma.feedRun.deleteMany({ where: { feed: "pricing" } });
  fs.rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
}
main();

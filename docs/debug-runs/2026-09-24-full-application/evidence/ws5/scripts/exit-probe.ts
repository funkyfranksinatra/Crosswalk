import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { getBoss, stopBoss } from "../../../../../../src/lib/jobs/boss";
import { startWorkers } from "../../../../../../src/lib/jobs/workers";
async function main() {
  const t0 = Date.now();
  await getBoss();
  if (process.argv.includes("--workers")) await startWorkers();
  console.log("boss up", Date.now() - t0, "ms");
  if (process.argv.includes("--stop")) { await stopBoss(); console.log("boss stopped", Date.now() - t0, "ms"); }
  await prisma.$disconnect();
  console.log("prisma disconnected", Date.now() - t0, "ms");
  setInterval(() => {}, 1000).unref();
}
main().catch((e) => { console.error(e); process.exit(1); });

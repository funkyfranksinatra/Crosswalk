/**
 * Dedicated job worker. Run this alongside the web server when the server is started
 * with JOBS_WORKER=external (or several of these for throughput — pg-boss hands each job
 * to exactly one worker).
 *
 *   npm run worker
 */
import "dotenv/config";
import { loadSecrets, assertProductionSecrets } from "../src/lib/secrets";
import { log } from "../src/lib/log";

process.env.JOBS_WORKER = "inline";

async function main() {
  await loadSecrets();
  assertProductionSecrets();
  // Imported after secrets are in place: the Prisma client reads DATABASE_URL at load.
  const { startWorkers } = await import("../src/lib/jobs/workers");
  const { stopBoss } = await import("../src/lib/jobs/boss");
  await startWorkers();
  log.info("worker.ready", { pid: process.pid });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { log.info("worker.stopping", { signal: sig }); await stopBoss(); process.exit(0); });
}
main().catch((e) => { log.error("worker.start_failed", { error: e instanceof Error ? e.message : String(e) }); process.exit(1); });

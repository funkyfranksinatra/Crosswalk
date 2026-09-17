/**
 * Dedicated job worker. Run this alongside the web server when the server is started
 * with JOBS_WORKER=external (or several of these for throughput — pg-boss hands each job
 * to exactly one worker).
 *
 *   npm run worker
 */
import "dotenv/config";
import { startWorkers } from "../src/lib/jobs/workers";
import { stopBoss } from "../src/lib/jobs/boss";
import { log } from "../src/lib/log";

process.env.JOBS_WORKER = "inline";
startWorkers().then(() => log.info("worker.ready", { pid: process.pid })).catch((e) => { log.error("worker.start_failed", { error: e instanceof Error ? e.message : String(e) }); process.exit(1); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { log.info("worker.stopping", { signal: sig }); await stopBoss(); process.exit(0); });

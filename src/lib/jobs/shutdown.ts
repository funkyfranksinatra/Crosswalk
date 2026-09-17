/**
 * Graceful stop for the inline workers: on SIGTERM/SIGINT, hand active jobs back to the
 * queue (pg-boss `stop({ graceful })`) so they are retried by the next process instead of
 * sitting "active" until their heartbeat lapses. Node-only (kept out of instrumentation.ts,
 * which Next also analyses for the edge runtime).
 */
import { log } from "@/lib/log";

type G = typeof globalThis & { __crosswalkSignals?: boolean };

export function installShutdownHooks() {
  const g = globalThis as G;
  if (g.__crosswalkSignals || typeof process === "undefined" || typeof process.once !== "function") return;
  g.__crosswalkSignals = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, async () => {
      log.info("jobs.shutdown", { signal: sig });
      try { const { stopBoss } = await import("./boss"); await stopBoss(); } catch { /* shutting down anyway */ }
      process.exit(0);
    });
  }
}

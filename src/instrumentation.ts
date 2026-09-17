/**
 * Runs once when the Next.js server starts (App Router instrumentation hook).
 * Starts the in-process job workers unless this web server is configured to leave
 * background work to a dedicated worker (`JOBS_WORKER=external`, then `npm run worker`).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const mode = process.env.JOBS_WORKER ?? "inline";
  if (mode !== "inline") return;
  const { startWorkers } = await import("@/lib/jobs/workers");
  // Never block server start on the queue: a database hiccup must not take the UI down.
  startWorkers().catch(() => undefined);
}

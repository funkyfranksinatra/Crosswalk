/**
 * Runs once when the Next.js server starts (App Router instrumentation hook).
 * Starts the in-process job workers unless this web server is configured to leave
 * background work to a dedicated worker (`JOBS_WORKER=external`, then `npm run worker`).
 * A failed start (database not reachable yet) is retried with backoff; a SIGTERM stops
 * the queue gracefully so in-flight jobs are handed back for retry instead of expiring.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Tenancy is single per deployment; say so (and warn about drift) once per process, queue or not.
  import("@/lib/tenancy").then(({ checkTenancy }) => checkTenancy()).catch(() => undefined);
  const mode = process.env.JOBS_WORKER ?? "inline";
  if (mode !== "inline") return;
  const { startWorkers } = await import("@/lib/jobs/workers");
  const { log } = await import("@/lib/log");
  const attempt = (n: number) => {
    // Never block server start on the queue: a database hiccup must not take the UI down.
    startWorkers().catch(() => {
      const delay = Math.min(300_000, 5_000 * 2 ** n);
      log.warn("jobs.workers_retry", { inSeconds: Math.round(delay / 1000), attempt: n + 1 });
      setTimeout(() => attempt(n + 1), delay).unref();
    });
  };
  attempt(0);
  const { installShutdownHooks } = await import("@/lib/jobs/shutdown");
  installShutdownHooks();
}

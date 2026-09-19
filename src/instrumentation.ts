/**
 * Runs once when the Next.js server starts (App Router instrumentation hook).
 * Loads secrets from the configured provider and checks production config (src/lib/secrets.ts).
 * Starts the in-process job workers unless this web server is configured to leave
 * background work to a dedicated worker (`JOBS_WORKER=external`, then `npm run worker`).
 * A failed start (database not reachable yet) is retried with backoff; a SIGTERM stops
 * the queue gracefully so in-flight jobs are handed back for retry instead of expiring.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Secrets first (a secret manager may hold DATABASE_URL), then refuse weak production config.
  // Next runs register() lazily on the first request and caches a failure forever — the server
  // would sit there answering 500 without ever retrying. So a failure here ends the process:
  // the restart policy brings it back, and the reason is the last line in the log.
  const { loadSecrets, assertProductionSecrets } = await import("@/lib/secrets");
  try {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await loadSecrets(); lastError = null; break; } catch (e) { lastError = e; if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt)); }
    }
    if (lastError) throw lastError;
    assertProductionSecrets();
    // SSO configuration mistakes (a bad role map, an unknown default role) surface here, not at the first sign-in.
    const { ssoMode, oidcConfig, discover } = await import("@/lib/auth/oidc");
    if (ssoMode() === "oidc") {
      const cfg = oidcConfig();
      discover(cfg).catch((err) => console.warn(`[crosswalk] OIDC discovery at ${cfg.issuer} failed: ${err instanceof Error ? err.message : String(err)} — sign-in will retry on demand`));
    }
  } catch (e) {
    console.error(`[crosswalk] refusing to start: ${e instanceof Error ? e.message : String(e)}`);
    // Reached through globalThis so the Edge compile of this file (never executed: see the
    // NEXT_RUNTIME guard above) does not flag a Node API.
    const proc = (globalThis as { process?: { exit(code: number): never } }).process;
    setTimeout(() => proc?.exit(1), 0);
    throw e;
  }
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

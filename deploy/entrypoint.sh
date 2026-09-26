#!/bin/sh
# Container entrypoint. First argument selects the role:
#   web      migrate (unless MIGRATE_ON_START=false), then the Next.js server (default)
#   worker   a dedicated pg-boss worker (start the web with JOBS_WORKER=external)
#   migrate  prisma migrate deploy, then exit
#   check    secret / configuration checks only (exit code tells)
#   anything else is executed as given (e.g. `npx tsx scripts/retention.ts --dry-run`)
# Secrets from SECRETS_PROVIDER are loaded by scripts/with-secrets.ts for the steps that
# run outside the app process (migrate), and by the app itself for web and worker.
#
# The long-running roles exec the local binaries directly (node_modules/.bin), never through
# `npx`: npx does not forward SIGTERM to the process it spawned, so `docker stop` ended npx and
# left the server / worker running without its graceful stop (in-flight jobs were not handed
# back to the queue) until the container was killed.
set -eu
# /app in the image; the checkout when run directly (docs/DEPLOYMENT.md: `sh deploy/entrypoint.sh check`).
cd "${APP_DIR:-$(dirname "$0")/..}"
role="${1:-web}"
[ $# -gt 0 ] && shift

migrate() {
  if [ "${PREFLIGHT_ON_START:-true}" = "true" ]; then
    echo "[entrypoint] db preflight (CHECK constraints)"
    node_modules/.bin/tsx scripts/db-preflight.ts || { echo "[entrypoint] preflight found rows that would fail the constraints; fix them or set PREFLIGHT_ON_START=false"; exit 1; }
  fi
  echo "[entrypoint] prisma migrate deploy"
  node_modules/.bin/tsx scripts/with-secrets.ts --check -- node_modules/.bin/prisma migrate deploy
}

case "$role" in
  web)
    if [ "${MIGRATE_ON_START:-true}" = "true" ]; then migrate; fi
    echo "[entrypoint] next start on :${PORT:-3000} (JOBS_WORKER=${JOBS_WORKER:-inline})"
    exec node_modules/.bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
    ;;
  worker)
    echo "[entrypoint] job worker"
    exec node_modules/.bin/tsx scripts/worker.ts
    ;;
  migrate)
    migrate
    ;;
  check)
    exec node_modules/.bin/tsx scripts/with-secrets.ts --check
    ;;
  *)
    exec "$role" "$@"
    ;;
esac

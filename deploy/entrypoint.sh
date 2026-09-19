#!/bin/sh
# Container entrypoint. First argument selects the role:
#   web      migrate (unless MIGRATE_ON_START=false), then the Next.js server (default)
#   worker   a dedicated pg-boss worker (start the web with JOBS_WORKER=external)
#   migrate  prisma migrate deploy, then exit
#   check    secret / configuration checks only (exit code tells)
#   anything else is executed as given (e.g. `npx tsx scripts/retention.ts --dry-run`)
# Secrets from SECRETS_PROVIDER are loaded by scripts/with-secrets.ts for the steps that
# run outside the app process (migrate), and by the app itself for web and worker.
set -eu
cd /app
role="${1:-web}"
[ $# -gt 0 ] && shift

migrate() {
  echo "[entrypoint] prisma migrate deploy"
  npx tsx scripts/with-secrets.ts --check -- npx prisma migrate deploy
}

case "$role" in
  web)
    if [ "${MIGRATE_ON_START:-true}" = "true" ]; then migrate; fi
    echo "[entrypoint] next start on :${PORT:-3000} (JOBS_WORKER=${JOBS_WORKER:-inline})"
    exec npx next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
    ;;
  worker)
    echo "[entrypoint] job worker"
    exec npx tsx scripts/worker.ts
    ;;
  migrate)
    migrate
    ;;
  check)
    exec npx tsx scripts/with-secrets.ts --check
    ;;
  *)
    exec "$role" "$@"
    ;;
esac

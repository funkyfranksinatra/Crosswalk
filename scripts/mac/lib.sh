#!/usr/bin/env bash
# Shared helpers for the mac-demo scripts. Bash 3.2 compatible (macOS ships 3.2): no arrays-of-arrays,
# no ${var,,}, no mapfile. Every script sources this and runs from the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Read a key from .env (first match, quotes stripped). Empty when absent.
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | sed -E 's/^[^=]+=//; s/^"//; s/"$//'; }

# Where the database lives: "docker" (compose, port 5433), "brew" (Homebrew service) or "external"
# (any DATABASE_URL you set yourself). Decided once by setup.sh and remembered in .env.
db_mode() { local m; m="$(env_get CROSSWALK_DB_MODE)"; echo "${m:-docker}"; }

node_ok() {
  have node || return 1
  local v; v="$(node -p 'process.versions.node.split(".").slice(0,2).map(Number)' 2>/dev/null | tr -d '[] ' )"
  local major="${v%%,*}" minor="${v##*,}"
  [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 9 ]; }
}

docker_running() { have docker && docker info >/dev/null 2>&1; }

# Block until Postgres answers on the URL in .env (or the given one), up to N seconds. Uses only
# Node's built-ins until dependencies are installed (setup runs before npm ci), then a real query.
wait_for_db() {
  local url="${1:-$(env_get DATABASE_URL)}" tries="${2:-40}" i=0
  until node -e '
    const u = new URL(process.argv[1]); const host = u.hostname || "localhost"; const port = Number(u.port || 5432);
    let pg = null; try { pg = require("pg"); } catch {}
    if (pg) { const c = new pg.Client({ connectionString: process.argv[1] }); c.connect().then(() => c.query("select 1")).then(() => { c.end(); process.exit(0); }).catch(() => process.exit(1)); }
    else { const s = require("net").connect({ host, port }); s.setTimeout(1500); s.on("connect", () => { s.end(); process.exit(0); }); s.on("error", () => process.exit(1)); s.on("timeout", () => process.exit(1)); }
  ' "$url" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -ge "$tries" ] && return 1
    sleep 1
  done
  return 0
}

db_up() {
  case "$(db_mode)" in
    docker)
      docker_running || die "Docker Desktop is not running. Start it (or run: npm run mac:setup -- --brew to use Homebrew Postgres instead)."
      docker compose up -d >/dev/null
      ;;
    brew)
      if ! (brew services list 2>/dev/null | grep -E '^postgresql(@[0-9]+)?\s+started' >/dev/null); then
        say "Starting Homebrew Postgres"
        brew services start "$(brew list --formula 2>/dev/null | grep -E '^postgresql(@[0-9]+)?$' | tail -1)" >/dev/null
      fi
      ;;
    external) ;;
  esac
  say "Waiting for the database"
  wait_for_db || die "The database did not answer at $(env_get DATABASE_URL). Run: npm run mac:doctor"
}

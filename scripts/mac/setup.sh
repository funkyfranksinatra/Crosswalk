#!/usr/bin/env bash
# One-shot local setup for macOS (Apple Silicon or Intel). Idempotent: run it again any time.
#
#   npm run mac:setup             # Docker Desktop provides Postgres+pgvector (recommended)
#   npm run mac:setup -- --brew   # Homebrew Postgres 17 + pgvector instead of Docker
#   npm run mac:setup -- --external "postgresql://…"   # a database you already have (needs pgvector)
#
# What it does: checks Node, writes .env (never overwrites an existing one), starts the database,
# installs dependencies, generates the Prisma client, applies migrations, seeds the demo data.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="" EXTERNAL_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker ;;
    --brew) MODE=brew ;;
    --external) MODE=external; EXTERNAL_URL="${2:-}"; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

# ---- 1. Node -----------------------------------------------------------------------------
say "Checking Node"
if ! node_ok; then
  warn "Node 20.9+ is required (22 recommended). Found: $(node -v 2>/dev/null || echo none)"
  if have nvm || [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
    nvm install 22 >/dev/null && nvm use 22 >/dev/null || true
  fi
  node_ok || die "Install Node 22: 'brew install node@22' or https://nodejs.org — then re-run npm run mac:setup"
fi
ok "Node $(node -v)"

# ---- 2. .env -----------------------------------------------------------------------------
if [ -f .env ]; then
  ok ".env exists — keeping it (delete it to start over)"
  [ -n "$MODE" ] || MODE="$(db_mode)"
else
  say "Writing .env from .env.mac.example"
  cp .env.mac.example .env
  if [ -z "$MODE" ]; then
    if docker_running; then MODE=docker
    elif have brew && brew list --formula 2>/dev/null | grep -q '^postgresql'; then MODE=brew
    else MODE=docker; fi
  fi
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  # .env edits through node: BSD sed's -i differs from GNU's and bites everyone who copies a Linux snippet.
  node -e '
    const fs = require("fs"); let s = fs.readFileSync(".env", "utf8");
    const set = (k, v) => { s = s.replace(new RegExp(`^${k}=.*$`, "m"), `${k}="${v}"`); };
    set("SESSION_SECRET", process.argv[1]); set("CROSSWALK_DB_MODE", process.argv[2]);
    if (!/^CROSSWALK_DB_MODE=/m.test(s)) s += `\nCROSSWALK_DB_MODE="${process.argv[2]}"\n`;
    if (process.argv[2] === "brew") set("DATABASE_URL", `postgresql://${process.env.USER}@localhost:5432/crosswalk`);
    if (process.argv[2] === "external" && process.argv[3]) set("DATABASE_URL", process.argv[3]);
    fs.writeFileSync(".env", s);
  ' "$SECRET" "$MODE" "$EXTERNAL_URL"
  ok ".env written (database mode: $MODE)"
fi

# ---- 3. Database ---------------------------------------------------------------------------
case "$MODE" in
  docker)
    have docker || die "Docker Desktop is not installed: https://www.docker.com/products/docker-desktop/ (or use --brew)"
    docker_running || die "Docker Desktop is installed but not running — open it, wait for the whale, re-run npm run mac:setup"
    say "Starting Postgres + pgvector in Docker (port 5433)"
    docker compose up -d
    ;;
  brew)
    have brew || die "Homebrew is not installed: https://brew.sh (or use Docker)"
    if ! brew list --formula 2>/dev/null | grep -q '^postgresql@17$'; then say "Installing postgresql@17 and pgvector with Homebrew"; brew install postgresql@17 pgvector; fi
    brew list --formula 2>/dev/null | grep -q '^pgvector$' || brew install pgvector
    brew services start postgresql@17 >/dev/null 2>&1 || true
    PGBIN="$(brew --prefix postgresql@17)/bin"
    export PATH="$PGBIN:$PATH"
    sleep 2
    "$PGBIN/createdb" crosswalk 2>/dev/null || true
    ;;
  external)
    [ -n "$(env_get DATABASE_URL)" ] || die "--external needs a connection string"
    ;;
esac
say "Waiting for the database"
wait_for_db || die "No database at $(env_get DATABASE_URL). Run: npm run mac:doctor"
ok "Database is up"

# ---- 4. Dependencies, client, migrations, seed ---------------------------------------------
say "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund
say "Applying migrations (this enables pgvector — Docker image and Homebrew pgvector both provide it)"
if ! npx prisma migrate deploy; then
  die "Migrations failed. If the error mentions 'extension \"vector\"', your Postgres has no pgvector: use Docker (npm run mac:setup -- --docker) or 'brew install pgvector'."
fi
npx prisma generate >/dev/null
say "Seeding demo data (users, accounts, catalog, crosses, policies)"
npx tsx prisma/seed.ts
npx tsx prisma/seed-enterprise.ts
npx tsx prisma/seed-demo.ts

cat <<MSG

$(ok "Crosswalk is ready.")

  npm run mac:start        → http://localhost:3000  (dev server + background jobs)
  npm run mac:doctor       → diagnose anything that goes wrong
  npm run mac:reset        → wipe the local database and re-seed
  npm run mac:stop         → stop the database

  Sign in from the sidebar as any seeded user (Alex Rivera is the sales rep, Dana Whitfield the
  pricing director, Crosswalk Admin sees everything). A demo usage list to paste into New request is at
  data/demo/demo-usage-list.csv. Model key optional (OPENAI_API_KEY in .env).
MSG

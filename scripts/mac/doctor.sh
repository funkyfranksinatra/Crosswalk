#!/usr/bin/env bash
# Diagnose a Mac setup: prints what is wrong and what to do. Never changes anything.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set +e
echo "Crosswalk mac doctor — $(date)"
echo "macOS: $(sw_vers -productVersion 2>/dev/null || uname -s) · arch: $(uname -m)"

if node_ok; then ok "Node $(node -v)"; else warn "Node 20.9+ needed (found $(node -v 2>/dev/null || echo none)) → brew install node@22"; fi
have npm && ok "npm $(npm -v)"

if [ -f .env ]; then ok ".env present (database mode: $(db_mode))"; else warn ".env missing → npm run mac:setup"; fi
[ -d node_modules ] && ok "node_modules present" || warn "node_modules missing → npm run mac:setup"
[ -d src/generated/prisma ] && ok "Prisma client generated" || warn "Prisma client missing → npx prisma generate"

case "$(db_mode)" in
  docker)
    if ! have docker; then warn "Docker not installed → https://www.docker.com/products/docker-desktop/";
    elif ! docker_running; then warn "Docker Desktop not running → open it and wait for the whale icon";
    else
      st="$(docker inspect -f '{{.State.Status}}' crosswalk-db 2>/dev/null)"
      case "$st" in
        running) ok "Docker container crosswalk-db running" ;;
        "") warn "Container crosswalk-db not created → docker compose up -d" ;;
        *) warn "Container crosswalk-db is $st → docker compose up -d" ;;
      esac
    fi ;;
  brew)
    have brew && (brew services list 2>/dev/null | grep -E '^postgresql' | head -2) ;;
esac

URL="$(env_get DATABASE_URL)"
if [ -n "$URL" ]; then
  if wait_for_db "$URL" 3; then
    ok "Database answers at ${URL%%@*}@…"
    node -e '
      const { Client } = require("pg"); const c = new Client({ connectionString: process.argv[1] });
      (async () => { await c.connect();
        const v = await c.query("select count(*)::int as n from pg_extension where extname=$1", ["vector"]);
        console.log(v.rows[0].n ? "\x1b[1;32m✓ pgvector installed\x1b[0m" : "\x1b[1;33m! pgvector NOT installed — migrations will fail; use the Docker image or brew install pgvector\x1b[0m");
        const m = await c.query("select count(*)::int as n from _prisma_migrations").catch(() => ({ rows: [{ n: -1 }] }));
        console.log(m.rows[0].n < 0 ? "\x1b[1;33m! no migrations applied yet → npx prisma migrate deploy\x1b[0m" : `\x1b[1;32m✓ ${m.rows[0].n} migrations applied\x1b[0m`);
        const u = await c.query("select count(*)::int as n from \"User\"").catch(() => ({ rows: [{ n: -1 }] }));
        console.log(u.rows[0].n <= 0 ? "\x1b[1;33m! no users seeded → npm run db:seed:enterprise\x1b[0m" : `\x1b[1;32m✓ ${u.rows[0].n} users seeded\x1b[0m`);
        const p = await c.query("select count(*)::int as n from \"OwnProduct\"").catch(() => ({ rows: [{ n: -1 }] }));
        console.log(p.rows[0].n <= 0 ? "\x1b[1;33m! catalog empty → npm run db:seed:demo\x1b[0m" : `\x1b[1;32m✓ ${p.rows[0].n} own products\x1b[0m`);
        await c.end(); })().catch((e) => { console.log("\x1b[1;33m! " + e.message + "\x1b[0m"); process.exit(0); });
    ' "$URL"
  else
    warn "No database answering at $URL → npm run mac:start (Docker) or brew services start postgresql@17"
  fi
fi

for port in 3000 5433; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then ok "port $port: $(lsof -nP -iTCP:$port -sTCP:LISTEN | awk 'NR==2{print $1}')"; else echo "  port $port: free"; fi
done
if curl -s -m 3 https://api.fda.gov/device/udi.json?limit=1 >/dev/null; then ok "openFDA reachable"; else warn "openFDA not reachable (offline / proxy) — cross-reference runs will resolve nothing new"; fi
echo "Model key: $([ -n "$(env_get OPENAI_API_KEY)" ] && echo set || echo 'not set (heuristic mode — fine for demos)')"

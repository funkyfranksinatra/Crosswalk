#!/usr/bin/env bash
# Start the database (if we manage it) and the dev server.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ -f .env ] || die "No .env yet — run: npm run mac:setup"
[ -d node_modules ] || die "Dependencies missing — run: npm run mac:setup"
db_up
PORT="${PORT:-3000}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  warn "Port $PORT is in use; starting on $((PORT+1)) instead (PORT=… to choose)"
  PORT=$((PORT+1))
fi
say "Starting Crosswalk on http://localhost:$PORT"
exec npx next dev -p "$PORT"

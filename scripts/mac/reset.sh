#!/usr/bin/env bash
# Wipe the local database and re-seed. Refuses to touch anything that is not localhost.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ -f .env ] || die "No .env yet — run: npm run mac:setup"
URL="$(env_get DATABASE_URL)"
case "$URL" in
  *localhost*|*127.0.0.1*) ;;
  *) die "DATABASE_URL is not a local database ($URL) — reset only works on localhost" ;;
esac
db_up
say "Dropping and recreating the schema"
npx prisma migrate reset --force --skip-seed
say "Seeding demo data"
npx tsx prisma/seed.ts
npx tsx prisma/seed-enterprise.ts
npx tsx prisma/seed-demo.ts
ok "Reset complete — npm run mac:start"

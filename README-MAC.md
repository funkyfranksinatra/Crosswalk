# Running Crosswalk on a Mac (`mac-demo` branch)

This branch is the stable v0.6.0 build plus a local-setup layer for macOS. **The application
code is identical to `main` at tag `v0.6.0`** — nothing here changes how Crosswalk behaves; it
only changes how it is started on a laptop: a local PostgreSQL with pgvector instead of the
shared Neon database, a demo catalog so a fresh clone has something to cross-reference, and
scripts that do the setup in one command and tell you what is wrong when it is not.

## What you need

- macOS 13+ (Apple Silicon or Intel).
- **Node 22** (20.9+ works): `brew install node@22`, or https://nodejs.org. `.nvmrc` says 22 if you use nvm.
- **A PostgreSQL with pgvector**, one of:
  - **Docker Desktop** (recommended, zero configuration): https://www.docker.com/products/docker-desktop/ — the repo's `docker-compose.yml` runs `pgvector/pgvector:pg17` on port **5433**, so an existing local Postgres on 5432 is untouched.
  - **Homebrew**: `brew install postgresql@17 pgvector` — the setup script does this for you with `--brew`.
- Internet for `npm ci` and for openFDA lookups (the five demo codes that are recorded resolve offline).

No Neon URL, no model key, no Google credentials are required for a demo.

## Set up (once)

```bash
git clone -b mac-demo <repo-url> crosswalk && cd crosswalk
npm run mac:setup                 # Docker Desktop must be running
#   or: npm run mac:setup -- --brew
#   or: npm run mac:setup -- --external "postgresql://user:pass@host:5432/db"   (any Postgres 15+ with pgvector)
```

The script checks Node, writes `.env` from `.env.mac.example` (with a random `SESSION_SECRET`;
it never overwrites an `.env` you already have), starts the database, runs `npm ci`, applies the
migrations, and seeds the demo data. Five minutes on a normal connection.

## Every day

```bash
npm run mac:start      # starts the database if needed, then the dev server → http://localhost:3000
npm run mac:stop       # stops the database (data is kept)
npm run mac:doctor     # what is wrong and what to do — run this before asking for help
npm run mac:reset      # wipe the local database and re-seed (only ever touches localhost)
```

`mac:start` picks the next port if 3000 is busy (`PORT=3005 npm run mac:start` to choose).
Background jobs (runs, imports, feeds, notifications) run inside the dev server; nothing else
to start.

## The demo

1. Open http://localhost:3000 and sign in from the sidebar as **Alex Rivera (Sales Rep)**.
2. **New request** → upload `data/demo/demo-usage-list.csv` (or paste its contents) → account
   `0001880967` Memorial Sloan Kettering → Continue. The run resolves every code and matches
   all 16 lines (7 Exact, 8 Close, 1 Alternative) from the seeded, published crosses.
3. Review a line, open **Side-by-side**, add a customer note, try **Bulk actions**.
4. **Download → Contract offer (branded PDF)**, then **Create proposal** → freight & tax →
   **Submit for approval** → sign in as **Dana Whitfield (Pricing Director)** to approve from
   the deal desk → back as Alex → **Quote PDF**.
5. Settings → Branding sets the letterhead on the PDFs; Settings → System shows the queues,
   feeds, alerts and retrieval coverage.

Without a model key the app runs in heuristic mode (deterministic bins and scoring). Put an
`OPENAI_API_KEY` in `.env` and restart for model bins, grading rationales, and `npm run embed`
for embedding retrieval.

## What the demo seed adds (and what it never touches)

`prisma/seed-demo.ts` runs after the two regular seeds. It **only creates rows that do not
exist**: ~40 own SKUs with list prices and costs across the six product families, 16 approved
crosses for the demo list's codes, a published crosswalk version containing them, and the
competitor cache for the five recorded codes. On a database that already holds the curated
sheets it adds nothing that is there — the demo seed is safe to run anywhere, and it is not
part of `main`'s `npm run setup`.

## When it does not work

`npm run mac:doctor` first. The common ones:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Docker Desktop is not running` | the whale is not up | open Docker Desktop, wait, re-run |
| migrations fail with `extension "vector"` | a Postgres without pgvector (`brew install postgresql` alone) | use Docker, or `brew install pgvector` and re-run |
| `No database at postgresql://…` | Docker still starting, or wrong port in `.env` | wait 10 s and re-run; Docker is 5433, Homebrew 5432 |
| `port 3000 in use` | another dev server | `mac:start` moves to 3001; or `PORT=…` |
| `Module not found: pg-boss` (or any package) | `npm ci` never finished | `npm run mac:setup` again |
| sign-in list is empty | production build without `ALLOW_DEV_SIGNIN` | `.env.mac.example` sets it; `npm run mac:start` uses the dev server anyway |
| `openFDA not reachable` | offline / corporate proxy | the five recorded demo codes still resolve; others show "Not in GUDID" |
| BSD `sed`/Bash 3.2 errors | copied a Linux snippet | the scripts avoid both; report the exact command |

## Keeping this branch current

`mac-demo` = `main` + the commits touching only `docker-compose.yml`, `.env.mac.example`,
`.nvmrc`, `README-MAC.md`, `scripts/mac/`, `prisma/seed-demo.ts`, `data/demo/`, and the
`mac:*` / `db:seed:demo` entries in `package.json`. To update it after `main` moves:

```bash
git checkout mac-demo && git merge main    # or rebase; conflicts are only ever in package.json scripts
```

Nothing on this branch should be merged back into `main` unless the team decides the Mac
tooling belongs there too — it is additive, so that merge would be safe, but it is a decision.

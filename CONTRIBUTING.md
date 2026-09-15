# Contributing to Crosswalk

## Getting a working copy

```bash
git clone <this repo> crosswalk && cd crosswalk
cp .env.example .env            # set DATABASE_URL (shared Neon dev DB from the owner, or your own free Neon/Postgres); OPENAI_API_KEY optional
npm run setup                   # install, prisma generate, migrate deploy, seed catalog + enterprise (users, policy, demo data)
npm run dev                     # http://localhost:3000
```

`npm run setup` seeds an **empty catalog** unless the reference sheets are
present — they hold customer and company data and are deliberately not in
git. Ask the project owner for:

| File | Drop it at | What it gives you |
| --- | --- | --- |
| `Endomechanical.xlsx` | `data/reference/` | the 313 own SKUs + ~1,600 curated crosses (ground truth for `npm run eval`) |
| `SSXrefReport_REQ-7604.xlsx` | `data/reference/` | hernia SKUs + list prices from the legacy PACR report |
| `CrossReference_0001880967.xlsx` | `data/reference/` | the sample intake used by `scripts/run-sample.ts` and the PACR comparison |

Then `npm run db:seed` (add `-- --gudid` to enrich own SKUs from openFDA, ~2 min).

### Database

Crosswalk runs on PostgreSQL (Prisma 7 with driver adapters). The shared dev
database is a Neon project; `DATABASE_ADAPTER=pg` is right on a laptop. In an
environment that can only open HTTPS (some cloud sandboxes) use `neon-ws`;
`neon-http` has no transactions and is only for one-off scripts
(`npm run db:migrate:http` applies pending migrations over HTTP). Neon
branches are the cheap way to get an isolated database for a risky change.

## Day-to-day commands

| Command | Purpose |
| --- | --- |
| `npm run check` | deterministic unit checks (binner, similarity, grouping, CSV) — no DB, no network, < 2 s |
| `npm run check:enterprise` | deterministic checks of the commercial engines (waterfall, cost, FX, confidence, recommendation, authority, rebates, bundles, clauses, economics) — no DB |
| `npm run test:enterprise` | end-to-end commercial workflow against the database; idempotent, cleans up after itself |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | production build (Turbopack) |
| `npm run eval -- --n 80 --seed 7 --no-crosses` | matcher accuracy against the curated crosses (needs the reference sheet) |
| `npx tsx scripts/run-sample.ts [intake.xlsx]` | headless run + both exports into `./out` |
| `npm run db:seed:enterprise -- --no-demo` | users, roles and default policy only (what CI seeds) |
| `npm run db:studio` | browse the database |

CI (GitHub Actions, Postgres 17 service) runs migrations, `typecheck`,
`check`, `check:enterprise`, `build`, and both seeds with no reference data on
every push and pull request.

## How the code is laid out

Read `docs/ARCHITECTURE.md` first — it has the data-flow diagram, the
decisions taken with the product owner, and the reasoning behind the
resolution, binning and grading rules. The short version:

* `src/lib/gudid/` — openFDA client, own-catalog enrichment, and `library.ts`
  (bulk labeler import into `GudidDevice`, the library-first lookup the
  resolver uses; pure mapping in `library-model.ts`).
* `src/lib/pipeline/` — `resolve.ts` (CFN → GUDID record) and `run.ts` (the
  request pipeline: resolve → bin → retrieve → score → grade → persist).
* `src/lib/match/` — `bin.ts` (the comparable attribute shape + heuristic
  binner + similarity), `score.ts` (ranking), `grading.ts` (model grading in
  sibling groups with a verdict cache).
* `src/lib/llm/` — OpenAI adapter with structured outputs and call logging;
  every model task has a heuristic twin so nothing blocks on a key.
* `src/lib/excel/` + `src/lib/sheets/` — intake parsing, pricing and
  competitor-sizes imports, exports, Google Sheets I/O.
* `src/lib/{auth,contracts,catalog,intelligence,pricing,proposals,approvals,xref,compliance,analytics,integrations}/`
  — the commercial platform. `docs/BUSINESS_RULES.md` maps each rule to its
  file and test; `docs/ENTERPRISE_ARCHITECTURE.md` has the ER diagram and the
  decisions.
* `src/app/` — Next.js App Router pages and API routes. Server components
  read Prisma directly; client components live in `client.tsx` / `view.tsx`.
  Every API route goes through `handle(permission, fn)` in `src/lib/api.ts`;
  pages call `requireActor()` / `can()` and redact with `redactForActor()`.

## Conventions

* **Rule bumps.** Change the heuristic binner → bump `BIN_VERSION` in
  `bin.ts` (v6: FDA review-panel and other-division exclusions). Change the grading prompt → bump `GRADE_PROMPT_VERSION` in
  `grading.ts`. Both invalidate cached bins/verdicts on the next run; forgetting
  is the #1 way a fix silently doesn't ship.
* **Pin regressions.** Every deterministic fix that came out of a
  compare-and-debug pass has a case in `scripts/check.ts`. Add one with yours.
* **Money** is never a JS `number` in domain code: use `src/lib/money.ts`
  (`D`, `times`, `marginPct`, `round`…) and `Decimal` columns. Convert only at
  the UI/JSON boundary (`plain()` / `toJson()`).
* **Every rule has one home and one test.** A pricing/contract/intelligence
  rule lives in the `src/lib/*` module named in `docs/BUSINESS_RULES.md` and
  gets a case in `scripts/check-enterprise.ts` (pure) or
  `scripts/test-enterprise.ts` (DB). The UI never computes money.
* **Authorization is server-side.** New API route → `handle("<permission>", …)`;
  new permission → `src/lib/auth/permissions.ts` matrix; anything that shows
  cost, margin or floor must pass through `redactForActor()`. Sensitive writes
  call `audit()` with before/after and the decision context.
* **Schema changes** go through `npx prisma migrate dev --name <what>` against
  a Neon branch (or a local Postgres) and the migration is committed; keep
  additive migrations backward-compatible so the app can deploy before the
  migration runs.
* **Secrets** only in `.env` (ignored). `google-service-account.json` is
  ignored too. If you add a new secret, add its name to `.env.example` with a
  comment.
* **Style.** Prettier-ish defaults, 2-space, double quotes, no semicolonless
  lines. Comments explain *why* a rule exists (usually a product example that
  went wrong), not what the code does.
* **Commits.** Imperative subject, one logical change. Reference the request
  ID (e.g. `REQ-0013`) when a change came from a comparison run.

## Reviewing a pipeline change

1. `npm run check` and `npm run eval -- --n 80 --seed 7 --no-crosses` before
   and after — top-1 / top-3 must not drop.
2. `npx tsx scripts/run-sample.ts` and diff the export against the previous
   run (the `out/` folder is ignored; keep the old file around).
3. If the model path is involved, run the same request twice: the second run
   must replay cached verdicts (log line "replayed from cache") and produce
   identical match types.

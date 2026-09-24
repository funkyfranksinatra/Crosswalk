# Test results ledger

Environment for every row unless stated: workspace `/home/claude/cracr`, branch `debug/2026-09-24-full-application`, Node 22.22.2, local PostgreSQL 16.13 `crosswalk_dbg` (pg adapter, pgvector), env `.env.local.dbg` (JOBS_WORKER=off, NOTIFY_DRY_RUN=true, LOG_SILENT=true), no model key. Raw logs under `evidence/logs/`.

## 1. Baseline at `ccfc6e8` (code = `1b43393`), 2026-09-24 06:55–07:05 UTC

| Command | Exit | Duration | Result | Log |
|---|---|---|---|---|
| `npm run db:preflight` (empty DB) | 0 | 2 s | PASS — "No rows violate"; but prints `prisma:error` stack noise for every not-yet-existing table (CW-DBG-0004) | 00-bootstrap-dbg.log |
| `npx prisma migrate deploy` (empty DB) | 0 | 6 s | PASS — 15 migrations | 00-bootstrap-dbg.log |
| `npx tsx prisma/seed.ts` (reference sheets present) | 0 | 20 s | PASS — 338 own products, 3,926 known crosses, +10 legacy SKUs | 00-bootstrap-dbg.log |
| `npx tsx prisma/seed-enterprise.ts` (demo) | 0 | 15 s | PASS — 11 users, 6 policies, crosswalk v1 (3,561 entries), 19 observations | 00-bootstrap-dbg.log |
| `npm run typecheck` | 0 | 5 s | PASS | 01-baseline-typecheck.log |
| `npm run check` | 0 | 2 s | PASS 19/19 | 01-baseline-check.log |
| `npm run check:enterprise` | 0 | 1 s | PASS 21/21 | 01-baseline-check:enterprise.log |
| `npx vitest run` | 1 | 35 s | **FAIL 1 / 298 pass / 0 skipped** (13 files; all DB suites ran) — `tests/db/tier3.test.ts › refreshEmbeddings writes vectors once` expects the second sweep to embed 0 but a fresh catalog still has pending rows (CW-DBG-0001) | 01-baseline-vitest.log |
| `npm run build` | 0 | 78 s | PASS — 2 Turbopack warnings "Dynamic filesystem access causes tracing of the whole project" | 01-baseline-build.log |
| `npm run test:adversarial` | 0 | 4 s | PASS 24/24, process exited on its own | 01-baseline-test:adversarial.log |
| `npm run test:enterprise` | 1 | 19 s | **FAIL 5 / 13 pass**, process exited — first failure: B12LTH top candidate is `NONB12STF`, expectation `ONB12STF`; the other four cascade from `by("ONB12STF")` being undefined (CW-DBG-0002) | 01-baseline-test:enterprise.log |
| `npm run eval -- --n 80 --seed 7 --no-crosses` | 0 | 24 s | PASS (measurement): resolution 80/80, top-1 26/80, top-3 46/80 on this seed (denominator: 80 sampled approved crosses; not comparable to the REQ-7628 report's `crosswalk_ref` figures) | 01-baseline-eval-dbg.log |
| `npm run eval:model` | 1 | 1 s | BLOCKED — no OPENAI_API_KEY; exits with a full stack trace instead of a one-line message (CW-DBG-0005) | 01-baseline-eval:model.log |
| `npm run eval:gate` | 1 | 1 s | **FAIL** — "BIN_VERSION is 7 but the accepted baseline measured version 6" (hard) and model gpt-5.6-astra vs baseline gpt-6-astra (warning). CI on `main` would fail at this step. Re-measuring needs a model key and an accept decision (CW-DBG-0003, BLOCKED) | 01-baseline-eval:gate.log |
| `npm run benchmark` | 2 | 1 s | NOT_RUN — no cases in `data/benchmark/` and no reviewed requests (expected; historical lists are company-owned) | 01-baseline-benchmark.log |
| `npm run secrets:check` | 0 | 1 s | PASS (non-production: prints nothing) | 01-baseline-secrets:check.log |
| `npm run profile:run` | — | — | deferred to the performance section (needs a sanitized intake) | — |

## 2. Workstream runs (07:00–11:00 UTC)

Each workstream ran its own database `crosswalk_ws1…ws5` (clones of the seeded `crosswalk_dbg`). Their command ledgers with exit codes are in `workstreams/WS1…WS5-report.md` §3. Headline final numbers per workstream: WS1 vitest 18 files/388 (3 consecutive green), enterprise 18/18; WS2 30 files/553 (green twice); WS3 17 files/688 + 1 skipped with the server stopped, matrix 264/264, journeys 47+38+34+61+7+26 checks, keyboard 18, polling 9, axe 0 violations on 22 pages, 0/88 horizontal scroll; WS4 39 files/668 + 1 skipped, authz matrix 1,638 calls, HTTP probes 81/81 + 10/10 proxy mode; WS5 41 files/688 + 1 skipped, CI mirror on a fresh DB green except `eval:gate`.

## 3. Integrated state (11:05 UTC) — after applying the cross-owner handoffs

Fresh `crosswalk_dbg` (empty → migrate → seed): `db:preflight` 0 (no error noise), `migrate deploy` 0, seeds 0. `typecheck` 0 · `check` 19/19 · `check:enterprise` 21/21 · `vitest` 41 files / 690 / 0 skipped (165 s) · `test:adversarial` 24/24 (JOBS_WORKER=off 3 s, inline 3 s, both exit 0) · `test:enterprise` 18/18 (off 19 s, inline 7 s, both exit 0) · `build` 0 · `eval` 80/80, top-1 29/80, top-3 46/80 · `eval:gate` 1 (BLOCKED B-01) · `secrets:check` 0. Logs `evidence/logs/02-*`.

Browser on that build: price-gate 110/110, matrix 264 × 200, journey-request 47/47, journey-proposal 38/38 (+34/34 as SALES_REP), journey-noaccount 7/7, journey-admin 59/61 — **2 failures in the GUDID section → CW-DBG-0007 (regression introduced by WS3, React #310 hook-order crash on `/catalog/gudid`)**, navigation-state 26/26, keyboard 18/18, polling 9/9, responsive-axe 0 violations / 0 of 88 overflow.

## 4. Independent review (12:00 UTC) — `REVIEW.md`

15 findings (REV-01…REV-15: 2 P1, 4 P2, 9 P3); 14 fixed by the coordinator in the final state, REV-13 recorded as a sheet-owner decision (B-07). Mutation checks M1–M5, M7b fail for the right reason; M6 (feed race) did not until the test was strengthened.

## 5. Final state (13:10 UTC) — fresh bootstrap + every gate

Fresh `crosswalk_dbg` (empty → `db:preflight` → `migrate deploy` → `seed.ts` → `seed-enterprise.ts`): exit 0, 0 `prisma:error` lines (`evidence/logs/04-final-bootstrap.log`).

| Command | Exit | Duration | Result | Log |
|---|---|---|---|---|
| `npm run typecheck` | 0 | 7 s | PASS | 04-final-typecheck.log |
| `npm run lint` (new rules-of-hooks gate) | 0 | 5 s | PASS | 04-final-lint.log |
| `npm run check` | 0 | 1 s | PASS 19/19 | 04-final-check.log |
| `npm run check:enterprise` | 0 | 1 s | PASS 21/21 | 04-final-check:enterprise.log |
| `npx vitest run` | 0 | 174 s | **PASS 43 files / 698 tests / 0 skipped / 0 failed** (13 DB suites all ran) | 04-final-vitest.log |
| `npm run test:adversarial` | 0 / 0 | 3 s / 3 s | PASS 24/24 with JOBS_WORKER=off and with inline workers; process exits on its own | 04-final-test:adversarial*.log |
| `npm run test:enterprise` | 0 / 0 | 19 s / 7 s | PASS 18/18 in both worker modes; exits on its own | 04-final-test:enterprise*.log |
| `npm run build` (clean `.next`) | 0 | 48 s | PASS (2 pre-existing tracing warnings) | 04-final-build.log |
| `npm run eval -- --n 80 --seed 7 --no-crosses` | 0 | 22 s | resolution 80/80, top-1 29/80, top-3 46/80 (baseline 26/80, 46/80; every moved line explained in WS1 §K; no line regressed) | 04-final-eval-dbg.log (per-line curated expectations stripped) |
| `npm run eval:gate` | 1 | 1 s | **BLOCKED** (B-01) — unchanged message, gate not weakened | 04-final-eval:gate.log |
| `npm run secrets:check` | 0 | 1 s | PASS | — |
| `sh deploy/entrypoint.sh check` | 0 | 2 s | PASS; with `NODE_ENV=production SESSION_SECRET=short` → exit 1 as required | — |
| `npm run profile:run` 30 lines / 300 distinct codes | 0 | — | 30 lines 3.2 s cold (2.5 s openFDA) / 37 lines 1.5 s warm; 300 lines 75 s cold (openFDA-bound) / **5.2 s warm, 902 queries, 298/300 matched** | 05-profile-*.log |
| Browser (Chromium, production build, JOBS_WORKER=inline): price-gate | 0 | 3 s | 110/110 | ws3/logs/price-gate-final4.log |
| journey-request / journey-noaccount / navigation-state / keyboard | 0 | — | 47/47 · 7/7 · 26/26 · 18/18 | ws3/logs/*-final4.log |
| journey-proposal (committee) / (SALES_REP) | 0 / 0 | 20 s / 17 s | 37/37 · 33/33 | ws3/logs/journey-proposal*-final4.log |
| journey-admin (all sections incl. one live GUDID import) | 0 | 81 s | 61/61 | ws3/logs/journey-admin-final4.log |
| polling | 0 | 103 s | 9/9 (after CW-DBG-0008 fix, rebuilt) | ws3/logs/polling-final5.log |
| responsive-axe (22 pages × 4 widths) | 0 | 141 s | 0 axe violations, 0/88 horizontal scroll | ws3/logs/responsive-axe-final4.log |
| matrix (22 pages × 12 role views) | 0 | 345 s | 264/264 HTTP 200; 0 page/hydration/CSP errors; only expected 403/404 API responses for out-of-scope or missing resources | ws3/out/matrix-final5.csv |
| Post-review spot suites on `crosswalk_rev` (review-concurrency, review-matching, ws5-platform, ws4-proxy, ws2-money, ws4-redaction, ws4-authz, ws4-adversarial, tier1, tier1-units) | 0 | — | all green after the review fixes; then the full suite above | — |

Not run / blocked: see `BLOCKERS.md` (eval:gate, Docker image, live providers, macOS, non-Chromium engines, 5,000-line profile, timed soak, benchmark lists).

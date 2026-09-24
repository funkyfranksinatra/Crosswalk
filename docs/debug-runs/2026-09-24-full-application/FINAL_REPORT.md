# Final report — full-application debugging run, 2026-09-24

## Verdict: VERIFICATION INCOMPLETE

Every gate that can run in this workspace passes on the final revision (typecheck, lint, pure checks,
698 Vitest cases across 43 files with every database suite executed, the two tsx suites in both worker
modes, production build, fresh-database bootstrap, the CI `check` job mirrored step by step, the
browser page×role matrix, journeys, keyboard, polling, responsive/axe, an independent adversarial review
whose findings were fixed and re-verified). Zero confirmed code defects remain open. The verdict is
still **incomplete** because four requirements of the brief cannot be proven here: the model-eval gate
needs a key and an accept decision (CI on `main` is red at that step); the container image cannot be
built (no Docker daemon); the live providers, IdP, macOS and non-Chromium engines are unverified; and
two product-truth questions (B12LTH optical or not; child-of-unassigned-parent scope) are owner
decisions. `BLOCKERS.md` lists each with the smallest next action.

## Repository state

| | |
|---|---|
| Starting commit | `ccfc6e8` on `main` (clean tree; code identical to `1b43393` plus BUILD_NOTES.md) |
| Working branch | `debug/2026-09-24-full-application` — **one commit on top of `ccfc6e8`** (see `git log`); nothing pushed, nothing deployed, Neon untouched, no migration added (schema comments only) |
| Change set | 201 source/test/doc files, +12,248 / −1,436 lines (excluding the run directory); 2 files deleted (legacy Salesforce/SAP skeletons); 30 new test files; `package.json` version 0.7.0, `lint` script, three ESLint dev dependencies; CI gains `npm run lint` |
| Environment | cloud workspace, Node 22.22.2, PostgreSQL 16.13 + pgvector (local, disposable), Chromium/Playwright; no model key, no Docker, no provider credentials (`RUN_MANIFEST.md`) |
| Data | reference sheets present and read-only; every mutating test on `crosswalk_dbg` / `crosswalk_ws1…5` / `crosswalk_rev` / `crosswalk_final` (all created by this run); the eval reference DB `crosswalk_ref` read only |

## Findings (151)

| | discovered | verified fixed | not a defect (with rationale) | blocked (prerequisite) | open (decision / data) |
|---|---|---|---|---|---|
| P0 | 1 | 1 | – | – | – |
| P1 | 19 | 18 | – | 1 (eval gate) | – |
| P2 | 59 | 57 | – | 1 (same gate, WS1 row) | 1 (B12LTH sheet-owner call) |
| P3 | 72 | 58 | 11 | – | 3 (Thoracoport, curated rows, scope rule) |
| **total** | **151** | **134** | **11** | **2** | **4** |

By domain: matching 32 (27 fixed), commercial 21 (16), frontend 24 (23), security 27 (25), platform 24 (22), coordinator 8 (7), independent review 15 (14). "Already fixed at baseline": none — every KN item reproduced on `ccfc6e8`. Full ledger: `BUG_LOG.md` / `BUG_LOG.json`; per-finding reproduction, root cause, fix, regression test and pre/post evidence in `workstreams/WS1…WS5-report.md` and `REVIEW.md`.

## Material fixes and why they address root causes

- **P0 — proxy-mode identity spoofing** (`SSO_MODE=proxy` trusted any client's `x-sso-subject`): the subject now counts only with `x-sso-proxy-secret` equal to `SSO_PROXY_SHARED_SECRET` (constant-time), both headers are stripped outside proxy mode, and production refuses to start without the secret. Proven through real HTTP before/after.
- **Approval integrity**: `decide()` locks the proposal row, so two approvers deciding two lines at once can no longer leave a proposal stranded; `reopen()`, submission, WON and contract entries are single transactions with the proposal/contract row locked; WON re-checks the status it validated; policy activation and feed ingestion are advisory-locked (the feed test now fails without the lock).
- **Confidentiality**: cost/floor/margin/target-price/policy-margin figures were reachable by reps through scenario economics, raw `economicsJson`, approval snapshots, matcher rationale and `factorsJson` notes, the xref workbook prose, the NDJSON export and the pricing-policies list — one shared redaction path now covers each surface; server-rendered catalog/settings pages gate prices on `view_pricing`.
- **Gate hardening**: Salesforce webhook opened at the proxy for exactly its path; CSRF gate on cookie-authenticated mutations; forwarded host / request id trusted only behind a declared proxy; decompression-bomb guard; outbound URL policy for integration endpoints; honest error contract (runtime faults are 500s, not 400s); plain-decimal money parsing (hex prices had reached a contract entry).
- **Matching correctness without easier Exacts**: cannula-vs-trocar and "for use with … trocar" classification, structured cm/inch sizes, negations ("non-optical", "without fixation"), reviewer notes never treated or published as SKUs, successor chains with a cycle guard, deterministic ties, run weights snapshotted at enqueue, sibling floor bounded by hard caps, NFKC code folding. Thresholds unchanged; adversarial pairs assert every cap; eval moved 26→29/80 top-1 with each moved line explained and no regression.
- **Operability**: tsx suites exit on their own (pg-boss released), entrypoint forwards SIGTERM, `JOBS_WORKER=on` no longer silently disables workers, health sees stalled jobs, retry limits honoured, malformed cron cannot kill the job system, wrong encryption key fails safely, runner never advances the watermark past a page cap, strict single-tenant start-up with `OWN_LABELERS`.
- **UI**: GPO contracts creatable; every control follows role and business state; sidebar groups; error/not-found boundaries; the `/catalog/gudid` React #310 crash (a regression introduced during this run and caught by re-running the journeys on the integrated build) fixed and fenced with a rules-of-hooks lint gate in CI; enrich polling; 0 axe violations, 0 horizontal-scroll pages.

## Tests and journeys executed on the final revision

See `TEST_RESULTS.md` §5–6 for every command, exit code and log. Summary: `typecheck` 0 · `lint` 0 · `check` 19/19 · `check:enterprise` 21/21 · `vitest` **43 files / 698 passed / 0 failed / 0 skipped** (176 s; 13 DB suites executed) · `test:adversarial` 24/24 and `test:enterprise` 18/18 in both worker modes, exiting on their own (the enterprise suite needs the pristine demo seed: on a database where browser journeys had already closed WON deals for the demo account it reports 11/18 — precondition, not a defect; verified 18/18 on a fresh seed) · `build` 0 · fresh bootstrap 0 with no error noise · `eval` 80/80 resolved, top-1 29/80, top-3 46/80 · `eval:gate` **fails as expected** (B-01) · `secrets:check` 0 · entrypoint `check` 0 / 1 with a short production secret · profile 300 lines 5.2 s warm / 902 queries · browser: price-gate 110/110, matrix 264/264, journeys 47+37+33+7+61 checks, navigation 26, keyboard 18, polling 9, responsive-axe 0 violations / 0 of 88.

Evaluation before/after (same seed, same DB, same denominator 80): resolution 80/80 → 80/80; top-1 26 → 29; top-3 46 → 46; PACR regression 31/31 both; `docs/eval/*` and `data/eval/model-baseline.json` untouched.

## Database, configuration, deployment, documentation

No schema migration was added; `prisma/schema.prisma` changed in comments only (constraint SQL regenerated byte-identical). New environment variables: `SSO_PROXY_SHARED_SECRET` (required in production proxy mode), `OWN_LABELERS`, `TENANCY_STRICT`, `OPENFDA_TIMEOUT_MS`; stricter parsing of `JOBS_WORKER`, `DATABASE_ADAPTER` and numeric pools. Deployment notes updated for forwarded-header trust and the one-web-one-worker topology. Documentation reconciled: BUILD_NOTES §5/§8/§21/§23/§26 + new §28, MATCH_QUALITY_MODEL, BUSINESS_RULES, DATA_ACCESS_POLICY, DEPLOYMENT, OPERATIONS, INTEGRATION_SETUP, BACKUPS, CONTRIBUTING, `.env.example`. Recovery implication: environments whose published crosswalk predates this run must re-publish after deploy (B-06).

## What remains unproven (see BLOCKERS.md)

B-01 model-eval baseline at bins v8 (needs a key; CI red at `eval:gate` until accepted) · B-02 container build/boot · B-03 every live provider, IdP, mail/Teams, Google Drive, AvaTax, SAM/USAspending · B-04 macOS · B-05 Firefox/WebKit · B-06 Neon crosswalk re-publish check · B-07 B12LTH optical decision · B-08 scope-rule decision · B-09 Thoracoport + 14 curated rows · B-10 historical benchmark lists · B-11 5,000-line profile and a timed soak · B-12 push/deploy (Alex's credentials). None of these is relabelled complete.

## Reproduce

```
git checkout debug/2026-09-24-full-application
createdb crosswalk_x && psql crosswalk_x -c 'create extension vector'
DATABASE_URL=postgresql://…/crosswalk_x DATABASE_ADAPTER=pg SESSION_SECRET=<32+ chars> ALLOW_DEV_SIGNIN=true JOBS_WORKER=off NOTIFY_DRY_RUN=true LOG_SILENT=true \
  sh -c 'npm run db:preflight && npx prisma migrate deploy && npx tsx prisma/seed.ts && npx tsx prisma/seed-enterprise.ts && npm run typecheck && npm run lint && npm run check && npm run check:enterprise && npx vitest run && npm run test:adversarial && npm run test:enterprise && npm run build'
# browser scripts: see evidence/ws3/README.md (production build on :3103 with JOBS_WORKER=inline)
```

Links: `BUG_LOG.md`, `BUG_LOG.json`, `INVENTORY.csv`, `COVERAGE_MATRIX.csv`, `TEST_RESULTS.md`, `BLOCKERS.md`, `REVIEW.md`, `workstreams/`, `evidence/` (logs, matrices, probes; screenshots and downloads under `evidence/ws3/out/` are gitignored and stay in the workspace; per-line curated-cross listings were removed from the tracked evidence).

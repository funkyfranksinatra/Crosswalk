# Completion checklist — what closes each remaining item, where it runs, who unblocks it

Status legend: **DONE** · **RUNNING** · **READY** (can be executed here as soon as scope is authorised) ·
**NEEDS ACCESS** (something only Alex/the company can provide) · **NEEDS DECISION** (owner call).
Machines: **W** = this cloud workspace (Linux, Node 22, local PostgreSQL 16 + pgvector, Chromium + Firefox +
WebKit, no Docker, no provider credentials); **A** = Alex's Windows PC "wumpus" (git checkout, GitHub
credentials; the desktop-app bridge VM has Node 22 but no Docker); **GH** = GitHub Actions
(`.github/workflows/ci.yml`: `check` job on push to `main` / every PR, `image` job builds and boots the
container — the only Docker host in reach); **N** = Neon (dev DB; nothing is run there without an
explicit go); **M** = a Mac; **C** = the company's systems (Salesforce/SAP/GPO/OCR/FX/AvaTax/IdP/mail).

## A. Already done in this continuation (no authorisation needed)

| Item | Where | Result |
|---|---|---|
| Branch check | W + A | `debug/2026-09-24-full-application` = `45b403c` on top of `ccfc6e8` in both the workspace and the checkout; working trees clean; `main` still `ccfc6e8` (origin/main is at `1b43393` — the BUILD_NOTES commit and the debug commit are both unpushed) |
| Stale Git lock | A | `.git/index.lock`: 0 bytes, created 13:20:16 UTC by the bridge's own `git fetch/branch -f` (unlink is forbidden on the mounted folder), no git process alive, tree clean — genuinely stale; moved to `_to_delete/` (deletion is not permitted from the bridge; delete that folder when convenient). Reads now use `git --no-optional-locks` so no new lock is left behind |
| Workspace-only evidence backed up | W → chat + A | four archives (hashes in `BACKUPS_OF_WORKSPACE_EVIDENCE.md`); `.gitignore` now keeps the run's `*.log` files; `evidence/ws3/results/` tracked |
| Extra browser engines | W | Playwright Firefox 1495 and WebKit 2215 installed (B-05 becomes executable here) |

## B. Executable here (W) — awaiting only your go where marked

| # | Blocker | Action | Machine | Status |
|---|---|---|---|---|
| 1 | Prove the *commit* (not the working tree) passes CI's `check` job | fresh `git clone` of `45b403c` into a scratch dir, `npm ci`, empty DB, migrate, typecheck, lint, checks, build, seeds **without** reference data, adversarial, full Vitest, eval:gate, enterprise | W | **DONE** — every step 0 through Vitest 43 files / 698; `eval:gate` 1 (B-01, by design); `test:enterprise` needs the MSK reference sheet that CI does not have (passes with it) — `evidence/logs/07-clone-ci-mirror.log` |
| 2 | B-05 non-Chromium engines | rerun the WS3 scripts with `PW_BROWSER=firefox` / `webkit` on the final production build | W | **DONE** — Firefox 142 and WebKit 26: matrix 264/264, axe 0 / overflow 0 of 88, keyboard 18/18, navigation 26/26, proposal journey green on both; request journey green on Firefox, WebKit-Linux engine abort at 42/47 (CW-DBG-0010 → Safari on a Mac) |
| 3 | B-11 5,000-line profile + soak | Ethicon labeler bulk-imported into the disposable library (~7 openFDA pages), 5,000-code intake profiled cold/warm, 30-min soak with web and Postgres restarts, mid-run SIGTERM resume | W | **DONE** — 111 s cold / 25.7 s warm, 24/24 soak runs complete, mid-run interruption resumed to a consistent complete run (TEST_RESULTS §7) |
| 4 | B-01 model-eval baseline | `OPENAI_API_KEY=<key> npm run eval:model` (measure only) → report → you decide → `-- --accept` → commit `data/eval/model-baseline.json`; then `scripts/eval-pacr.ts run … --llm` for the model-graded PACR comparison | W | **NEEDS ACCESS**: a model key. Pass it only for the run (env var to the command); it is never written to a file or a log. Do not put it in chat — paste it into `.env` on wumpus and I run the eval on **A** through the bridge instead, or give it as a one-shot |
| 5 | B-06 note-SKU check on the published crosswalk | `SELECT "ownSku", count(*) FROM "CrosswalkVersionEntry" WHERE "ownSku" IN ('DUPLICATE','REPEAT','HAND','DISCONT','ALTERNATE','WRONG','TAKE','THIS') GROUP BY 1;` (read-only) via the Neon connector | N | **READY** — needs your go (it is a read of the dev DB; a re-publish, if rows come back, is a data change and gets its own go) |
| 6 | B-12 `prisma generate` after the merge | `npx prisma generate` in the checkout (no migration in this run) | A | **READY** once merged |

## C. Needs access you must provide

| # | Blocker | What is needed | Then runs on |
|---|---|---|---|
| 7 | B-02 container build/boot | either a Docker host, **or** push the branch and open a PR — the `image` job in GitHub Actions builds `crosswalk:ci`, boots it with `JOBS_WORKER=external`, checks `/api/health`, the CSP header and the `check` role with strong/weak secrets. Pushing is yours (**pending your authorisation of scope**: push the branch only? open a PR? merge to main?) | GH |
| 8 | B-01 (second half) CI green | after the baseline is accepted (#4) the `check` job's last step passes; until then every CI run on this branch/PR/main fails at `eval:gate` by design | GH |
| 9 | B-03 live providers | per `docs/INTEGRATION_SETUP.md` "Required from the customer": Salesforce Connected App + run-as user + sandbox + GPO field + quote object names; SAP Gateway URL/client + technical user; Premier/Vizient/HealthTrust roster access; OCR vendor (or stay manual); FX vendor (ECB default needs nothing); AvaTax account; SAM.gov key; SMTP + Teams webhook; Google service account + Drive folder; IdP (Entra/Okta) app registration (`SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, redirect URI) | C → then Settings → Integrations Test / Validate / Sync a test record on whichever machine hosts the app |
| 10 | B-04 macOS | a Mac: `git checkout mac-demo` (after merging `main` into it), `npm run mac:setup -- --docker`, `mac:doctor`, `mac:start`, then the demo list → PDF → proposal | M |
| 11 | B-10 benchmark lists / PACR export | historical account lists into `data/benchmark/` and the REQ-7628 PACR export for `seed-sanford-benchmark.ts` / `eval-pacr.ts run` | W (files are reference data: stage them, never commit) |
| 12 | Production secrets before any real deploy | `SESSION_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`, `METRICS_TOKEN`, `SSO_PROXY_SHARED_SECRET` (only with `SSO_MODE=proxy`), `OWN_LABELERS` if not Covidien/Medtronic/Sofradim, `TRUST_PROXY_HOPS` only behind a balancer; `npm run secrets:check` with `NODE_ENV=production` proves them | the deploy host |

## D. Owner decisions (nothing to run until decided)

**2026-09-25 — #13, #14 and #15 no longer need an owner.** Alex asked for the decisions to be
resolved without user input where the data allows, and built into Crosswalk where it does not
(the platform serves many companies; nobody at them owns a spreadsheet of corrections). #13 is
answered by the labeler's own catalog (sibling-family evidence, MATCH_QUALITY_MODEL §3.4); #15 by
GUDID for Thoracoport plus the in-app **Evidence conflicts** queue for the flagged rows and any like
them (§5.5); #14 by a per-company Settings switch with the narrower default (DATA_ACCESS_POLICY).
BLOCKERS B-07/B-08/B-09 carry the detail. What remains for a person: settle the queue on a real
deployment from the Crosswalk page (one click per row), and pick the visibility rule in Settings
if the default is not wanted. The rows below are kept as the record of the original question.

| # | Blocker | Decision | Consequence |
|---|---|---|---|
| 13 | B-07 | Is Ethicon **B12LTH** (ENDOPATH XCEL Bladeless 12 × 100 mm) non-optical? The GUDID text has no OPTIVIEW/optical marker; three curated sheets cross it to the optical VersaOne ONB12STF as "Exact" | if non-optical: current behaviour stands (NONB12STF first, curated Exact demoted to Close with the "contradicted" label) — record the sign-off in MATCH_QUALITY_MODEL §4; if optical: add a competitor-size/spec row (curated-spec has top priority) and the curated Exact returns |
| 14 | B-08 | Should a child account under an **unassigned** parent be visible to every rep when the child itself has an owner/territory elsewhere? | if no: `accountWhere` parent clause limited to children with no owner and no territory + a scope test; if yes: document the rule as intended |
| 15 | B-09 | Thoracoport 179301/303/305/307 sold as sleeves or trocars? The 14 curated rows classified stale/inconsistent (REQ-7628 report §8) — retire, correct or keep? | sheet owner edits the source sheet; re-seed; `npm run eval` |
| 16 | Merge / release scope | merge `debug/2026-09-24-full-application` into `main` (and `main` into `mac-demo`)? tag? version stays 0.7.0? | I prepare the merge commit locally on request; the push is yours |
| 17 | Re-publish crosswalk on Neon if #5 finds rows | Crosswalk → Publish new version (proposals stay pinned to their old version) | after #5 |

## E. Things I will not do without an explicit scope from you

Push (any branch), merge into `main`/`mac-demo`, deploy, apply anything to Neon (even `migrate deploy` — none is
pending), call any real provider, send mail/Teams, write to Drive, accept a model baseline, run
`catalog:hygiene --apply` / retention against a shared DB, or delete files on wumpus.

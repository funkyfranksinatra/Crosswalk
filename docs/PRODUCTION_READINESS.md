# CRACR — from working prototype to production

State at handoff (v0.3, Sept 2026): the full pipeline works end to end on a
laptop — intake → GUDID resolution → attribute binning → ranking → model
grading → editable cross-reference and customer proposal, with Google Sheets
in and out. On the reference account list it identifies 29/30 competitor codes
(legacy PACR: 13/33) and agrees with PACR's product choice on every line PACR
could answer. What follows is what still stands between that and a system a
sales organisation can rely on. Items are grouped by theme and roughly
ordered by leverage within each theme; the first block is the minimum for a
pilot with real reps.

## 1. Minimum for a supervised pilot

| # | Work | Why | Notes |
| --- | --- | --- | --- |
| 1.1 | **Authentication + per-user attribution** | Exports go to customers; someone has to own each line. Every request, selection and override should record who did it. | SSO (Entra ID / Okta) via NextAuth or Auth.js; `Request.createdBy`, `MatchCandidate.selectedBy`. |
| 1.2 | **Postgres instead of SQLite** | Concurrent reps, backups, hosted deploy. | Prisma provider swap + `@prisma/adapter-pg`; the schema is already portable. Keep SQLite for local dev via `DATABASE_URL`. |
| 1.3 | **Hosted deployment** | Reps won't run `npm run dev`. | Container image (`next start`) behind the company's reverse proxy; env-driven config already in place. Add health endpoint + structured logs. |
| 1.4 | **Secrets management** | `OPENAI_API_KEY`, Google service account. | Vault / cloud secret store injected at runtime; rotate the key used during development. |
| 1.5 | **Review workflow** | Nothing should reach a customer unreviewed. | Line status (proposed → reviewed → approved), reviewer assignment, block "Contract offer" export until every included line is approved. Schema hooks: `RequestLine.reviewStatus`, `reviewedBy`. |
| 1.6 | **Learning loop** | Every rep correction is ground truth. | When a rep selects a non-top candidate or edits a match type, write a `KnownCross` (source = `rep`, with account + user) so the next run and the eval benefit. |
| 1.7 | **Real pricing data** | Ranking on price/COGS/margin is wired but running on list prices for 8 SKUs. | Nightly import from the pricing system (the import already accepts a Sheets link or file; add an API/ETL source). Pricebook tiers per account/GPO. |

## 2. Accuracy and data

| # | Work | Why | Notes |
| --- | --- | --- | --- |
| 2.1 | **Competitor size table** | GUDID has no dimensions for Ethicon meshes and most reloads; those lines tie to our smallest product. | Import exists (Catalog → Competitor sizes). Populate it from competitor catalogs / IFUs for the top 200 competitor codes by spend; consider a shared master maintained by product marketing. |
| 2.2 | **Larger benchmark** | One account list (30 lines) is an anecdote. | Run 5–10 historical account lists through both tools; make `scripts/eval.ts` report per-family accuracy; publish the numbers internally before external marketing claims. |
| 2.3 | **Catalog scope** | 321 SKUs today (endomechanical + hernia). | Decide per division; `Add SKUs` handles hundreds, but thousands need embedding retrieval (2.6). |
| 2.4 | **Model evaluation harness** | Grading is model-assisted; changing `LLM_MODEL` or the prompt must be measurable. | Record grade agreement vs curated crosses per model/prompt version (`LlmGrade.model` is already stored). Gate prompt-version bumps on the eval. |
| 2.5 | **Unit tests → proper test runner** | `scripts/check.ts` is a start. | Move to `node:test` or Vitest; add pipeline tests with a fixture DB and recorded openFDA responses (no network in CI). |
| 2.6 | **Embedding retrieval** | Attribute-neighbour retrieval is O(catalog) per line. | Fine to ~2k SKUs; beyond that store embeddings (pgvector) and retrieve top-k before scoring. |

## 3. Operations

| # | Work | Why |
| --- | --- | --- |
| 3.1 | **Background job runner** | Runs execute in-process (`startRun`); a server restart loses a running request. Move to a queue (pg-boss on Postgres is enough) with resumable stages. |
| 3.2 | **Rate limiting + retries for openFDA** | Public API, 240 req/min without a key, 1000/min with `OPENFDA_API_KEY`. Add exponential backoff and a per-process token bucket; cache GUDID records with a TTL (they are already cached, but never expire). |
| 3.3 | **Observability** | `LlmCall` and the run log exist; ship them to the company's logging/metrics stack. Alert on preflight failure (model unreachable) and on resolution rate dropping below a threshold per run. |
| 3.4 | **Backups + retention** | Requests contain customer purchase data. Define retention and access policy with legal; encrypt at rest. |
| 3.5 | **Audit trail** | Who exported what, when, to which customer — required if the proposal becomes a contract artefact. |

## 4. Product polish

* Bulk actions on the request view (accept all Exact, flag all Verify).
* Side-by-side compare of competitor GUDID record and our candidate (the data is in the DB; only the UI is missing).
* Rep notes per line that flow into the customer proposal.
* Notifications when a run completes (email/Teams) once runs are queued.
* Multi-company support is modelled (`Company`) but the UI assumes one; decide if it stays single-tenant.

## 5. Security review checklist

* Uploaded spreadsheets are parsed with ExcelJS server-side — fuzz the parser; cap file size (currently unbounded) and row count.
* Google Sheets links are fetched server-side — restrict to `docs.google.com` (done) and add a timeout.
* Model prompts include competitor descriptions from GUDID (untrusted text). Structured outputs bound the response shape; still, never let model output reach a shell, a URL or the DB unvalidated (it doesn't today — keep it that way).
* API routes have no auth today (1.1) and no CSRF protection; both come with the auth layer.
* Dependency audit in CI (`npm audit --omit=dev` or Dependabot).

## Suggested first sprint

1. Auth + Postgres + container deploy (1.1–1.4) — unblocks everything else.
2. Review workflow + learning loop (1.5, 1.6).
3. Competitor size table for the top codes and a 5-account benchmark (2.1, 2.2).

Everything in this document is additive; nothing in the current codebase
needs to be rewritten to get there.

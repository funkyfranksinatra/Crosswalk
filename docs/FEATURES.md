# Crosswalk — feature inventory and roadmap

State of the build at v0.4.x (Sept 17, 2026), after the enterprise platform work,
the GUDID library, the integration-connection work and the agentic debug run.
Part 1 is what exists and is exercised by a test. Part 2 is what does not exist
yet, ordered by what blocks the next step rather than by size.

Companion documents: `ARCHITECTURE.md` (how the cross-reference engine works),
`ENTERPRISE_ARCHITECTURE.md` (the commercial domain model and §13 implementation
record), `BUSINESS_RULES.md` (rule → file → test), `INTEGRATIONS.md` (systems of
record and what each one still needs), `FULL_APPLICATION_DEBUG_REPORT.md` (the
38 defects found and fixed, and the risks deliberately left open).

---

## Part 1 — What is built

### 1. Cross-reference engine

| Feature | Where |
| --- | --- |
| Intake of a customer's competitor purchases (`.xlsx`, `.csv`, Google Sheets link, paste) with header detection, quantity/price sanity checks and a preview before the run | `src/lib/excel/intake.ts`, `/requests/new` |
| Competitor code resolution against GUDID — library first, openFDA for what the library lacks, per-variant caching | `src/lib/pipeline/resolve.ts`, `src/lib/gudid/openfda.ts` |
| Attribute binning of every device (material, construction, coating, barrier, absorbability, dimensions, count, sterility, single-use, specialty panel), versioned as `BIN_VERSION` so bumps re-bin | `src/lib/match/bin.ts` |
| Deterministic scoring and ranking of our SKUs against each competitor bin, with family-scoped candidate pools and provenance tie-breaks (curated catalog outranks bulk-imported) | `src/lib/match/score.ts` |
| Model-assisted grading of the shortlist, siblings graded together in one call so re-runs cannot flip lines; verdict cache keyed by prompt + bin version | `src/lib/match/grading.ts`, `src/lib/llm/` |
| Known-cross floor: a curated cross always beats a computed one | `src/lib/xref/governance.ts` |
| Match tiers (Exact / Close / Alternative / Not found) with written rationale per line | `src/lib/match/grading.ts` |
| Run orchestration with progress, per-stage log, cancel, and re-run | `src/lib/pipeline/run.ts`, `/requests/[id]` |
| Editable results: swap in any candidate, override match type, add notes | `/requests/[id]`, `api/requests/[id]/lines/[lineId]` |
| Export to workbook or Google Sheets; cost/margin columns hidden by role | `src/lib/excel/export.ts`, `src/lib/sheets/` |
| Offline deterministic fallback when no model is configured | `src/lib/llm/client.ts` |
| Accuracy harness against the legacy PACR export (`scripts/eval.ts`) | `docs/REQ-0013_vs_PACR_comparison.md` |

### 2. GUDID library

Bulk import of a whole labeler's GUDID catalog from openFDA (`GudidDevice`,
`GudidImport` job rows with progress, log and cancel), split by FDA product code
and brand to get past the 26k-per-query cap; in-distribution and product-code
filters; a preview count before starting; re-import refreshes changed records.
Imported records resolve competitor codes without a network call. Our own
labelers' records can be adopted into the catalog per row or in bulk, filtered by
family, with non-surgical FDA panels excluded and a `pruneAdopted` cleanup.
Permission: `manage_catalog`.

### 3. Catalog and cost

Own-product catalog with description, family, list price and retirement;
`StandardCost` resolved plant → region → global with explicit effective dating;
FX conversion with an explicit rate table (no implicit conversion); cost import
from spreadsheet (idempotent, per-row reasons for skipped rows); competitor size
import for codes GUDID does not size; GUDID enrichment of our own SKUs.

### 4. Contracts and the price waterfall

LIST → NATIONAL → GPO tier → IDN → LOCAL resolution with precedence override,
effective dating, currency isolation (a EUR contract never prices a USD
question), quantity bands, approval state, and a written explanation of which
contract applied and why. Contract hierarchy, scopes by family, volume-tier
entries, rebate schedules, bundle terms, structured clauses, price protection and
renewal terms. Contract lifecycle rules (no reactivating a terminated or
superseded contract; expired contracts need an end date). Contract performance
and a renewal pipeline view.

### 5. Competitor price intelligence

Append-only `CompetitorPriceObservation` with source type (invoice, PO, bid file,
GPO contract file, rep-observed, anecdotal, win/loss), verification state and
provenance. Confidence = raw source weight × verification × half-life decay;
relevance weighted by account, GPO and region; a basis label (KNOWN_ACCOUNT /
MARKET_ESTIMATE / WEAK / NONE) rather than a false point estimate. UOM mismatches
are excluded and explained. Import from spreadsheet; per-observation verify.

### 6. Pricing policy and recommendation

Versioned `PricingPolicy` per product family (draft → active), with floor margin,
discount authority thresholds by role, strategy (MATCH / UNDERCUT / HOLD_PREMIUM
/ PRESERVE_CONTRACT / STRATEGIC_DISCOUNT / PENETRATION), and validation that
refuses a policy which would disable floors or invert authority. Recommendation
clamps to [floor, reference], never invents a margin when cost is missing, and
produces both a full explanation and a redacted `explanationPublic` for roles
that may not see cost.

### 7. Proposals, economics and scenarios

Proposal built from a cross-reference run (snapshot lines: competitor code, our
SKU, quantity, list, applicable contract price, cost, floor, recommendation);
per-line proposed price with derived margin and discount-from-list /
-from-contract; include/exclude lines; justification notes; deal economics
(revenue, blended margin, mix); named what-if scenarios with bulk apply;
versioning (v2 clones the deal); quote export to workbook; validity dating with
expiry enforcement.

### 8. Approvals (deal desk)

Every included line is re-evaluated against its policy at submission; lines
inside the submitter's own authority are auto-approved and audited; the rest are
routed to the lowest role that can decide them (rep → manager → contracting →
director → committee). Atomic claim on submit and on decide (concurrent
submitters and concurrent approvers both resolve to exactly one outcome);
approvers decide the price they reviewed (snapshot check voids a stale request);
resubmission supersedes prior requests; no self-approval except ADMIN;
below-floor decisions need a separate permission; reopen withdraws live requests;
`canFinalize` gates export, CRM push and marking a deal won.

### 9. Outcomes and post-win compliance

WON creates a LOCAL contract with effective-dated price entries and commitments
atomically, so the waterfall immediately resolves to the prices that were
approved; LOST records the competitor and their winning prices as intelligence;
commitment tracking, conversion measurement against purchase records, renewal
pipeline.

### 10. Crosswalk governance

Rep-proposed crosses start as drafts invisible to other reps; clinical and
marketing review; approval requires both signatures and a non-NONE equivalence
level; published `CrosswalkVersion` is frozen and proposals pin the version they
were built on.

### 11. Analytics

Win/loss, pricing effectiveness, conversion, and cross-reference accuracy (rep
acceptance vs validated accuracy) read models.

### 12. Integrations

Adapter interfaces for CRM, ERP and GPO with three connection routes: a file feed
(`INTEGRATION_FEED_DIR` with crm-accounts, crm-opportunities, erp-skus,
erp-costs, erp-purchases, gpo-memberships CSVs, quotes written back to
`outbound/quotes/`), vendor API skeletons selected by environment variables
(Salesforce, SAP — they throw `NotConfigured` rather than pretending), and
labelled dev fixtures. Sync is idempotent with a `SyncLog`, reconciles accounts
by external ref → CRM id → account number, and fails loudly on a conflict. A
"How to connect" panel in Settings → Integrations shows what is present.

### 13. Security, RBAC and audit

Eleven roles with a permission matrix and an ordered authority ladder; an API
gate (`src/proxy.ts`) that refuses unauthenticated `/api/*`; HMAC-signed session
cookies (`SESSION_SECRET`), dev sign-in refused in production builds unless
`ALLOW_DEV_SIGNIN=true`, and an SSO header contract (`x-sso-subject`) ready for a
real provider; server-side redaction of cost, margin and floor — including nested
recommendation/waterfall JSON, audit rows and exported workbooks; generic error
messages (no driver or Prisma text reaches a client); validated and capped
uploads; CSV formula-injection neutralisation; security headers (nosniff, DENY,
referrer, permissions, no-store); full before/after/context audit trail.

### 14. Platform

PostgreSQL on Neon with Prisma 7 driver adapters (`pg`, `neon-ws`, `neon-http`);
decimal money end to end with a single arithmetic module and storage at the
currency's minor unit; batched line recomputation via raw `UPDATE … FROM
unnest()` (300-line deal: recompute 0.4 s, submit 7 s); seeds that work with or
without the curated reference sheets; CI on Postgres 17 (migrate, typecheck,
`check` 19, `check:enterprise` 21, build, seeds, `test:adversarial` 24) plus
`test:enterprise` 18 end to end against a real database.

---

## Part 2 — What still needs building

### Tier 0 — required before any shared or customer-facing deployment

| # | Work | Why it blocks |
| --- | --- | --- |
| 0.1 | **SSO (OIDC — Entra ID / Okta)** behind an authenticating proxy, and removal of `ALLOW_DEV_SIGNIN` from every shared instance | Identity is still a development mechanism; the adapter contract exists, the implementation does not |
| 0.2 | **Ownership / territory scoping** (rep → their accounts and proposals, manager → territory) | Any signed-in user can open any account's deals today; this is horizontal access control, and it is a business decision about what a rep may see |
| 0.3 | **Credential hygiene** — rotate the Neon `crosswalk_owner` password, per-environment branches, a secret store for `OPENAI_API_KEY` and the Google service account | One shared credential across dev, CI and the laptop |
| 0.4 | **Hosted deployment** — container image behind the company proxy, health endpoint, structured request logs with request ids | Reps will not run `npm start` |
| 0.5 | **Rate limiting and a CSP** | No throttle on any route; no content-security policy |
| 0.6 | **Database CHECK constraints** on status / type / equivalence columns | Enums are enforced in application code only; a direct write or a future code path can seed an invalid state |
| 0.7 | **Backups, retention and access policy** | Requests hold customer purchase data; encryption at rest and a retention decision need legal sign-off |
| 0.8 | **ADMIN self-approval decision** | ADMIN can currently approve their own request; either forbid it or make it an audited break-glass |

### Tier 1 — pilot quality

| # | Work | Why |
| --- | --- | --- |
| 1.1 | **Job queue (pg-boss) with resumable stages** for runs, GUDID imports and syncs | Everything runs in-process; a restart loses a run |
| 1.2 | **openFDA backoff, token bucket and cache TTL** | Whole-labeler imports are the one place the public rate limit bites; cached GUDID records never expire |
| 1.3 | **Learning loop** — a rep's correction (non-top candidate, edited match type) becomes a `KnownCross` with account and user | Every correction is ground truth that is currently thrown away |
| 1.4 | **Real cost and price feeds** on a schedule, replacing manual imports | Ranking on price/COGS/margin is only as good as the last spreadsheet |
| 1.5 | **Competitor size master populated** for the top few hundred competitor codes by spend | Ethicon meshes and most reloads carry no dimensions in GUDID, so those lines tie to our smallest product |
| 1.6 | **Larger accuracy benchmark** — 5–10 historical account lists, per-family reporting, published internally before any external claim | One 30-line account list is an anecdote |
| 1.7 | **Model evaluation harness** gating prompt and model changes on measured agreement | `LLM_MODEL` or a prompt edit can silently move accuracy |
| 1.8 | **Proper test runner** (`node:test` or Vitest) with a fixture database and recorded openFDA responses | Three hand-rolled suites; no network isolation for pipeline tests |
| 1.9 | **Observability** — ship `LlmCall`, run logs and sync logs to the company stack; alert on model unreachable and on resolution rate dropping | Failures are visible only in the UI today |
| 1.10 | **Notifications** (email / Teams) on run completion, approval requested, approval decided | Deal desk currently depends on someone refreshing the queue |
| 1.11 | **Proposal context-drift warning** | A draft created before a GPO or contract change silently keeps its snapshot (by design); the UI does not say the live context moved |

### Tier 2 — integrations that need credentials or a data owner

| # | Work | Needed from the organisation |
| --- | --- | --- |
| 2.1 | **Salesforce adapter** (accounts, opportunities, quote write-back) + webhook route | Login URL, client id/secret or JWT key, quote object agreement, GPO-affiliation field |
| 2.2 | **SAP ERP adapter** (material master, condition prices, standard cost by plant, billing documents) | OData base URL, client, credentials, exposed services, plant/region code mapping |
| 2.3 | **GPO roster feeds** (Premier / Vizient / HealthTrust) | File drops or API with member roster, tier and effective dates |
| 2.4 | **Document extraction / OCR** for invoices and bid files | A provider decision; `Document.extractionConfidence` is modelled, extraction is manual |
| 2.5 | **FX rate feed** (ECB / Treasury / SAP TCURR) | Only needed when non-USD contracts appear; rates are entered by hand today |
| 2.6 | **GPO contract price files for competitor products** | A data owner in product marketing or contracting |

### Tier 3 — product and scale

| # | Work | Note |
| --- | --- | --- |
| 3.1 | Bulk actions on a cross-reference run (accept all Exact, flag all Verify) | Pure UI; the data is there |
| 3.2 | Side-by-side compare of the competitor GUDID record and our candidate | Pure UI; the data is there |
| 3.3 | Rep notes per line flowing into the customer-facing proposal | Notes exist internally; the quote does not carry them |
| 3.4 | Branded quote / contract-offer templates (PDF as well as workbook) | Today the customer artefact is a workbook |
| 3.5 | Embedding retrieval (pgvector) before scoring | Scoring is O(catalog) per line — fine to ~2k SKUs, not beyond |
| 3.6 | Multi-tenant decision | `Company` is modelled; the UI assumes one |
| 3.7 | Tax and freight | Explicitly out of scope on the quote today; a boundary, not a gap, until someone owns it |
| 3.8 | Analytics as materialised read models | Computed on request; fine at current volume |
| 3.9 | Approval delegation / out-of-office | A director on holiday blocks their queue |
| 3.10 | Competitor intelligence from public bid databases | Currently every observation is entered or imported by a person |

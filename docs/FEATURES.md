# Crosswalk — feature inventory and roadmap

State of the build at v0.7 (Sept 19, 2026), after the enterprise platform work, the GUDID
library, the integration-connection work, the agentic debug run, the Tier 1, Tier 3 and
Tier 0 builds.
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

### 15. Pilot-quality platform (Tier 1, Sept 17, 2026)

| Feature | Where |
| --- | --- |
| Job queue (pg-boss in the app database): runs, GUDID imports, feeds, deliveries and alert checks survive restarts; stage-checkpointed runs and page-cursored imports resume; orphans re-queued at start; cancel; inline or external workers | `src/lib/jobs/`, `src/instrumentation.ts`, `scripts/worker.ts` |
| One openFDA client with a token bucket at 80 % of the limit, jittered backoff honouring Retry-After; GUDID cache TTL with background refresh (nightly sweep + on use) | `src/lib/gudid/http.ts`, `src/lib/gudid/refresh.ts` |
| Learning loop: a rep's override becomes a DRAFT rep cross with evidence and a MatchDecision; the matcher uses it as a soft prior until review approves it | `src/lib/xref/learning.ts`, `src/lib/match/score.ts` |
| Scheduled feeds (crm, erp, gpo, pricing, competitor-sizes, competitor-prices) with FeedRun history, unchanged-file skip, freshness and failure alerts | `src/lib/feeds/` |
| Competitor size worklist ranked by estimated spend; the size template in that order | `src/lib/catalog/size-coverage.ts` |
| Multi-list accuracy benchmark with per-family / per-tier reporting, persisted runs, cases from files or reviewed requests | `src/lib/eval/benchmark.ts`, `scripts/benchmark.ts` |
| Model evaluation harness and gate: grading agreement vs curated crosses, accepted baseline, CI fails on an unmeasured prompt / bin / model change | `src/lib/eval/model.ts`, `scripts/model-eval.ts`, `data/eval/model-baseline.json` |
| Vitest runner: pure checks bridged, Tier 1 unit tests, recorded-openFDA replay (no network), database-backed Tier 1 suite | `vitest.config.mts`, `tests/` |
| Observability: JSON logs with request ids, `/api/health`, `/api/metrics` (Prometheus), NDJSON export, alert rules with dedupe / re-notify / resolve, Settings → System | `src/lib/log.ts`, `src/lib/observability/` |
| Notifications: in-app inbox with per-kind channel switches, email (SMTP) and Teams (webhook) delivered by the queue with retries | `src/lib/notifications/`, `/notifications` |
| Proposal context drift: per-line diff against live contracts, costs, policies and crosswalk version; audited one-click refresh of an unlocked draft; cost deltas redacted by role | `src/lib/proposals/drift.ts` |

Operating guide: `docs/OPERATIONS.md`. Verification: `docs/TIER1_DEBUG_REPORT.md`.

### 16. Product and scale (Tier 3, Sept 18, 2026)

| Feature | Where |
| --- | --- |
| Bulk actions on a run — mark all Exact (or all matched) reviewed, select the top candidate where nothing is selected, flag everything needing attention to verify, clear flags / reviewed marks; scopes computed server-side, learning loop and audit as for single lines; a `flag` on the line with a Flagged filter | `src/app/api/requests/[id]/bulk/route.ts`, `src/app/requests/[id]/view.tsx` |
| Side-by-side compare — the competitor's GUDID record and our candidate's, attribute by attribute (GUDID fields, sizes, single-use / sterile / implantable, specialties, then the bins the matcher compared), differences highlighted, switchable across candidates | `src/app/api/requests/[id]/lines/[lineId]/compare/route.ts` |
| Customer-facing line notes — `customerNote` on the request line flows onto the proposal line and is what the quote / offer print; the internal justification and rep note never reach the customer | `RequestLine.customerNote`, `ProposalLine.customerNote`, `src/lib/proposals/export.ts` |
| Branded PDFs — quotation from an approved proposal and contract offer from a run: letterhead (logo, legal name, address, colours), paginated line table, subtotal / freight / tax / total, notes and terms; Settings → Branding | `src/lib/pdf/`, `src/lib/branding.ts`, `src/app/settings/branding.tsx` |
| Embedding retrieval — pgvector columns on own and competitor products, `text-embedding-3-small`, hash-skipped refresh (nightly job, after imports, `npm run embed`); a line's shortlist is its nearest neighbours, the attribute scan is the per-line fallback; coverage on Settings → System | `src/lib/match/embeddings.ts`, `src/lib/pipeline/run.ts` (Phase A), `scripts/embed.ts` |
| Single tenant made explicit — one company per deployment: startup check and Settings → System line, seeds never create a second company | `src/lib/tenancy.ts` |
| Tax and freight — quote-level freight (flat or % of subtotal) and tax (excluded / exempt / manual rate / AvaTax provider, uncommitted SalesOrder); calculated on demand, stale after a price or freight change, never part of margin, floors or approvals; ship-to per proposal or account default | `src/lib/tax/`, `src/app/api/proposals/[id]/logistics/route.ts`, `src/app/proposals/[id]/logistics.tsx` |
| Materialised analytics — every report is a stored snapshot refreshed hourly and after outcomes / decisions; pages show "as of" and a Refresh; `?fresh=1` recomputes | `src/lib/analytics/snapshots.ts`, `/api/analytics/[report]` |
| Approval delegation / out-of-office — lend discount authority (never ADMIN) to a colleague for a window; the delegate sees the queue and decides in their own name with `onBehalfOfUserId` recorded; no approval by proxy of the delegator's own submissions; both parties notified | `src/lib/approvals/delegation.ts`, `/approvals` |
| Public bid intelligence — SAM.gov award notices (API key) and USAspending contract awards (no key) pulled daily by NAICS / PSC / keywords into `PublicAward`, awardees matched to competitors; bid tabulations from state / hospital portals imported as CSV / XLSX, line prices becoming `PUBLIC_BID_DB` price observations; `/intelligence/bids` | `src/lib/intelligence/bids.ts`, `src/app/intelligence/bids/` |

Verification: `docs/TIER3_DEBUG_REPORT.md`.

### 17. Security and deployment readiness (Tier 0, Sept 19, 2026)

| Feature | Where |
| --- | --- |
| Built-in OIDC client — authorization code + PKCE against Entra ID / Okta / any discovery-capable provider; ID token validated against the provider's JWKS (issuer, audience, expiry, nonce); subject → user by `externalId` then email, provisioning on first sign-in, roles synced from a configurable claim through an optional name map; Crosswalk's own signed, expiring session cookie; SSO sign-in / sign-out in the UI; `SSO_MODE=proxy` keeps the `x-sso-subject` contract | `src/lib/auth/oidc.ts`, `src/app/api/auth/oidc/{start,callback,logout}`, `src/components/sign-in.tsx` |
| Ownership / territory scoping — reps and regional managers see the accounts they own, in their territory, unassigned, children of visible IDNs, and what they created; requests, proposals and contracts follow their account; every other role sees everything; out-of-scope rows are 404; one central hook covers every `/api/{accounts,requests,proposals,contracts}/<id>/…` route, list routes and pages are filtered, writes against a foreign account refused | `src/lib/auth/scope.ts`, `src/lib/api.ts`, `src/proxy.ts` (`x-crosswalk-path`) |
| Secret loader and production checks — `SECRETS_PROVIDER=env\|aws\|vault\|doppler\|file` fetched once at start-up (web, worker, container migrate step); a production build refuses the development session key, placeholder secrets, example database passwords and remote databases without TLS; `npm run secrets:check`. Neon `crosswalk_owner` rotated; `staging` and `ci` branches | `src/lib/secrets.ts`, `src/instrumentation.ts`, `scripts/with-secrets.ts` |
| Container image and compose stack — one image for web / worker / migrate / check roles, migrate-on-start through the secret loader, `HEALTHCHECK`, CI builds and boots it against Postgres; `deploy/docker-compose.yml` with pgvector | `Dockerfile`, `deploy/`, `.github/workflows/ci.yml` (`image`), `docs/DEPLOYMENT.md` |
| Rate limiting and security headers — per-client fixed windows by route class (sign-in 20/min, heavy writes and exports 60/min, API 600/min; `429` with `Retry-After`); nonce-based Content Security Policy on pages (`script-src 'self' 'nonce' 'strict-dynamic'`, no third-party origins, never framed), nosniff / referrer / permissions policies, COOP, HSTS over TLS | `src/lib/security/ratelimit.ts`, `src/lib/security/headers.ts`, `src/proxy.ts` |
| Database CHECK constraints — 44 enum constraints on state / type columns tied to the code's own lists (`ROLES`, `KINDS`, `EQUIVALENCE`, `SOURCE_TYPES`) and 15 expression constraints (non-negative quantities, prices, costs, tax; policy margins as fractions; freight percent 0..100; date windows in order); migration generated from the definition and pinned by a test; `npm run db:preflight` before migrating | `src/lib/db/constraints.ts`, `prisma/migrations/20260919000100_tier0_check_constraints`, `scripts/db-preflight.ts` |
| Retention, backups, access policy — nightly retention sweep, off until `RETENTION_ENABLED=true`, customer purchase data only with an explicit window, audit never swept, dry-run and batched, every sweep audited; backup / PITR / restore-drill runbook; data access policy for legal sign-off | `src/lib/retention.ts`, `scripts/retention.ts`, `docs/BACKUPS.md`, `docs/DATA_ACCESS_POLICY.md` |
| Audited break-glass — an ADMIN may approve their own request only with a written reason; stored flagged, two audit events, every other ADMIN and PRICING_DIRECTOR notified; non-admins still cannot | `src/lib/approvals/service.ts` (`decide`), `src/lib/notifications/index.ts` (`BREAK_GLASS`) |

Verification: `docs/TIER0_DEBUG_REPORT.md`.

---

## Part 2 — What still needs building

### Tier 0 — required before any shared or customer-facing deployment

Built (Part 1 §17). What remains is configuration and sign-off, not code:

| # | Was | Left to the organisation |
| --- | --- | --- |
| 0.1 | SSO | Register the app with Entra ID / Okta, set `SSO_*`, decide the group → role map (`docs/DEPLOYMENT.md` § Identity) |
| 0.2 | Ownership scoping | Populate `Account.ownerUserId` / `territory` and `User.territory` from the CRM (the sync carries them when the CRM does) |
| 0.3 | Credential hygiene | Move `OPENAI_API_KEY`, the Google service account and `SESSION_SECRET` into the chosen secret manager (`SECRETS_PROVIDER`); rotate the Neon password again once CI moves to the `ci` branch |
| 0.4 | Hosted deployment | Build and run the image behind the company proxy (`docs/DEPLOYMENT.md`) |
| 0.5 | Rate limiting / CSP | Tune `RATE_LIMIT_*` from real traffic; a shared limiter at the proxy when running several instances |
| 0.6 | CHECK constraints | `npm run db:preflight` before the first production migration |
| 0.7 | Backups, retention, policy | Raise Neon history retention to 7 days; schedule the off-platform dump; sign `docs/DATA_ACCESS_POLICY.md`; then `RETENTION_ENABLED=true` with the agreed `RETENTION_REQUESTS_DAYS` |
| 0.8 | ADMIN self-approval | Review break-glass events monthly (they are `BREAK_GLASS_APPROVAL` audit events and `BREAK_GLASS` notifications) |

### Tier 1 — pilot quality

Built (Part 1 §15). Two items depend on data the organisation supplies: the competitor
size master needs product marketing to fill the worklist template, and the benchmark and
model-eval baselines need historical account lists and a model key to be run once and
accepted.

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

Built (Part 1 §16). Decisions taken: single-tenant per deployment (3.6); AvaTax as the live
tax service with MANUAL / EXEMPT fallbacks (3.7); SAM.gov + USAspending + bid-file import for
public bids (3.10); pgvector + `text-embedding-3-small` for retrieval (3.5). What the
organisation supplies: AvaTax credentials, a SAM.gov API key, a logo and terms for the
letterhead, and `npm run embed` once with the model key.

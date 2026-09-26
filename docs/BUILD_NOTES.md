# Crosswalk — complete build notes

*Everything that exists in the application as of `main` @ `1b43393` (Sept 24, 2026): every feature,
module, function, workflow, page, route, job, script, test and build step, with the decisions that
shaped them. Written for whoever has to build, run, extend or audit Crosswalk without having been
in the room.*

---

## Contents

1. [What Crosswalk is](#1-what-crosswalk-is)
2. [History and versions](#2-history-and-versions)
3. [Technology stack and repository layout](#3-technology-stack-and-repository-layout)
4. [Setting up, building and running](#4-setting-up-building-and-running)
5. [Configuration: every environment variable](#5-configuration-every-environment-variable)
6. [Data model: 61 models and 15 migrations](#6-data-model-61-models-and-15-migrations)
7. [Identity, roles, permissions, scoping and redaction](#7-identity-roles-permissions-scoping-and-redaction)
8. [Request security: the proxy](#8-request-security-the-proxy)
9. [Workflow A — the cross-reference request](#9-workflow-a--the-cross-reference-request)
10. [The matcher in depth](#10-the-matcher-in-depth)
11. [Catalog, GUDID library, sizes and pricing imports](#11-catalog-gudid-library-sizes-and-pricing-imports)
12. [Crosswalk governance and the learning loop](#12-crosswalk-governance-and-the-learning-loop)
13. [Workflow B — accounts, contracts and the price waterfall](#13-workflow-b--accounts-contracts-and-the-price-waterfall)
14. [Workflow C — pricing policy and the recommendation engine](#14-workflow-c--pricing-policy-and-the-recommendation-engine)
15. [Workflow D — proposals, scenarios, drift, exports, logistics](#15-workflow-d--proposals-scenarios-drift-exports-logistics)
16. [Workflow E — approvals, delegation, break-glass, outcomes](#16-workflow-e--approvals-delegation-break-glass-outcomes)
17. [Competitive intelligence, documents and public bids](#17-competitive-intelligence-documents-and-public-bids)
18. [Integrations](#18-integrations)
19. [Background jobs, feeds, notifications, alerts, metrics, analytics, retention](#19-background-jobs-feeds-notifications-alerts-metrics-analytics-retention)
20. [User interface: the 22 pages](#20-user-interface-the-22-pages)
21. [API: the 101 routes](#21-api-the-101-routes)
22. [Scripts](#22-scripts)
23. [Tests and evaluation harnesses](#23-tests-and-evaluation-harnesses)
24. [Documentation index](#24-documentation-index)
25. [Decisions log](#25-decisions-log)
26. [Known issues, inconsistencies and gaps](#26-known-issues-inconsistencies-and-gaps)
27. [Operator checklists](#27-operator-checklists)
28. [Full-application debugging run (Sept 24)](#28-full-application-debugging-run-sept-24)

---

## 1. What Crosswalk is

Crosswalk (formerly CRACR — Competitor Product Cross Reference Engine; renamed Sept 14, 2026) is a
Next.js web application deployed *for one medical-device manufacturer* (the "company"; Medtronic in
every fixture). A sales rep uploads the list of competitor catalog numbers a hospital buys; Crosswalk
identifies each competitor product in the FDA's GUDID (through the openFDA Device UDI mirror), reduces
it to a structured "bin", finds the company's equivalent SKUs, grades them (Exact / Close /
Alternative / No Match) with a written rationale, prices them under the hospital's contracts, and
produces the rep's cross-reference workbook and the customer's offer. From there the platform carries
the deal through a priced proposal, policy-driven price recommendations, approval routing, a
contractual quote, a won-contract record, compliance tracking and analytics.

The whole system runs with nothing configured except a Postgres URL: no model key (heuristic mode),
no CRM/ERP, no SSO (dev sign-in). Every optional capability lights up when its credentials appear.

Two things define the engineering style throughout:

- **Deterministic first, model second.** Every decision has a rule-based path that runs alone; a
  model refines within bounds the rules set (a grade cap it cannot exceed, a bin draft it corrects).
- **Explain or don't propose.** Every candidate carries its evidence, every price its source and
  every refusal its reason. "A high-confidence Not Found is better than an incorrect cross."

---

## 2. History and versions

| Date (2026) | Commit(s) | Milestone |
|---|---|---|
| Sept 13 | `77323a3` | `create-next-app` |
| Sept 14 | `8363cfd` | **v0.3** — competitor cross-reference pipeline, Google Sheets I/O, sibling grading, sizes import (SQLite) |
| Sept 14 | `576eaa0` | Rename CRACR → Crosswalk |
| Sept 14 | `cbeb327` | **v0.4 Enterprise platform** — Postgres (Neon), contracts, pricing policy, proposals, approvals, governance, RBAC |
| Sept 15 | `31a71a3`, `732e90a` | GUDID library (bulk labeler import, library-first resolution); file-feed integrations, account reconciliation |
| Sept 15 | `1a7846c` … `ad67eb0`, `a3752d4` | Full-application debug run: 38 bugs (4 P0), adversarial suite in CI; CI seed fix |
| Sept 17 | `0a6f353` … `a5e6f66` | **Tier 1 pilot quality** — pg-boss queue, openFDA limits + cache expiry, learning loop, scheduled feeds, size worklist, benchmark, model-eval gate, Vitest, observability, notifications, drift; Tier 1 bug hunt (62 findings) |
| Sept 17 | `2ed8d90`, `10df856`, `e6dfd77` | Placeholder-SKU hygiene; model-eval baseline accepted (gpt-6-astra, 68% top-1); gate fix |
| Sept 17–18 | `cae1781`, `3563225`, `0056855` | **Tier 3 product and scale** — bulk actions, compare, customer notes, branded PDFs, pgvector retrieval, tenancy, tax/freight, analytics snapshots, delegation, public bids; Tier 3 bug hunt (48 findings) |
| Sept 18 | tag `v0.6.0`; branch `mac-demo` | Mac collaborator branch (compose on 5433, `scripts/mac/*`, `seed-demo.ts`, offline demo) |
| Sept 19 | `9287235` … `31d0aa3` | **Tier 0 security and deployment** — OIDC client, ownership/territory scoping, secret loader, rate limiting + CSP, CHECK constraints, retention, break-glass, container image/compose/CI image job; Tier 0 bug hunt (38 findings) |
| Sept 23 | `ca278ed` | **Tier 2 integration layer** — Salesforce, SAP OData, GPO rosters (Premier/Vizient/HealthTrust), document extraction, FX, competitor contract prices; schema-driven admin |
| Sept 23 | `8beb338`, `fd9f620`, `ea820a0` | Prisma CLI on Neon's direct host; engine round trips 4,872 → 1,998 per 300 lines; intake fix; PACR comparison (REQ-7628) |
| Sept 24 | `1b43393` | **Match quality model** — access-product profile, brand registry, hard/soft constraints, confidence, curated crosses as evidence, SELF_MATCH successors, contract pricing in runs, intake accounting; PACR superiority run |

`package.json` says `0.7.0` since the Sept 24 debug run (it was `0.4.0`); `FEATURES.md` calls the current state v0.7; the only tag is
`v0.6.0` (see §26). Branch `mac-demo` = `main` + 15 additive commits (tooling only, no `src/`
changes) and is merged forward after every `main` change (currently `21344fc`).

Delivery mechanics between the build workspace and Alex's checkout (`C:\Users\4141e\Documents\Crosswalk`
on "wumpus"; GitHub `funkyfranksinatra/Crosswalk`, private): commits travel as git bundles into
`.claude-bundles/`, then `git fetch <bundle> main:refs/bundles/main mac-demo:refs/bundles/mac-demo;
git reset --hard refs/bundles/main; git branch -f mac-demo refs/bundles/mac-demo`. Pushing is done
by Alex (`git push origin main mac-demo`); the bridge shell has no GitHub credentials.

---

## 3. Technology stack and repository layout

| Layer | Choice |
|---|---|
| Framework | Next.js **16.3.5** App Router, React 19.2.8, TypeScript 5, Tailwind CSS 4. `src/proxy.ts` is the request gate (Next 16 replaces middleware with proxy). `AGENTS.md`/`CLAUDE.md` warn that this Next.js differs from training data; read `node_modules/next/dist/docs/`. |
| Database | PostgreSQL 16/17 with **pgvector**; Neon in dev (`orange-mode-25480503`, branches `main`, `staging`, `ci`, `debug-run`). Prisma **7.10** with driver adapters: `pg` (TCP, default), `neon-ws` (WebSocket 443, HTTPS-only sandboxes), `neon-http` (scripts, no transactions). Client generated into `src/generated/prisma` (gitignored). SQLite (v0.3) retired; its migrations kept in `prisma/migrations-sqlite-v0.3/`. |
| Money | `decimal.js` (precision 28, banker's rounding) via `src/lib/money.ts` — the only place arithmetic happens. Columns `Decimal(18,4)` + `currency`. |
| Queue | **pg-boss 12** in the app database, schema `pgboss`, own pool. |
| Model | OpenAI Responses API (`openai` 7), structured outputs with zod schemas; default model id `gpt-5.6-astra` (`LLM_MODEL`). Embeddings `text-embedding-3-small` (1536 d). |
| Device data | openFDA Device UDI (`api.fda.gov/device/udi.json`), a searchable GUDID mirror. AccessGUDID's own API only supports DI lookup. |
| Files | `exceljs` (xlsx), `pdfkit` (PDF), CSV (RFC 4180, formula-injection guard), Google Sheets/Drive via `google-auth-library`. |
| Auth | Built-in OIDC client (`jose`, auth-code + PKCE), proxy-header mode, HMAC-signed dev sessions. |
| Tests | Vitest 5 (`tests/unit`, `tests/db`), tsx scripts for the pure check suites and the DB-backed enterprise/adversarial suites. |
| Container | `node:22-bookworm-slim` multi-stage image, tini entrypoint, roles web/worker/migrate/check. |

Repository layout:

```
src/app/                 pages (22) and API routes (101)            src/components/   6 shared components
src/lib/match/           matcher: bin, access, brands, component, constraints, score, grading, line, embeddings
src/lib/pipeline/        run.ts (resolve→bin→match→persist), resolve.ts (CFN → GUDID)
src/lib/gudid/           openFDA client, http budget, library import, refresh, enrich
src/lib/llm/             client (structured), tasks (binProduct, cfnHints)
src/lib/excel/ sheets/ pdf/  intake, export, pricing, sizes; CSV, Google; PDF documents
src/lib/contracts/ pricing/ proposals/ approvals/ compliance/ analytics/  commercial engine
src/lib/intelligence/    observations, summarize, imports, public bids
src/lib/integrations/    core/ (registry, runner, mapping, config, jobs, review, webhooks, …) + providers
src/lib/jobs/ feeds/ notifications/ observability/  runtime services
src/lib/auth/ security/ secrets.ts tenancy.ts retention.ts  platform
src/lib/db.ts db/constraints.ts money.ts cfn.ts log.ts api.ts audit.ts settings.ts branding.ts
prisma/                  schema (61 models), migrations (15), seed.ts, seed-enterprise.ts
scripts/                 20 tsx tools (+ scripts/mac/*.sh on mac-demo)
tests/                   unit (9), db (4), recorded openFDA, fixtures
docs/                    20 documents + docs/eval/
data/                    reference (gitignored sheets), eval baseline, fixtures, benchmark cases
deploy/                  entrypoint.sh, docker-compose.yml; Dockerfile at root
```

---

## 4. Setting up, building and running

### 4.1 First-time local setup

```
cp .env.example .env            # set DATABASE_URL (Postgres with pgvector), SESSION_SECRET
npm run setup                   # npm install → prisma generate → prisma migrate deploy → seed.ts → seed-enterprise.ts
npm run dev                     # http://localhost:3000; pg-boss workers start in-process (JOBS_WORKER=inline)
```

`prisma/seed.ts` loads the company, the curated catalog (313 SKUs), the curated crosses and the
HOSPITAL LIST PRICE book **only if** `data/reference/Endomechanical.xlsx` and
`SSXrefReport_REQ-7604.xlsx` are present (they are gitignored; request them from the owner);
without them it creates only the Company and the default pricebook. `-- --gudid` also enriches own
products from openFDA. `prisma/seed-enterprise.ts` always creates the 11 dev users (one per role,
`<name>@crosswalk.dev`), copies legacy COGS into StandardCost, creates accounts from existing
requests, pricing policies (`*` + 5 families), approves existing crosses and publishes crosswalk v1;
with demo data (default) it adds MSK under an IDN parent, Premier Tier 2, peer hospitals, plant costs,
a GPO contract at 24 % off list, a LOCAL override, banded stapler-reload prices, purchases,
competitor observations, an FX rate and dev integration fixtures (`-- --no-demo` skips these).

Sign in through the sidebar's dev identity box (lists the seeded users). In production the dev
sign-in is refused unless `ALLOW_DEV_SIGNIN=true`.

### 4.2 After pulling source changes

```
npm install                      # when package.json changed
npm run db:preflight             # rows that would violate CHECK constraints (before a constraint migration)
npx prisma migrate deploy
npx prisma generate
npm run dev
```

`prisma.config.ts` (CLI only) uses `DIRECT_DATABASE_URL`, else `DATABASE_URL` with Neon's `-pooler`
host segment removed — `prisma migrate` holds a session advisory lock (72707369) that a PgBouncer-pooled
connection can leak (P1002, seen Sept 23; the stuck backend was terminated through Neon `run_sql`).
`npm run db:migrate:http` applies migrations over the Neon HTTP driver when TCP is blocked.

### 4.3 Daily commands

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | develop / production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check`, `npm run check:enterprise` | pure regression suites (19 + 21 checks) |
| `npm test` (`test:watch`) | Vitest (unit + DB suites; DB suites skip without `DATABASE_URL`) |
| `npm run test:enterprise` | 18-step end-to-end deal against the database (needs openFDA) |
| `npm run test:adversarial` | 24 reliability/security steps against the database |
| `npm run eval`, `npm run eval:model`, `npm run eval:gate` | matcher accuracy vs curated crosses; model grading eval; CI gate |
| `npm run benchmark` | multi-list accuracy benchmark (`data/benchmark/<case>/`) |
| `npm run embed` | refresh pgvector embeddings (needs `OPENAI_API_KEY`) |
| `npm run worker` | dedicated pg-boss worker (`JOBS_WORKER=external`) |
| `npm run catalog:hygiene [-- --apply]` | deactivate placeholder SKUs/crosses, delete E2E fixtures |
| `npm run retention [-- --dry-run]` | manual retention sweep |
| `npm run secrets:check` | production secret/config checks |
| `npm run profile:run -- <intake>` | per-stage timings and query counts for one run |
| `npm run db:studio`, `db:migrate`, `db:reset` | Prisma tooling |

### 4.4 Mac demo branch (`mac-demo`)

For collaborators who cannot run the full stack: `npm run mac:setup [-- --docker|--brew|--external URL]`
writes `.env` from `.env.mac.example` (random `SESSION_SECRET`), starts Postgres (root
`docker-compose.yml`: pgvector on host port 5433, or brew), runs `npm ci`, migrations, and seeds
`seed.ts`, `seed-enterprise.ts` and `seed-demo.ts` (~40 own SKUs, 16 approved crosses for
`data/demo/demo-usage-list.csv`, published crosswalk version, competitor cache from the recorded
openFDA responses — create-only, safe anywhere). Then `mac:start` (moves to the next port if busy),
`mac:stop`, `mac:reset` (localhost only), `mac:doctor` (read-only diagnosis). Scripts are Bash 3.2 /
BSD-safe. `README-MAC.md` has the 5-step demo walk-through (Alex Rivera → demo CSV → 16/16 matched →
PDF → proposal → Dana approves).

### 4.5 Container and compose

`Dockerfile`: stages `base` (node:22-bookworm-slim) → `deps` (`npm ci --ignore-scripts`) → `build`
(`prisma generate && npm run build` with a dummy `DATABASE_URL`) → `runtime` (tini, ca-certificates,
non-root `node`, port 3000, health check on `/api/health`). `deploy/entrypoint.sh` roles: `web`
(migrate when `MIGRATE_ON_START` ≠ false — preflight first unless `PREFLIGHT_ON_START=false` — then
`next start`), `worker` (`tsx scripts/worker.ts`), `migrate`, `check` (`with-secrets.ts --check`),
anything else exec'd. `deploy/docker-compose.yml`: `db` (pgvector:pg17, `POSTGRES_PASSWORD`, no
published port), `web` (`JOBS_WORKER=external`, `${WEB_PORT:-3000}`), `worker` (starts after db and
web are healthy). `.dockerignore` keeps tests, docs, reference/benchmark/eval data and the test scripts
out of the image. Full guide: `docs/DEPLOYMENT.md`.

### 4.6 Startup sequence (`src/instrumentation.ts`, nodejs runtime, not during build)

1. `loadSecrets()` from `SECRETS_PROVIDER` (3 attempts, backoff) → `assertProductionSecrets()` (fatal
   in production: dev key, placeholders, example DB passwords, remote DB without sslmode; `ALLOW_DEV_SIGNIN`
   and `SSO_MODE` only warn).
2. `checkTenancy()` warns when more than one Company row exists (single tenant per deployment).
3. `startWorkers()` when `JOBS_WORKER=inline`: registers pg-boss queues, schedules, recovers orphans.
4. `installShutdownHooks()`: SIGTERM/SIGINT → `stopBoss()` (graceful, 10 s) → exit.

### 4.7 CI (`.github/workflows/ci.yml`, on push to `main` and PRs)

- **check** job (Postgres `pgvector/pgvector:pg17` service): `npm ci` → `prisma migrate deploy` →
  `typecheck` → `check` → `check:enterprise` → `build` → seed without reference data (`seed.ts &&
  seed-enterprise.ts`) → `test:adversarial` (`SESSION_SECRET=ci-only-secret`) → `npm test` → `eval:gate`.
- **image** job (needs check): Buildx build `crosswalk:ci` with the Actions cache; boot test — network,
  pgvector db, web container with `JOBS_WORKER=external`, poll `/api/health` (60 × 2 s), assert a
  `content-security-policy` header on `/`, run the `check` role with a strong secret, and confirm the
  `check` role **fails** with `SESSION_SECRET=short`.

---

## 5. Configuration: every environment variable

Defaults in parentheses. "(i)" = read through a helper. Everything is optional except `DATABASE_URL`.

**Core and database** — `DATABASE_URL` (required); `DATABASE_ADAPTER` (pg | neon-ws | neon-http);
`DIRECT_DATABASE_URL` (Prisma CLI); `DATABASE_POOL_MAX` (5, 1–200); `PRISMA_LOG`; `COMPANY_NAME` (Medtronic);
`OWN_LABELERS` (comma-separated GUDID labeler names counted as "ours"; default Covidien, Medtronic, Sofradim);
`TENANCY_STRICT` (true: a database with more than one Company row refuses to start);
`APP_BASE_URL` (http://localhost:3000); `PROGRESS_WRITE_MS` (400); `NODE_ENV`.

**Model and embeddings** — `OPENAI_API_KEY` (absent = heuristic mode); `OPENAI_BASE_URL`; `LLM_MODEL`
(gpt-5.6-astra); `LLM_SEND_ACCOUNT_NAME` (false keeps account names out of prompts); `EMBEDDINGS`
(off disables); `EMBEDDING_MODEL` (text-embedding-3-small); `EMBEDDING_RETRIEVAL_K` (40, 5–200);
`EMBEDDING_TIMEOUT_MS` (20000); `EMBED_REFRESH_BATCH` (5000); `EMBED_REFRESH_CRON` (`15 4 * * *`).

**openFDA / GUDID** — `OPENFDA_API_KEY` (240 → 1000 req/min); `OPENFDA_RPM` (80 % of the limit);
`OPENFDA_MAX_ATTEMPTS` (5); `OPENFDA_RETRY_BASE_MS` (1000); `OPENFDA_TIMEOUT_MS` (per request); `OPENFDA_MEMO_SECONDS` (300, 0 disables);
`OPENFDA_PACE_MS` (0); `GUDID_CACHE_TTL_DAYS` (90); `GUDID_REFRESH_BATCH` (200); `GUDID_REFRESH_CRON`
(`30 3 * * *`).

**Jobs, feeds, alerts, analytics** — `JOBS_WORKER` (inline | external | off); `JOBS_SCHEMA` (pgboss);
`JOBS_POOL_MAX` (3); `JOBS_MAINTENANCE_SECONDS` (60); `ALERTS_CRON` (`*/5 * * * *`); `ANALYTICS_CRON`
(`0 * * * *`); `ANALYTICS_STALE_MINUTES` (120); `BIDS_CRON` (`0 5 * * *`); `RETENTION_CRON`
(`45 2 * * *`); `FEEDS_RUN_ON_START`; `FEED_<CRM|ERP|GPO|PRICING|COMPETITOR_SIZES|COMPETITOR_PRICES>_CRON`
(`off` disables) and `_MAX_AGE_HOURS`; `INTEGRATION_FEED_DIR`; `ALERT_RESOLUTION_MIN` (0.7);
`ALERT_RUN_FAILURES` (2); `ALERT_QUEUE_STALL_MIN` (15); `ALERT_RENOTIFY_HOURS` (6).

**Integrations** — `INTEGRATIONS_ENCRYPTION_KEY` (32-byte hex/base64; else HKDF of `SESSION_SECRET`,
required in production); `INTEGRATIONS_ALLOW_MOCK`; any integration secret may be stored as `env:NAME`;
`DOCUMENT_STORAGE_DIR` (./.data/documents); legacy `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`,
`SF_API_VERSION`, `SAP_ODATA_BASE_URL`, `SAP_CLIENT`, `SAP_USER`, `SAP_PASSWORD`, `CRM_PUSH_MARGIN`.

**Bids, tax, notifications, Google** — `SAM_API_KEY`, `SAM_API_URL`, `SAM_MAX_PAGES` (1–5),
`USASPENDING_API_URL`, `BIDS_USASPENDING` (off), `BIDS_TIMEOUT_MS` (45000); `AVATAX_ACCOUNT_ID`,
`AVATAX_LICENSE_KEY`, `AVATAX_COMPANY_CODE`, `AVATAX_ENV` (sandbox), `AVATAX_BASE_URL`,
`AVATAX_ITEM_TAX_CODE` (P0000000), `AVATAX_FREIGHT_TAX_CODE` (FR020100), `TAX_DRY_RUN`,
`TAX_TIMEOUT_MS` (20000), `TAX_FREIGHT`; `SMTP_URL`, `MAIL_FROM`, `TEAMS_WEBHOOK_URL`, `NOTIFY_DRY_RUN`;
`GOOGLE_SERVICE_ACCOUNT_JSON` (inline JSON or path), `GOOGLE_DRIVE_FOLDER_ID`.

**Identity, security, logging** — `SESSION_SECRET` (≥ 16 chars in production); `SESSION_TTL_HOURS`
(12, max 720); `ALLOW_DEV_SIGNIN`; `SSO_ISSUER` + `SSO_CLIENT_ID` (both set enables SSO);
`SSO_CLIENT_SECRET` (blank = public client); `SSO_MODE` (oidc | proxy); `SSO_PROXY_SHARED_SECRET` (proxy mode: the value the proxy must send in `x-sso-proxy-secret`; ≥ 16 chars; required in production); `SSO_REDIRECT_URI`;
`SSO_SCOPES` (openid profile email); `SSO_ROLE_CLAIM` (roles); `SSO_ROLE_MAP` (JSON or `a=B` pairs);
`SSO_DEFAULT_ROLE`; `SSO_AUTO_PROVISION` (true); `METRICS_TOKEN`; `CSP_REPORT_ONLY`;
`RATE_LIMIT_AUTH` (20) / `_HEAVY` (60) / `_API` (600) per minute; `RATE_LIMIT_GLOBAL_FACTOR` (20);
`RATE_LIMIT_DISABLED`; `TRUST_PROXY_HOPS` (1); `LOG_LEVEL` (info); `LOG_FORMAT` (json in production,
else pretty); `LOG_SILENT`.

**Secrets providers** — `SECRETS_PROVIDER` (env | aws | vault | doppler | file); `SECRETS_OVERRIDE`;
`SECRETS_FILE`; `AWS_SECRET_ID`, `AWS_REGION`; `VAULT_ADDR`, `VAULT_SECRET_PATH`, `VAULT_TOKEN`,
`VAULT_TOKEN_FILE`, `VAULT_NAMESPACE`; `DOPPLER_TOKEN`, `DOPPLER_PROJECT`, `DOPPLER_CONFIG`.

**Retention** (off by default) — `RETENTION_ENABLED`, `RETENTION_DRY_RUN`, `RETENTION_BATCH` (5000),
`RETENTION_REQUESTS_DAYS` (no default; set only after the data policy is signed),
`RETENTION_LLM_CALLS_DAYS` (90), `_SYNC_LOG_DAYS` (180), `_FEED_RUNS_DAYS` (180),
`_NOTIFICATIONS_DAYS` (180), `_SNAPSHOTS_DAYS` (90), `_ALERTS_DAYS` (90). Audit events are never swept.

**Container/compose only** — `MIGRATE_ON_START`, `PREFLIGHT_ON_START`, `POSTGRES_PASSWORD`, `WEB_PORT`.

`.env.example` documents all of these except `DATABASE_POOL_MAX`, `PREFLIGHT_ON_START`,
`MIGRATE_ON_START`, `POSTGRES_PASSWORD`, `WEB_PORT`, `PRISMA_LOG`, `LOG_SILENT`.

---

## 6. Data model: 61 models and 15 migrations

`prisma/schema.prisma` (1,450 lines). Enum-like columns are strings; the allowed values are enforced
by CHECK constraints generated from `src/lib/db/constraints.ts` (`npx tsx scripts/gen-constraints.ts`
rewrites migrations 11 and 14; `npm run db:preflight` finds violating rows). Money is `Decimal(18,4)`
with a `currency` column beside it.

### 6.1 Catalog and matching core (13)

| Model | Purpose | Notable fields |
|---|---|---|
| Company | the deployed company | `name` (unique), `labelers` (JSON list of openFDA labeler names that count as "us") |
| OwnProduct | a SKU the company sells | `sku` (unique per company), `category` (family), `brand`, `labeler`, `status`, GUDID fields, `gudidJson`, `binJson`/`binSource` (llm \| heuristic)/`binnedAt`, `listPrice`, `cogs` (legacy; StandardCost wins), `isActive`, `successorSku`, `source` (seed \| manual \| gudid-import), `embedding vector(1536)` + hash/model/at (HNSW cosine index) |
| CompetitorProduct | a competitor product resolved from a CFN, cached across requests | `cfnNorm` (unique), `cfnMatched`, `manufacturer`, `labeler`, GUDID fields, `resolution` (openfda \| openfda-variant \| llm \| known-cross \| manual \| not-found), `confidence` (< 0.75 shows "verify"), `alternatesJson` (top 5 other hits), bin fields, `gudidCheckedAt` (TTL), embedding |
| CompetitorSpec | rep-imported sizes for competitor codes | `cfnNorm` (unique), `dimsJson`, `notes`, `source` |
| KnownCross | curated cross reference | `ownSku`, `competitorCodeNorm`, `matchType` (Exact \| Close \| Alternative \| US Downsell Match), `preferredOwnSku` (reviewer's pick), `additionalProducts`, `source` (sheet name \| rep \| import \| proposal), governance: `approvalStatus` (DRAFT \| IN_REVIEW \| APPROVED \| REJECTED \| RETIRED), `clinicalReviewStatus`/`marketingReviewStatus` (NOT_REQUIRED \| PENDING \| APPROVED \| REJECTED), `equivalenceLevel` (EXACT \| FUNCTIONAL \| CLOSEST_ALTERNATIVE \| PREMIUM_ALTERNATIVE \| PARTIAL_SUBSTITUTE \| NONE), `evidenceJson`, `version`, `effectiveFrom/To`, `accountId`; unique (ownSku, competitorCodeNorm, source) |
| Pricebook | legacy price list ("HOSPITAL LIST PRICE") | `name` (unique), `currency` |
| PriceEntry | a dated price from a pricebook **or** a contract, optionally banded | `pricebookId`/`contractId`, `productId`, `price`, `effectiveFrom/To`, `tier`, `minQty`/`maxQty`, `volumeTierName`, `source` (import \| erp \| manual \| proposal \| backfill \| benchmark:*), `status` (ACTIVE \| PENDING \| EXPIRED \| SUPERSEDED), `approvalState` (APPROVED \| PENDING \| REJECTED) |
| Request | one intake submission | `reference` (REQ-0001…), `accountNumber/Name/Type`, `accountId`, `reportType`, `pricebookId`, `sourceFileName/Url`, `xrefSheetUrl`/`offerSheetUrl`, `status` (draft \| queued \| running \| complete \| failed \| cancelled), `stage`, `progress`, `error`, `useLlm`, `optionsJson`, `logJson` (last 200 lines), `createdBy(UserId)`, queue: `jobId`, `attempt`, `checkpoint` (resolve \| bin \| match), `cancelRequested` |
| RequestLine | one competitor code | `lineNo`, `rawCode`, `cfnNorm`, `quantity`, `estCompetitorPrice`, `description` (intake evidence), `competitorProductId`, `resolutionStatus` (pending \| resolved \| not-found \| error), `resolutionNote`, `matchStatus` (pending \| matched \| no-match \| error), `selectedCandidateId`, `overrideNote`, `customerNote`, `flag` ("verify"), `reviewed` |
| MatchCandidate | a ranked own SKU for a line | `rank`, `matchType`, `source` (identity \| known-cross \| attribute \| llm), `score`, `scoreBin/Price/Cogs/Margin`, `factorsJson` (weights, notes, evidence, curated, cap), `rationale`, `additionalProducts`, `confidence`, `unitPrice`, `extended`, `priceSource`, `isSelected` |
| Setting | key/value | `key` PK, `value` |
| LlmCall | every structured model call, written by the application gateway (`src/lib/ai/gateway.ts`), never by the model layer | purpose, model, ok, durationMs, tokens, error, subject |
| LlmGrade | cached grading verdicts | `key` PK (sha256 of inputs), model, lines, json |

### 6.2 Identity, accounts, contracts, cost, FX, audit (15)

User (email unique, `externalId` = SSO subject, `territory` comma-separated), UserRole (PK userId+role),
Account (`accountNumber` and `externalCrmId` unique; `type` SOLD_TO \| SHIP_TO \| IDN \| HEALTH_SYSTEM \|
GROUP \| BILL_TO \| GPO_MEMBER; parent hierarchy; territory/segment/region/country; currency; `isStrategic`;
`ownerUserId`; tax fields; `shipToJson`; `contactsJson`), Gpo (name/code unique), GpoMembership (dated,
`tier`, `source` manual \| crm \| gpo-feed \| import, roster provenance), Opportunity, Contract
(`contractNumber` unique; `type` LIST \| GPO \| IDN \| LOCAL \| NATIONAL; `status` DRAFT \| ACTIVE \| EXPIRED
\| TERMINATED \| SUPERSEDED; `tier`; `precedence` override; committed volume/value; clause JSON
renewal/priceProtection/escalation; `sourceSystem`; `performanceJson`), ContractScope (family or product;
none = whole catalog), ContractCommitment, RebateSchedule (`type` VOLUME \| GROWTH \| COMPLIANCE \| FAMILY
\| BUNDLE; `basis` UNITS \| VALUE \| COMPLIANCE_PCT \| GROWTH_PCT; `tiersJson`), BundleTerm (condition +
benefit JSON), StandardCost (plant \| region \| global; `costType` STANDARD \| LANDED \| TRANSFER),
ExchangeRate (unique from/to/asOf/source; `rate Decimal(18,8)`), AuditEvent (actor, entity, action,
before/after/context JSON, reason), Competitor (name unique, aliases).

### 6.3 Intelligence, policy, proposals, governance, integrations, analytics (17)

Document (kind INVOICE \| PO \| BID_FILE \| CONTRACT \| COMPETITOR_LIST \| OTHER; storagePath),
CompetitorPriceObservation (append-only; `sourceType` CUSTOMER_INVOICE \| CUSTOMER_PO \| CUSTOMER_BID_FILE \|
GPO_CONTRACT_FILE \| WIN_LOSS_RECORD \| INTERNAL_VERIFIED \| PUBLIC_BID_DB \| REP_OBSERVED \| ANECDOTAL;
`verificationStatus` UNVERIFIED \| VERIFIED \| DISPUTED; tier/contractRef/validTo/sourceSystem/sourceOwner
provenance), PricingPolicy (versioned per family, `*` default; margins as fractions; `floorMethod`
COST_PLUS_MIN_MARGIN \| PCT_OF_LIST \| FIXED; `defaultStrategy`; `classification`; `authorityJson`;
`approvalRulesJson`; status DRAFT \| ACTIVE \| SUPERSEDED), Proposal (`reference` PRP-0001…, version,
parent, GPO snapshot, `status` DRAFT \| APPROVAL_REQUIRED \| SUBMITTED \| PARTIALLY_APPROVED \| APPROVED \|
REJECTED \| CHANGES_REQUESTED \| EXPIRED \| WON \| LOST, policy versions, economics/objectives JSON, freight
NONE \| FLAT \| PCT, tax NONE \| EXEMPT \| MANUAL \| PROVIDER, ship-to, lockedAt/submittedAt/decidedAt,
pinned `crosswalkVersionId`), ProposalLine (full snapshot: cross, equivalence, match type, quantity,
list/contract price + source (LIST \| NATIONAL \| GPO \| IDN \| LOCAL) + `waterfallJson`, competitor price +
confidence + basis (KNOWN_ACCOUNT \| MARKET_ESTIMATE \| WEAK \| NONE), cost, floor/target/ceiling,
recommended/proposed, margin and discount pct `Decimal(12,6)`, `requiredAuthority`, `approvalState`
NOT_REQUIRED \| REQUIRED \| PENDING \| APPROVED \| REJECTED, justification/notes/customerNote, `included`),
Scenario (RECOMMENDED \| AGGRESSIVE \| MARGIN_OPTIMIZED \| CUSTOMER_REQUESTED \| CUSTOM \| FINAL),
ScenarioLine, ApprovalRequest (requiredRole, reason, status PENDING \| APPROVED \| REJECTED \|
CHANGES_REQUESTED \| WITHDRAWN \| EXPIRED, `onBehalfOfUserId`, `breakGlass`, `snapshotJson`),
CrosswalkVersion (number unique; DRAFT \| IN_REVIEW \| PUBLISHED \| SUPERSEDED \| RETIRED),
CrosswalkVersionEntry (frozen cross), ExternalRef (system+entityType+externalId unique; `syncHash`,
`syncJobId`, `mappingVersion`, `sourceUpdatedAt`, `metaJson`), SyncLog, PurchaseRecord (account, SKU,
quantity, netPrice, invoiceDate, contract, proposal, `externalId`), DealOutcome (1:1 with proposal;
WON \| LOST \| NO_DECISION; reasons; finalValue), MatchDecision (top vs chosen SKU, `acceptedTop`,
`overrideReason`, `groundTruth` VALIDATED_CORRECT \| VALIDATED_INCORRECT \| UNKNOWN), GudidDevice
(labeler catalog mirror; `recordKey` unique; `cfnNorm`/`cfnCompact` indexes), GudidImport (job row:
query, kind COMPETITOR \| OWN, filters, status QUEUED \| RUNNING \| DONE \| FAILED \| CANCELLED, counters,
log, `cursorJson`).

### 6.4 Tier 1 (6), Tier 3 (3), Tier 2 (7)

Notification (kind, readAt, deliveriesJson, dedupeKey), NotificationPreference (PK userId+kind; inApp/
email/teams), Alert (fingerprint unique; rule; severity INFO \| WARNING \| CRITICAL; fired/notified/
resolved timestamps), FeedRun (feed, trigger, status RUNNING \| OK \| FAILED \| SKIPPED, sourceHash,
counters), BenchmarkRun, ModelEval. ApprovalDelegation (from/to user, startsAt/endsAt (end after
start), revokedAt), AnalyticsSnapshot (report, json, trigger), PublicAward (source SAM \| USASPENDING \|
BIDFILE; source+externalId unique; awardee, naics, psc, amount). IntegrationConfig (key unique:
salesforce \| sap \| gpo:premier \| gpo:vizient \| gpo:healthtrust \| documents \| fx \| competitor-contracts;
provider; enabled; configJson; sealed secretsJson; mappingJson; scheduleCron; status NOT_CONFIGURED \|
CONFIGURED \| CONNECTED \| DEGRADED \| ERROR \| DISABLED; health; cursorJson), IntegrationSyncJob (syncType,
trigger, status QUEUED \| RUNNING \| SUCCEEDED \| PARTIAL \| FAILED \| CANCELLED, counters, cursors),
IntegrationSyncError (category VALIDATION \| MAPPING \| DATA_CONFLICT \| PROVIDER \| UNKNOWN; rowRef),
IntegrationReviewItem (kind UNMATCHED_ACCOUNT \| MEMBERSHIP_CONFLICT \| DUPLICATE \|
LOW_CONFIDENCE_EXTRACTION \| PRICE_EXCEPTION \| UNKNOWN_COMPETITOR \| MAPPING_ERROR \| OVERLAP; status
OPEN \| RESOLVED \| DISMISSED; resolution LINKED \| ACCEPTED \| DISMISSED \| CORRECTED; dedupeKey),
DocumentExtraction (provider, documentType, status PENDING \| EXTRACTED \| REVIEW \| VERIFIED \| REJECTED \|
FAILED, confidence, threshold), ExtractedField (scope HEADER \| LINE; raw/normalized/corrected values;
verification UNVERIFIED \| VERIFIED \| CORRECTED \| REJECTED), IntegrationInboundEvent (integrationKey +
eventId unique; RECEIVED \| PROCESSED \| IGNORED \| FAILED).

### 6.5 Migrations (applied in order)

| # | Folder | Content |
|---|---|---|
| 1 | `20260914200000_postgres_baseline` | the 13 core tables |
| 2 | `20260914210000_enterprise_platform` | 28 enterprise tables; PriceEntry gains contract/account/GPO/dating/banding; KnownCross governance; Request.accountId |
| 3 | `20260915020000_gudid_library` | OwnProduct.source; GudidDevice, GudidImport |
| 4 | `20260915210000_widen_pct_columns` | ProposalLine pct columns → DECIMAL(12,6) |
| 5 | `20260915220000_purchase_external_index` | PurchaseRecord (accountId, externalId) index |
| 6 | `20260917060000_tier1_platform` | gudidCheckedAt; queue columns on Request/GudidImport; Notification, NotificationPreference, Alert, FeedRun, BenchmarkRun, ModelEval |
| 7 | `20260917120000_tier1_fixes` | Notification.dedupeKey + index |
| 8 | `20260918000000_tier3_product_scale` | `CREATE EXTENSION vector`; tax/ship-to on Account; onBehalfOfUserId; embedding columns; freight/tax on Proposal; customerNote; ApprovalDelegation, AnalyticsSnapshot, PublicAward; HNSW index |
| 9 | `20260918000100_tier3_line_flags` | RequestLine.flag |
| 10 | `20260919000000_tier0_break_glass` | ApprovalRequest.breakGlass |
| 11 | `20260919000100_tier0_check_constraints` | 59 CHECK constraints (NOT VALID → VALIDATE), generated |
| 12 | `20260923000000_tier2_integrations` | Tier 2 provenance columns; 7 integration tables |
| 13 | `20260923000001_tier2_account_contacts` | Account.contactsJson |
| 14 | `20260923000002_tier2_check_constraints` | 9 CHECK constraints on integration state columns, generated |
| 15 | `20260924000000_match_quality` | RequestLine.description, MatchCandidate.confidence/priceSource, OwnProduct.successorSku |

---

## 7. Identity, roles, permissions, scoping and redaction

### 7.1 Sign-in modes (`src/lib/auth/index.ts`, `oidc.ts`)

| Mode | Trigger | Session |
|---|---|---|
| **none** (dev) | no `SSO_*` | `crosswalk_dev_user` cookie = `<userId>.<hmac(SESSION_SECRET)>`, set by `POST /api/auth/dev`; production refuses unless `ALLOW_DEV_SIGNIN=true` |
| **oidc** | `SSO_ISSUER` + `SSO_CLIENT_ID`, `SSO_MODE` unset/`oidc` | built-in client: `/api/auth/oidc/start` (state cookie `crosswalk_oidc`, 10 min, PKCE S256, nonce) → IdP → `/callback` (discovery cached 1 h, JWKS signature, issuer, audience, nonce, `maxTokenAge` 1 h, clock tolerance 120 s, rejects `email_verified:false`) → `resolveUser` (externalId, then email for unlinked users; roles from `SSO_ROLE_CLAIM` mapped by `SSO_ROLE_MAP` are authoritative; auto-provision unless `SSO_AUTO_PROVISION=false`) → sealed `crosswalk_session` (`SESSION_TTL_HOURS` 12, max 720) → `/logout` clears and returns the IdP end-session URL. `safeNext` prevents open redirects. |
| **proxy** | `SSO_MODE=proxy` | trusts an `x-sso-subject` header set by an upstream SSO proxy |

`getActor()` resolves the current user with roles and a permission set; `can`, `requirePermission`,
`hasAuthority`, `AuthError`, `authErrorResponse`.

### 7.2 Roles and permissions (`src/lib/auth/permissions.ts`)

11 roles: SALES_REP, REGIONAL_MANAGER, CONTRACTING_MANAGER, PRICING_ANALYST, PRICING_DIRECTOR,
PRICING_COMMITTEE, PRODUCT_MARKETING, CLINICAL_REVIEWER, FINANCE, ADMIN (all permissions), EXECUTIVE.

23 permissions: view_pricing, edit_proposed_pricing, edit_contract_pricing, view_cost, view_margin,
approve_discount, approve_below_floor, manage_crosswalk, publish_crosswalk, review_crosswalk_clinical,
manage_contracts, import_competitor_pricing, verify_competitor_pricing, export_proposals,
configure_pricing_rules, manage_users, view_analytics, record_outcomes, import_purchases,
run_cross_reference, manage_catalog, import_cost_data, configure_settings.

| Role | Permissions |
|---|---|
| SALES_REP | view_pricing, edit_proposed_pricing, import_competitor_pricing, export_proposals, record_outcomes, run_cross_reference |
| REGIONAL_MANAGER | SALES_REP + view_margin, approve_discount, view_analytics |
| CONTRACTING_MANAGER | view_pricing, edit_proposed/contract_pricing, view_margin, manage_contracts, approve_discount, export_proposals, record_outcomes, import_purchases, view_analytics, run_cross_reference, manage_catalog |
| PRICING_ANALYST | view_pricing, edit_proposed_pricing, view_cost, view_margin, import/verify_competitor_pricing, view_analytics, run_cross_reference, manage_catalog, import_cost_data |
| PRICING_DIRECTOR | broad, incl. approve_below_floor, configure_pricing_rules, configure_settings, manage_contracts, import_cost_data |
| PRICING_COMMITTEE | view_pricing, view_cost, view_margin, approve_discount, approve_below_floor, view_analytics |
| PRODUCT_MARKETING | view_pricing, manage_crosswalk, publish_crosswalk, view_analytics, run_cross_reference, manage_catalog |
| CLINICAL_REVIEWER | manage_crosswalk, review_crosswalk_clinical (no view_pricing) |
| FINANCE | view_pricing, view_cost, view_margin, view_analytics, import_purchases, import_cost_data |
| EXECUTIVE | view_pricing, view_margin, view_analytics |

Approval authority order: SALES_REP < REGIONAL_MANAGER < CONTRACTING_MANAGER < PRICING_DIRECTOR <
PRICING_COMMITTEE (`satisfiesAuthority`; ADMIN always passes).

### 7.3 Route plumbing (`src/lib/api.ts`)

`handle(perm, fn)`: resolves the actor → 401 if none → 403 `Missing permission` → `enforceScopeForPath`
→ runs the handler → JSON with Decimals serialised. Errors map by message: "not found" → 404;
already/changed/decided by someone/being submitted/conflict → 409; otherwise 400; Prisma/driver
messages replaced by `publicErrorMessage`. `authorize(perm)` does the same checks for file/CSV handlers.
Validators: `requireText`, `optText`, `oneOf`, `currencyCode`, `positiveMoney` (≤ 1e9),
`nonNegativeMoney`, `num`, `str`, `date`. Every handler emits HTTP metrics with a request id.

### 7.4 Ownership and territory scope (`src/lib/auth/scope.ts`)

SALES_REP and REGIONAL_MANAGER (holding no other role) see accounts they own, accounts in their
territory (`User.territory`, comma-separated), unassigned accounts, children of visible parents, and
records they created; any other role widens to everything. Where-fragments `accountWhere`,
`requestWhere`, `proposalWhere`, `contractWhere` (NATIONAL and GPO contracts visible to all);
`assert*Visible` (always 404 out of scope), `assertAccountWritable`. `enforceScopeForPath` runs for
`/api/(accounts|requests|proposals|contracts)/<id>` — id must be 20–40 alphanumerics, lowercase words
≤ 16 chars are sub-routes (`renewals`).

### 7.5 Redaction

`redactForActor` nulls cost/costBasis/floorPrice without `view_cost` and margin fields without
`view_margin`, including nested recommendation/waterfall/intel JSON; `redactJsonForActor` walks JSON
and swaps in `explanationPublic`; `redactAuditEvent` does the same for audit rows; the workbook export
hides cost/margin columns per permission (`Hide`).

---

## 8. Request security: the proxy

`src/proxy.ts` (with `src/lib/security/{headers,ratelimit}.ts`) runs for `/api/:path*` and every page
(not `_next/static`, `_next/image`, favicon, static assets, prefetches).

**Pages:** per-request nonce; CSP `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'`
(+ `'unsafe-eval'` in dev); `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`; `font-src
'self' data:`; `connect-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`;
`frame-ancestors 'none'`; `upgrade-insecure-requests` over HTTPS; `CSP_REPORT_ONLY=true` switches to
report-only. Hardening headers on every response: nosniff, `x-frame-options: DENY`, referrer policy
strict-origin-when-cross-origin, permissions-policy (camera/mic/geolocation/payment/usb/interest-cohort
off), COOP same-origin, dns-prefetch off, HSTS 1 year with subdomains over HTTPS.

**API:** (1) request id (a client's `x-request-id` reused only behind a declared proxy, `TRUST_PROXY_HOPS > 0`, and when it matches `^[A-Za-z0-9_.:-]{6,64}$`; otherwise a fresh id; echoed); (2) malformed
path encoding → 400; (3) rate limit, fixed 60 s window per instance: class `auth` (`/api/auth/*`, 20/min),
`heavy` (run, bulk, export, sheets, POST requests, all imports, catalog add/enrich/gudid/plan/adopt/
prune, integrations/sync, feeds, observability export, proposal export/refresh-context; 60/min), `api`
(600/min); per-instance ceiling = `RATE_LIMIT_GLOBAL_FACTOR` × client limit; client from
X-Forwarded-For (`TRUST_PROXY_HOPS`) or x-real-ip; 429 with `retry-after`; (4) `x-crosswalk-route`
(ids collapsed to `:id`, for metrics) and `x-crosswalk-path` (decoded path, always overwritten — the
scope hook reads it); `x-sso-subject` / `x-sso-proxy-secret` are stripped from the request unless
`SSO_MODE=proxy`; (5) auth gate: open list `/api/auth/`, `/api/health`, `/api/metrics` and exactly
`POST /api/webhooks/salesforce` (authenticated by its HMAC); everything else needs a dev cookie, a
session cookie or (proxy mode, with the shared secret) `x-sso-subject`, else 401. The handlers verify
the session; the proxy only checks presence. (6) CSRF gate for cookie-authenticated non-GET requests:
`Sec-Fetch-Site` must be same-origin/none, else the `Origin` host must match the addressed host
(`X-Forwarded-Host` counts only with `TRUST_PROXY_HOPS > 0`); no CORS headers are ever sent.

`next.config.ts` adds static security headers and `Cache-Control: private, no-store`, and marks the
database, Excel, PDF, queue and mail packages as server-external.

---

## 9. Workflow A — the cross-reference request

The core workflow. A rep submits a list; the pipeline resolves, bins, matches, grades, prices and
persists; the rep reviews and exports.

### 9.1 Intake (`src/lib/excel/intake.ts`, `src/lib/cfn.ts`, `POST /api/intake/preview`, `POST /api/requests`)

Sources: `.xlsx` upload (`parseIntake`), `.csv` upload or pasted cells (`parseIntakeCsv`, RFC 4180 with
BOM), Google Sheets link (`parseIntakeFromSheetLink`: service account first, then the public CSV export
of an "anyone with the link" sheet); all reduce to a grid → `parseIntakeGrid`. Header row detected in
the first 10 rows by name (`CODE_HEADERS`: product code, CFN, catalog no, item, SKU, part, competitor
product, material…; `QTY_HEADERS`; `PRICE_HEADERS`; `DESC_HEADERS`); fallback: column 1 = code, column 2
= quantity. Every row with something in the code column is accounted for: a line, a merged duplicate
(quantities summed, first price/description kept, `sourceRows` list), a **skipped** row with a reason
(placeholder such as NO MATCH / N/A / TBD; characters no catalog number uses; > 42 chars; quantity
≤ 0 or > 10 M), or an **ignored** summary row (TOTAL / subtotal / page). `accounting` =
{dataRows, lines, merged, skipped, ignored}; the API returns it plus the first 50 skipped rows.
`normalizeCfn` strips BOM/NBSP/zero-width characters, maps typographic dashes to `-`, uppercases and
removes whitespace; `looksLikeCfn` needs ≥ 3 alphanumerics (hyphenated short segments like `IN-12-4`
pass); `isPlaceholderSku` refuses NOMATCH, N/A, TOTAL, DISC, TBD, "NO MATCH FOUND", etc.

The intake wizard (`/requests/new`) shows a preview (codes, units, merged, skipped, detected columns),
then account fields (number auto-filled from an 8+-digit run in the file name), pricebook and a
"Use the model" toggle. `POST /api/requests` validates lengths, 1–5,000 lines, the pricebook, links
`accountId` when the account number matches an existing account (403 if outside the rep's book),
creates the Request + lines (status `queued`) and calls `enqueueRun`; a queue failure marks the request
failed and returns 503 with the id so the upload is not lost.

### 9.2 Queueing and the run wrapper (`src/lib/pipeline/run.ts`)

`enqueueRun(requestId, {freshGrades, useLlm})` is idempotent (a live job returns `alreadyQueued`; an
orphaned in-flight request is re-queued with `resume`); job `request.run`, `singletonKey = requestId`;
writes status queued, jobId, optionsJson. `cancelRun` sets `cancelRequested`, wins the queued→cancelled
race atomically and cancels the pg-boss job. `runRequest` maps outcomes: RunCancelled → cancelled;
RunInterrupted (queue abort/expiry) → "Interrupted… will resume" and rethrow; other errors → failed on
the final attempt, else queued with "Attempt N failed — retrying"; always `notifyRunFinished`.
State: `status` draft→queued→running→complete|failed|cancelled; `checkpoint` null→resolve→bin→match
(a retry resumes after the last complete stage); `attempt` only increases. Progress bands: model check
1 %, resolve pass 1 2–22 %, pass 2 22–40 %, bin 42–60 %, match 60–78 % (LLM) or 60–98 %, grade 78–98 %.
Per-line progress writes are throttled to `PROGRESS_WRITE_MS`; the run log keeps its last 200 lines,
appended atomically through a jsonb update.

### 9.3 Stage 1 — resolve (`src/lib/pipeline/resolve.ts`, `src/lib/gudid/*`)

Two passes at concurrency 3. **Pass 1 (strict)** resolves unambiguous codes; `buildContext` then derives
list-wide manufacturers, families, preferred companies and common numeric prefixes (a 4-digit prefix
shared by ≥ 3 codes or ≥ 20 %); **pass 2** resolves the rest with that context.

`variantsFor(cfnNorm, ctx, strict)` produces tiered lookups: tier 0 exact + compact (punctuation
removed); tier 1 `-S` stripped, trailing X stripped, zero-padded to 7/6/5/8, list-wide prefix stripped
(strict mode stops here); tier 2 leading 3/4/5-digit distributor prefix stripped; tier 3 wildcard
`*core*` for alphanumeric cores ≥ 6 chars (≤ 2). `gatherHits` tries the local GUDID library first
(`localHits`), then openFDA; tiers 0–1 in parallel, tiers ≥ 2 only when tier 0 found nothing.
`scoreHit`: exact code +3 / substring +1.5; tier bonus [4, 3, 2, 0.5]; reprocessor (Sterilmed, Stryker
Sustainability, Provision, … Cardinal) −2.5 else +1; in commercial distribution +1; description +0.5;
with context: manufacturer on the list +2.5, preferred company +1, same family +1.5, "Other" when the
list has families −1. `confidenceOf = clamp((score − 2)/9)`, × 0.7 when the runner-up is within 1 point
from a different manufacturer; accepted at ≥ 0.75.

`resolveCfn` cascade: cached row with confidence ≥ 0.75 (served even past TTL; `refreshIfStale` queues a
background re-check) → GUDID hits (`openfda` for tier 0, `openfda-variant` otherwise; strict rejects
tier > 1 or confidence < 0.75) → a KnownCross description (`known-cross`, 0.8, no GUDID) → model
`cfnHints` (up to 6 variant spellings tried, `llm` ≤ 0.7; brand + company search 0.6; else `not-found`
with the model's guess recorded) → `not-found`. `upsertFromRecord` stores the top 5 alternates
(reprocessors etc.) as `alternatesJson`; a rep can switch to one (`PATCH /api/competitor/{id}` with
`di`, resolution `manual`, confidence 1). Codes that resolve to **our own labelers** are added to
OwnProduct if missing ("customer already buys it from us").

openFDA access (`gudid/http.ts`): one HTTP path with a token bucket at 80 % of the limit (240/min, or
1,000/min with a key), process-wide pause on 429 (≤ 120 s), equal-jitter backoff (cap 60 s),
`OPENFDA_MAX_ATTEMPTS` 5, 404 = empty, non-JSON 200 retried. `openfda.ts` memoises search answers
in-process for `OPENFDA_MEMO_SECONDS` (2,000 entries, in-flight dedupe; the refresh path bypasses);
`rankHits` prefers exact code +4, original labeler +3, in distribution +2, preferred company +2,
description +1, sizes +0.5; `summarizeRecord` flattens a record (brand, description, DI, GMDN, product
code, status, sizes, specialties, single-use/sterile/implantable); `displayManufacturer` normalises ~16
labeler names (Covidien/Medtronic/Sofradim → Medtronic, Ethicon, Sterilmed → "Ethicon - SterilMed",
Bard/BD/Davol → "BD - Bard", …).

### 9.4 Stage 2 — bin (`src/lib/llm/tasks.ts` `binProduct`, `src/lib/match/bin.ts` `heuristicBin`)

Each distinct competitor product whose cached bin is stale (`v < BIN_VERSION` = 9, or a model bin whose
`hv` < 7) or heuristic while the model is on is (re)binned at concurrency 3. Inputs: GUDID brand +
description **plus** the curated sheet's description for the code (fetched once per run; a
long-standing bug that dropped the GUDID text whenever a curated one existed was fixed in `1b43393`),
GMDN term, structured `device_sizes`, imported competitor sizes (`specsFor`, batched), manufacturer,
the catalog number (`code`). `heuristicBin` derives: family (`FAMILY_RULES` in order — non-surgical
specialties/keywords → Other, then Fixation, Stapling, Hernia Mesh, Trocar, Hand instruments; then
the sales category; an FDA review panel outside surgery (`OFF_SPECIALTIES`) vetoes the surgical
families unless the GMDN term is a laparoscopic/trocar/stapler/hernia/mesh term), materials
(`MATERIALS` + `BRAND_MATERIAL` — Parietene/Prolene/Bard/Ventralight → polypropylene, Parietex/Symbotex →
polyester, Gore-Tex/DualMesh → ePTFE, Phasix → P4HB, Strattice/Permacol/… → biologic), features
(`FEATURES` regex tags: single-use, sterile, articulating, bladeless, bladed, optical, fixation cannula,
smooth cannula, absorbable/fully/partially, barrier, self-gripping, powered, reload colours, linear
cutter, circular, long/short, low profile, pack, sleeve, obturator, shapes…), dimensions
(`extractDimensions`: A×B(×C) pairs with unit inference, singles with role hints, gauge, count, staple
height; `sizeFromSku` for our mesh codes PCO/PPM/PPDS…; imported sizes win outright; GUDID structured
sizes next), product type (`deriveProductType`), compatibility platforms, single-use/sterile/implantable,
summary; for **Trocar Products** it builds the access profile (§10.1) and rewrites the size dimensions
from it. The model (`binProduct`) receives the heuristic draft and corrects it (`v = 9999`, `hv = 7`);
heuristic width/length/diameter it dropped are restored, imported sizes overwrite, and the access
profile always rides along from the draft. Own products are binned the same way (labeler = manufacturer)
when their cached bin is stale.

### 9.5 Stage 3 — match (Phase A, concurrency 2)

Candidate pool: every curated/manual own SKU plus GUDID-import SKUs in the request's families
(`gudidJson` loaded lazily). Per line (`src/lib/match/line.ts`):

1. `competitorBinForLine` folds the line's **intake description** into the cached bin's access profile
   (gaps only; conflicts recorded).
2. `curatedCandidates`: approved crosses + rep drafts for the code (`crossesForMatching`), one candidate
   per SKU — a row's `preferredOwnSku` redirects it; any SKU named in that column is flagged
   `preferred`; approved beats draft; the better grade wins per SKU.
3. Attribute shortlist: the family pool ranked by `binSimilarity`, top `settings.maxCandidates`
   (default 5, 1–25) above 0.3. With embeddings on (`EMBEDDINGS`, key present, pgvector), the pool is
   the `RETRIEVAL_K` nearest neighbours instead of the whole family (over-fetch ×4, family-filtered,
   used only when ≥ min(5, ⌈K/4⌉) hits; one failure trips a breaker for the rest of the run).
4. SELF_MATCH: a code that is our own active SKU is added as `identity`; a discontinued one with
   `successorSku` in the pool adds the successor as identity with a note; without one the line
   carries "discontinued (no successor on file) — substitutes proposed".
5. Pricing per candidate: with a known account, `PricingContext.resolvePrice` (§13.3) → `unitPrice`
   and `priceSource` ("LOCAL · TROCAR - SANFORD HLTH", "LIST · HOSPITAL LIST PRICE", "LIST · catalog
   list price", or "no price: <every step's reason>"); without one, the request's pricebook entry, then
   the catalog list price.
6. `scoreCandidates` (§10.4) → ranked `ScoredCandidate[]` with grade, score, confidence, evidence.

Phase B (model on): `groupSiblings` (same manufacturer | brand | family | construction signature,
≤ `MAX_GROUP` 8 lines) → `gradeGroup` (shortlist ≤ `MAX_SHORTLIST` 6 per line, one structured call per
group, `GRADE_PROMPT_VERSION` 3, verdict cached in LlmGrade by a sha256 of prompt version + model +
company + every line's cfn/bin/candidates; `freshGrades` bypasses) → `applyGroupGrades` (a model grade
never exceeds the constraint cap; a curated SKU the model calls No Match keeps its prior grade;
identity stays Exact; the model's `bestSku` moves to the front of its tier; sibling floor: a SKU that is
≥ Alternative for one sibling cannot be No Match for another). A model failure leaves the heuristic
verdicts standing.

Phase C (persist): old candidates on un-worked lines cleared; then chunks of `PERSIST_CHUNK` = 50 lines,
each one transaction (delete → `createManyAndReturn` → `UPDATE "RequestLine" … FROM unnest(...)`),
keeping the non-No-Match top `maxCandidates` (else the top 3), rank 1 selected when it is not No Match;
status complete, checkpoint match, metrics `runsFinished`, `lastRunResolution`, `lastRunMatch`.

Measured (`scripts/profile-run.ts`, local Postgres): 30 lines 138 statements / 1.4 s; 300 lines
1,998 statements / 4.6 s (before `fd9f620`: 366 / 2.9 s and 4,872 / 18.9 s, identical outputs).

### 9.6 Review (`/requests/[id]`)

Header: account, status, pricebook, model or heuristic, source link; Re-run, Cancel, Re-grade fresh,
Download menu (xref .xlsx/.csv, offer .xlsx/.csv, offer PDF), Google Sheets write-back, Create proposal.
Progress bar polls every 1.2 s. Filters All / Needs attention (unresolved, unselected, competitor
confidence < 0.75 **or match confidence < 0.75**) / Flagged / Exact / Close / Alternative / Already ours;
search; bulk actions (review_exact, review_matched, select_top, flag_verify, clear_flags, unreview_all);
expand all. Line row: code (→ matched variant), chips (Not in GUDID / Verify · N % / Rep-corrected /
Discontinued / Flagged), manufacturer + description; best-fit SKU with grade chip, "Already ours",
"Curated · <sheet>" (+ "contradicted"), "Verify match · N %", first contradiction line; fit bar; unit
and extended price with the price source underneath ("no price" in amber); Reviewed checkbox. Expanded:
competitor pane (GUDID DI link, GMDN, bin, other GUDID records to switch to, est. competitor price,
internal note, customer note, Flag to verify) and candidate cards (radio select; grade; Curated cross ·
sheet; Confidence N % / Verify · N %; Discontinued; price + source; description; **evidence list** —
📄 curated row status, then ✗ hard / ≠ soft / = agreeing findings; "Why no price"; Also needs; fit/price/
cost/margin/overall bars; Compare attributes (side-by-side bins); Side-by-side modal with GUDID rows and
bin rows and similarity). `PATCH …/lines/{lineId}` records the learning-loop decision (§12.2).

### 9.7 Exports (`src/lib/excel/export.ts`, `src/lib/pdf/index.ts`, `src/lib/sheets/google.ts`)

`buildCrossReferenceWorkbook`: sheet **Competitor Usage Xref** in the legacy BAT `SSXrefReport` column
order — Competitor Name, Competitor Product, Description, Quantity, Estimated Competitor Price, Extended,
`<us>` Product Match, Description, Additional Products Needed, Item Product Category, Quantity, Current
PriceBook (the applied contract/book name from `priceSource`), Current Price, Extended, Match Type,
Confidence (evidence confidence), Match Source, Rationale, Next Best 1/2 (SKU, description, type), GUDID
DI, Resolution, **Pricing Source**, **Curated Sheet**; TOTAL row; **All Candidates** (rank, grade,
source, composite and sub-scores, prices, selected, rationale); **Unresolved**; **Run Info**. Cost and
margin columns hidden per permission. `buildContractOfferWorkbook`: customer-facing offer ("Valid 90
days"). CSV variants use `toCsv` (formula-injection guard). `buildOfferPdf` (branded, `validityDays`).
Google Sheets: `uploadXlsxAsGoogleSheet` converts on upload into `GOOGLE_DRIVE_FOLDER_ID`; the request
stores `xrefSheetUrl`/`offerSheetUrl`.

---

## 10. The matcher in depth

Specification: `docs/MATCH_QUALITY_MODEL.md`. Three outputs are kept apart per candidate: **match
score** (similarity on the evidence), **classification** (Exact / Close / Alternative / No Match) and
**confidence** (how much evidence supports the classification).

### 10.1 Access-product profile (`src/lib/match/access.ts`)

`AccessProfile` = component, visualization (optical | non-optical), tip (bladeless | bladed | blunt |
dilating), fixation (fixation | smooth | balloon), lowProfile, diameters (a set: "2/3 mm" = {2, 3}),
instrument range, lengthMm + lengthClass (≤ 80 short, ≤ 120 standard, else long), product line,
manufacturer, extras (variant add-ons), `evidence[]` (field, value, source, via) and `conflicts[]`.
`buildAccessProfile(sources)` reads sources in priority order — curated size import (`curated-spec`) →
GUDID structured sizes (`gudid:size`) → the manufacturer's SKU convention (`sku`, applied only when
the manufacturer matches the rule) → GUDID/curated description text (`gudid:description`, GMDN read
only for specific components: seal/reducer/valve → accessory, needle, obturator) → intake description
(`intake:description`) — the first source to state a field wins, later ones fill gaps, disagreements
are recorded. `parseAccessSizes` reads sizes literally: explicit "Size: N mm"/"N mm diameter";
explicit lengths (30–400 mm); pairs "12 × 100 mm", "12mm x 100mm", "100 mm x 11 mm", "5x95";
ranges "5–12 mm", "5-12mm", "5 mm to 12 mm", "instruments up to 11 mm" (the port is sized by the range
maximum when nothing else says so); "N mm trocar"; multi-size "2/3 mm", "2 mm/3 mm", "5/10 mm";
remaining singles; reducers/converters and pack counts ignored; length words short/long/extra long as
a fallback. `mergeProfiles(base, extra)` fills gaps only; `describeProfile` renders one line.

### 10.2 Brand → feature registry (`src/lib/match/brands.ts`)

~40 `BrandRule`s, each `{key, kind: brand | sku, match, unless?, assert, provenance, note}`, applied
in order (specific before generic; the first rule to set a field wins). Brand rules: Ethicon OPTIVIEW
(optical), Endopath Xcel / BASX (non-optical unless OPTIVIEW), Dilating Tip (dilating, non-optical),
Universal / Stability Sleeves (cannula-only, not when "trocar with … sleeve"), non-shielded (bladed);
Applied Medical Kii Fios / Kii Optical / Optical Separator (optical bladeless trocar), Kii Shielded
Bladed (bladed non-optical), Kii Balloon Blunt Tip (blunt, balloon), Kii Sleeve / Advanced Fixation
Cannula (cannula), Kii access systems (trocar), Z-Thread (fixation); Medtronic Visiport (optical,
bladed, handle), VersaOne Optical / Universal Cannula / Blunt, Versaport sleeves, VersaStep / Step /
Mini Step (radially expanding system, non-optical, unless needle), Bluntport, Thoracoport, VersaSeal
(accessory); variant add-ons — fascial closure system, dual pack, non-sterile bulk (NSB), handle, dual
cannula; generic optical / bladeless / bladed / Hasson / bladed-and-blunt-and-bladeless ⇒ non-optical
(after the optical rules) / fixation (not "non-threaded") / smooth / balloon / low profile. SKU
conventions (gap-fill only, manufacturer-guarded): Ethicon `^(2?)(B|D|CB|CTB|…)(\d+)(ST|LT|XT)(H|S|P)?`
→ 75/100/150 mm, 2 = OPTIVIEW, B bladeless, D dilating, CB/CTB sleeve, H handle; Medtronic
`^(ONB|NONB|NB|UNVCA|BPT|B)(\d+)(SH|ST|LG)(FLP|SLP|F|S|B)?(-NSB|2C|CS)?` → 70/100/150 mm, optical/
bladeless/bladed/cannula/blunt, fixation/smooth/balloon, low profile, NSB/dual cannula/fascial closure;
Applied `^(C0|CT|CF|CB)([FSRBQ])(\d\d)` → F optical, S sleeve. `brandAssertions(text)`,
`skuAssertion(sku, manufacturer)` (Covidien counts as Medtronic).

### 10.3 Component and constraints (`component.ts`, `constraints.ts`)

`componentOf(text)` → trocar | cannula | obturator | insufflation-needle | accessory | dilating-system |
unknown (order: needle, dilating, "trocar with cannula/sleeve" → trocar, accessory unless named as a
part, obturator-only, sleeve-only, trocar). `componentsCompatible`: unknown always compatible;
dilating-system counts as trocar. `compareAccess(competitor, own)` returns cap, multiplier, findings
(hard / soft / agree / unknown), counts, coverage (known decisive fields of 5: component, diameter,
length, visualization, tip), `diameterConfirmed`, `attributeCap`, `agreement`, `techniqueDiffers`:

| finding | effect |
|---|---|
| component incompatible (hard) | cap **No Match**, × 0.30 |
| trocar ↔ radially expanding system | agree with note, × 0.95, attribute-only Exact barred |
| diameter sets do not overlap within ± 0.5 mm (hard) | cap Alternative, × 0.55 |
| diameter covers but not identical | × 0.97 |
| length class differs | cap Close, × 0.85 |
| optical vs non-optical | cap Close, × 0.85 (competitor optical + ours unknown = half known) |
| bladed vs bladeless (dilating = bladeless) | cap Close, × 0.85 |
| fixation style differs | cap Close, × 0.90 |
| low profile differs | cap Close, × 0.90 |
| our variant add-on the competitor lacks | cap Close, × 0.90; competitor-only add-on: note, × 0.95 |
| instrument range max differs | × 0.97 |

`attributeCap` = Close when coverage < 0.8 (Exact on attributes needs ≥ 4 of 5 decisive fields) or the
technique differs; `agreement` = 0 with any hard finding, else agree/(agree+soft) × (0.7 + 0.3·coverage)
× multiplier.

### 10.4 Similarity, classification, scoring (`bin.ts`, `score.ts`)

`binSimilarity(a, b)`: weighted average over available factors — family 0.25 (0.4 if either is Other,
0 if different → score halved, cap Alternative), product type 0.20 (token Jaccard), dimensions 0.25
(per canonical name, best pair: 1 at ≤ 2 % difference, else max(0, 1 − 2·rel); sizes known on one side
only 0.35; round-vs-rectangular compares extents × 0.85), features 0.15, materials 0.05, text 0.10;
construction caps: fully-absorbable mismatch → Alternative × 0.85, barrier mismatch → Close × 0.92, no
shared core material → Close × 0.92, partially-absorbable → Close; trocar profiles on both sides →
`compareAccess` applied (score × multiplier; with no hard finding score = max(score, agreement); cap
combined; notes lead with ✗/≠ then =). `matchTypeFromScore(score, dims, cap)`: Exact ≥ 0.82 with
dimension score ≥ 0.90 (never Exact when the size is unknown); Close ≥ 0.60; Alternative ≥ 0.38; else No
Match; a cap only ever lowers.

`scoreCandidates(competitor, candidates, weights)` (`DEFAULT_WEIGHTS` bin 0.5, price 0.2, cogs 0.15,
margin 0.15, renormalised over available factors; Settings sliders — see §26 for why saved weights do
not reach queued runs):

- **identity**: scoreBin 1, Exact, source `identity`, confidence 1 ("this is already our product —
  retain" or "successor to our discontinued SKU X").
- **approved curated cross**: effective grade = worse(sheet grade, constraint cap); contradicted rows
  say so ("curated cross (Sheet1, Exact Match) — contradicted by the product attributes; ranked as
  Close Match"); No Match on a hard violation; scoreBin = floor + (1 − floor)·raw (`KNOWN_CROSS_FLOOR`
  Exact 0.95, Close 0.80, Alternative 0.62, Downsell 0.60) so attributes still order within a grade;
  `preferred` rows rank first.
- **unreviewed rep cross**: scoreBin + `REP_PRIOR_BOOST` 0.12, grade from attributes, base 0.6.
- **attribute**: grade from `matchTypeFromScore` with `attributeCap`.
- **confidence** = base (identity 1 / curated 0.9 / attribute 0.8 / rep draft 0.6) × (0.6 + 0.4·coverage
  for trocars; else 1 / 0.75 sizes unknown one side / 0.7 no dims) × (1 − contradiction), contradiction
  only for curated rows (0.25 per soft, 0.5 per hard, 0.125 technique); No Match ≤ 0.5; < 0.75 shows
  "verify".
- price fit 1 if ours ≤ theirs else max(0, 1 − 2·(ratio − 1)); COGS inverted min–max across candidates;
  margin (price − cost)/price ÷ 0.6 capped.
- **sort**: grade → identity → non-import provenance → preferred cross → confidence (only when both
  sides carry access evidence, > 0.02 apart) → source (curated before attribute) → composite score →
  the SKU that has a price for this customer (equal-spec platform ties). A near tie in the top grade
  names the runner-up in the explanation ("NB11STF is an equivalent exact match").
- `factors` stores used weights, notes, `evidence` (findings), `curated {source, grade, effective,
  contradicted, preferred}` and `cap` (binds the model grader).

Cross-family attribute-only accuracy against the curated sheets (`scripts/eval.ts --no-crosses`, no
model): all families 42/68 of 120 top-1/top-3 (was 32/53); trocars 30/38 of 60 (was 16/27); stapling
9/25 and lap instruments 30/34 unchanged. The REQ-7628 Sanford list: diameter mismatches 55 → 0,
component mismatches 27 → 0, evidence-based answer on top for 20/20 of the PACR-advantage cases.

### 10.5 Embedding retrieval (`src/lib/match/embeddings.ts`)

`embeddingText` (deterministic, ≤ 6,000 chars, SKU last) → `embed` (OpenAI, `EMBEDDING_TIMEOUT_MS`,
1 retry) → `OwnProduct.embedding` / `CompetitorProduct.embedding` with `embeddingHash` (sha256 of model +
text; unchanged text is re-stamped, not re-embedded). `refreshEmbeddings(table, {ids, limit, batch 64})`
oldest-first; `nearestOwnProducts(vector, {companyId, k, overfetch})` cosine distance with
`hnsw.ef_search = min(1000, max(100, 2·limit))`; `requestEmbeddingRefresh` enqueues `embed.refresh`
(singleton `embed:<table>[:hash]`). Retrieval decides *who* is compared; the attribute scorer still ranks.

---

## 11. Catalog, GUDID library, sizes and pricing imports

### 11.1 Our catalog (`/catalog`)

Stats, category / "only unpriced / no GUDID record / discontinued" / search filters, a table (SKU,
description, category, GUDID DI link, list, COGS (view_cost), pricebooks, bin source) with an expandable
`BinView`. Actions: **Enrich from GUDID** (`enrichOwnProducts`: openFDA lookup preferring our labelers,
260 ms pacing, rebuilds heuristic bins; in-memory job polled every 1.5 s), **Add SKUs** (paste codes,
≤ 100, category; `catalog/add`: openFDA under our labelers, placeholder refusal, embeddings queued),
**Pricing** (template `.xlsx`/`.csv` pre-filled with every SKU; upload or Sheets link; `importPricing`:
columns SKU, List, COGS, and any other column becomes a pricebook; report of updated rows, pricebooks,
unknown SKUs, invalid rows), **Competitor sizes** (template ordered by spend; upload/Sheets;
`importCompetitorSizes`: keyed on the compact code, default unit cm, clears bins built before the sizes
arrived; the `SizeCoverage` worklist ranks unsized competitor codes by observed spend). Cost imports
(`POST /api/costs/import`: SKU, Cost, Currency, Plant, Region, Cost Type, Effective From/To; idempotent
on product+plant+region+currency+type+from) and purchase imports (`POST /api/purchases/import`: Account
Number, SKU, Quantity, Net Price, Currency, Invoice Date, Contract Number, Invoice Number; registers a
Document; idempotent on account+SKU+external id) feed the cost waterfall and compliance.

### 11.2 GUDID library (`/catalog/gudid`, `src/lib/gudid/library.ts`)

Bulk import of a whole labeler's GUDID catalog from openFDA into `GudidDevice`: `planImport` (count,
labelers, product codes; buckets split by FDA product code then brand to stay under the 26k-per-query
cap; pages of 1,000 up to skip 25,000), `startImport` (one active import; kind COMPETITOR or OWN; in-
distribution-only and product-code filters; queue `gudid.import`), `runImport` (resumes from a page
cursor `{leaf, skip, leaves}`; QUEUED → RUNNING → DONE | FAILED | CANCELLED; progress polled every 2 s),
`cancelImport`. OWN imports with "add to our catalog" adopt records into OwnProduct (`adoptIntoOwnCatalog`,
source `gudid-import`, families chosen; Other and placeholders never adopted); per-row "Add to our
catalog" (`adoptRecords`); "Clean up SKUs" (`pruneAdopted`, dry-run first). The resolver is
library-first (`localHits` by `cfnNorm`/`cfnCompact`, wildcard for tier 3). Lesson recorded: importing
the whole *Medtronic* labeler (88k records) polluted the pool with spinal cages and bore plugs — use the
surgical labeler (Covidien) and families; BIN_VERSION 6 added the review-panel veto.

### 11.3 Cache expiry (`src/lib/gudid/refresh.ts`)

Cached competitor records are served past `GUDID_CACHE_TTL_DAYS` (90) but re-checked in the background
(`refreshIfStale` enqueues `gudid.refresh`, singleton per code; nightly `refreshStaleRecords` in batches
of `GUDID_REFRESH_BATCH`, own SKUs at half the limit); a record is updated only when openFDA's
`public_version_date` changed, and its bin is then cleared.

---

## 12. Crosswalk governance and the learning loop

### 12.1 Governance (`src/lib/xref/governance.ts`, `/crosses`)

`KnownCross` rows are the working set: DRAFT → IN_REVIEW → APPROVED (needs clinical and marketing review
each APPROVED or NOT_REQUIRED, and an equivalence level other than NONE) → RETIRED / REJECTED.
`setReview(actor, id, patch)` (manage_crosswalk; clinical status needs review_crosswalk_clinical or
ADMIN). `publishVersion` freezes every approved, effective cross into a numbered `CrosswalkVersion`
(PUBLISHED; the previous becomes SUPERSEDED; chunks of 500); proposals pin the version they were built
with (`approvedCross(code, versionId)`) and never follow later changes; reps only see the current
PUBLISHED version. `equivalenceFromMatchType`: Exact → EXACT, Close → FUNCTIONAL, Alternative →
CLOSEST_ALTERNATIVE, Downsell → PARTIAL_SUBSTITUTE. `proposeCross` creates a rep DRAFT (crosses already
under review or approved cannot be rewritten by a rep). The page shows the published version, counts by
status, a review queue with per-row equivalence select / Approve clinically / Approve marketing /
Approve / Reject, rep-endorsement evidence, and a filterable table of up to 400 crosses.

The matcher treats curated rows as evidence, not an override (§10.4): contradicted rows are ranked as the
attributes allow, labelled in the UI and in the export's "Curated Sheet" column, and never modified.

### 12.2 Learning loop (`src/lib/xref/learning.ts`)

`recordLineDecision(actor, lineId, {selectedCandidateId, reviewed, overrideNote})` writes a
`MatchDecision` (top recommended vs chosen, acceptedTop, override reason); choosing a non-top candidate
proposes or endorses a rep `KnownCross` (DRAFT) whose `evidenceJson` records endorsements per line,
accounts and users; undoing an override retires a draft only when it was that rep's lone opinion.
`crossesForMatching()` returns APPROVED crosses plus rep DRAFT/IN_REVIEW crosses with an endorsement
count; drafts are a soft prior (`REP_PRIOR_BOOST`), never a tier floor, until review approves them.
Bulk actions (`select_top`, `review_*`) record decisions the same way.

---

## 13. Workflow B — accounts, contracts and the price waterfall

### 13.1 Accounts (`/accounts`, `/accounts/[id]`, `/api/accounts*`)

Account with hierarchy (parent / IDN), type, territory/segment/region, currency, strategic flag, owner,
CRM id, tax exemption, ship-to, contacts; GPO memberships are effective-dated (`POST …/memberships`
upserts the GPO, closes the open membership, opens a new dated row). Detail page: membership history,
applicable contracts (own + GPO contracts unlocked by memberships), proposals, recent purchases,
competitor prices observed here.

### 13.2 Contracts (`/contracts`, `/contracts/[id]`, `src/lib/contracts/*`)

Types LIST / NATIONAL / GPO (needs `gpoId`, `tier`) / IDN (parent account) / LOCAL (account); status
machine DRAFT → ACTIVE → EXPIRED | TERMINATED | SUPERSEDED (terminated/superseded cannot reactivate;
ACTIVE refused on an expired contract unless `effectiveTo` is extended); `precedence` 0–100 overrides
the natural rank; committed volume/value; scopes (family or product; none = whole catalog); price
entries (`POST …/entries`: ≤ 5,000 rows "SKU, price[, minQty, maxQty, tier name]", positive price,
currency must match the contract, supersedes prior ACTIVE entries for the same band; refused on
terminated/superseded contracts); terms (`POST/DELETE …/terms`: commitment {units or value, period},
rebate {type VOLUME | GROWTH | COMPLIANCE | FAMILY | BUNDLE, basis UNITS | VALUE | COMPLIANCE_PCT |
GROWTH_PCT, tiers}, bundle {condition, benefit}, scope). Structured clauses (`clauses.ts`): renewal
NONE | AUTO | NEGOTIATED | EVERGREEN (term months, notice days, increase %); price protection NONE |
FIXED_YEARS | MAX_ANNUAL_PCT | CPI | SCHEDULED | PRICE_MATCH (`protectedCeiling` compounds the cap);
escalation NONE | FIXED_ANNUAL_PCT | CPI | SCHEDULED. Rebates (`rebates.ts`): non-cumulative tiers, the
highest threshold met applies; `effectiveNet` = invoice spend − rebate; `rebateBasisValue` per basis.
Bundles (`bundles.ts`): a benefit (price % / amount / rebate %) on one family or SKU conditional on
volume, value or award elsewhere. Renewal pipeline: active contracts expiring within N days (180)
with performance flags. Compliance (`src/lib/compliance`): commitment status ON_TRACK | AT_RISK (delivered
< 0.8 × elapsed share) | MISSED | MET | NOT_STARTED from `PurchaseRecord`s; `contractPerformance`
(cached in `performanceJson`; flags rebate tiers within 10 % and renewals within 90 days);
`proposalConversion` (annual quantity pro-rated against purchases).

### 13.3 The waterfall (`src/lib/contracts/resolve.ts`, `context.ts`)

Pure `resolveFromInputs`: **LIST → NATIONAL → GPO tier → IDN/parent → LOCAL**, natural ranks 0–4; a
contract with `precedence > 0` ranks 10 + precedence. LIST comes from the product's catalog list price in
the requested currency, else a pricebook entry. Each contract step is checked in order — status ACTIVE,
in force on `asOf`, same currency (no silent conversion), scope, GPO: active membership and tier match,
IDN: the account's parent, LOCAL: this account — then `pickEntry` (ACTIVE + APPROVED + effective; same
currency; quantity inside the volume band; narrowest band, then latest effective). The highest rank
wins; at equal rank the lowest price wins and the step says so. The result carries every step with its
reason and an `explanation` string. `loadPricingContext({accountId, asOf, currency})` loads the
account, memberships and the NATIONAL / GPO / IDN / LOCAL contracts once and exposes
`resolvePrice(product, qty)` and `resolveCost(product)` (plant > region > global, latest effective,
legacy COGS fallback; `catalog/cost.ts`); `primaryContractId` is the newest ACTIVE LOCAL. Explicit FX
only (`catalog/fx.ts` uses the newest stored rate on or before the date and throws when none).

Since `1b43393` a cross-reference **run** that names a known account prices every candidate through
this waterfall (§9.5); proposals always did.

---

## 14. Workflow C — pricing policy and the recommendation engine

### 14.1 Policies (`src/lib/pricing/policy-model.ts`, `policy.ts`, `/settings/pricing`)

Versioned per product family (`*` = default), DRAFT → ACTIVE (supersedes the previous ACTIVE in one
transaction) → SUPERSEDED. Fields: target and minimum margin (fractions), floor method
COST_PLUS_MIN_MARGIN | PCT_OF_LIST | FIXED, default strategy, adjustment, classification COMMODITY |
DIFFERENTIATED, strategic importance 1–5, discount authority per role (fraction of list), approval rules
(`when`: belowFloor, belowTargetMargin, marginBelow, discountFromListOver, discountFromContractOver,
dealValueOver, lineValueOver, strategicAccount, contractMonthsOver; `require`: a role; `reason`).
`DEFAULT_POLICY`: target 0.45, min 0.30, COST_PLUS_MIN_MARGIN, MATCH, DIFFERENTIATED, importance 3,
authority SALES_REP 0.15 / REGIONAL_MANAGER 0.25 / CONTRACTING_MANAGER 0.30 / PRICING_DIRECTOR 0.40 /
PRICING_COMMITTEE 1.0, rules belowFloor → PRICING_COMMITTEE, lineValueOver 250,000 → PRICING_DIRECTOR.
`policyProblems` flags min > target, missing pctOfList/fixed, unknown roles, authority that shrinks up
the chain, no below-floor rule. Seeded policies carry placeholder margins — finance must set real ones.

### 14.2 Recommendation (`src/lib/pricing/recommend.ts`)

Strategies MATCH, UNDERCUT_AMOUNT, UNDERCUT_PCT (2.5 %), HOLD_PREMIUM (5 % over), PRESERVE_CONTRACT,
STRATEGIC_DISCOUNT (15 %), PENETRATION (floor × 1.02). `floorFor` (FIXED / PCT_OF_LIST /
cost ÷ (1 − minMargin)); a competitor price is usable when its basis is KNOWN_ACCOUNT or confidence ≥
0.4; the price is clamped to [floor, reference or list] (HOLD_PREMIUM tops at list), rounded to the
currency's minor unit; discounts measured from list and from the applicable contract price; the
incremental discount authority is measured against the contract price when there is one;
`requiredAuthority` = max(discount authority, rule authority); confidence = 0.35 + 0.2·[cost known] +
(0.25·competitor confidence + 0.1)·[competitor usable] + 0.1·[contract price]; `explanation` (internal)
and `explanationPublic` (what a customer-facing surface may show).

---

## 15. Workflow D — proposals, scenarios, drift, exports, logistics

### 15.1 Lifecycle (`src/lib/proposals/service.ts`, `/proposals/[id]`)

`createFromRequest` (request must be complete; no existing DRAFT for the same request + account):
snapshots the pricing context, active policies, the published crosswalk version and competitor price
summaries; per line takes the selected candidate (a retired product is excluded with the reason),
the approved cross's equivalence level, the waterfall price and source, cost, the intelligence summary
(or the rep's estimate as WEAK / 0.3), runs `recommend` → proposed price = recommendation, approvalState
REQUIRED or NOT_REQUIRED, writes a `MatchDecision`; then bundle notes and `refreshEconomics`; deleted on
failure; audited. Editable only in DRAFT or CHANGES_REQUESTED while unlocked. `setProposedPrice`
(positive, ≤ `MAX_UNIT_PRICE` 1e9, ≤ 10 × list, rounded; derived fields written in the same statement;
pending approvals withdrawn; audited), `setLineIncluded`, `rerecommendLine` (strategy, adjustment,
justification, apply), `recomputeAllLines` (one `UPDATE … FROM unnest`), scenarios (`createScenario`
RECOMMENDED / AGGRESSIVE (UNDERCUT_PCT 5 % with a competitor price, else STRATEGIC_DISCOUNT 5 %) /
MARGIN_OPTIMIZED (lower of target and reference) / CUSTOM; `setScenarioPrice`, `scenarioEconomics`,
`applyScenario` validates like manual edits and audits per line), `newVersion` (clone as `-vN`, DRAFT,
approval states reset). Economics (`economics.ts` `rollup`): revenue, list value, current contract
value, competitor spend, customer savings (+ %), COGS, gross profit, blended margin, discount from
list/contract, share of wallet, approvals pending/required, by family — the one authoritative deal
rollup, stored as `economicsJson`.

### 15.2 Drift (`drift.ts`)

`driftFor` compares a draft's snapshot with today's GPO, local contract, crosswalk version and per-line
list/contract price + source, cost, floor, policy, equivalence and product retirement; the workspace
shows a banner; `refreshContext` re-snapshots an unlocked draft (proposed prices kept), recomputes,
audits CONTEXT_REFRESHED.

### 15.3 Logistics and tax (`src/lib/tax/*`)

Quote-level freight (NONE | FLAT | PCT ≤ 100 %) and tax (NONE | EXEMPT | MANUAL rate ≤ 0.5 |
PROVIDER = AvaTax uncommitted SalesOrder with item code P0000000 and freight code FR020100; `TAX_DRY_RUN`),
ship-to address; `taxFingerprint` (sha1 of lines, freight, tax settings, ship-to) marks the tax figure
stale when anything changes; tax is never part of line economics or margin. `quoteTotals` → subtotal,
freight, tax, total.

### 15.4 Exports (`proposals/export.ts`, `pdf/*`)

Quote as `.xlsx` / `.csv` (`buildQuote`) or branded PDF (`buildQuotePdf`; `pdf/documents.ts` renders
LETTER pages with a paginated table; Settings → Branding sets legal name, address, colours (defaults
`#0f3d5e` / `#1a7f6e`), logo ≤ 300 KB PNG/JPEG ≤ 4 MP, titles, terms, footer, validity days 60).
Export needs `export_proposals`, `canFinalize` (§16.1) and a fresh tax figure; audited EXPORTED. The
customer note prints; justification never does.

---

## 16. Workflow E — approvals, delegation, break-glass, outcomes

### 16.1 Rules (`src/lib/approvals/rules.ts`)

Proposal status derived from its requests (WITHDRAWN/EXPIRED ignored): any REJECTED → REJECTED; else any
CHANGES_REQUESTED → CHANGES_REQUESTED; none pending → APPROVED; all pending → SUBMITTED; else
PARTIALLY_APPROVED. `canFinalize`: not expired (unless WON), ≥ 1 included line, every included line
priced, no line REQUIRED/PENDING/REJECTED, status APPROVED or WON — gates export, CRM push and WON.

### 16.2 Deal desk (`service.ts`, `/approvals`)

`submitForApproval` (edit_proposed_pricing; DRAFT or CHANGES_REQUESTED; every included line priced):
atomic claim (`lockedAt`, SUBMITTED), earlier requests WITHDRAWN, all lines recomputed; per line no
authority needed → NOT_REQUIRED, submitter holds the authority → auto-APPROVED (audited), else an
`ApprovalRequest` (PENDING, snapshot of price/margin/discount/deal value); status APPROVED when nothing
routed; `notifyApprovalRequested` (includes delegates, excludes submitters); rollback on any failure.
`decide(actor, requestId, APPROVED | REJECTED | CHANGES_REQUESTED, comments)`: the actor must see the
proposal; below-floor lines need approve_below_floor, others approve_discount; authority may come from
a delegation but never from the delegator who submitted; **nobody decides their own request except an
ADMIN with a reason ≥ `BREAK_GLASS_MIN_REASON` 20 characters — flagged `breakGlass`, audited, other
ADMINs/PRICING_DIRECTORs notified**; if the line's price moved since the snapshot the request is
WITHDRAWN; atomic claim; status re-derived (CHANGES_REQUESTED unlocks); APPROVED/REJECTED triggers an
analytics refresh. `reopen` (not WON/LOST): requests withdrawn, back to DRAFT, unlocked. `queueFor`
lists PENDING requests in scope that the actor can decide.

### 16.3 Delegation (`delegation.ts`)

Out-of-office lending of authority roles and the approve_discount / approve_below_floor permissions
(never ADMIN): ≤ `MAX_DELEGATION_DAYS` 90, no overlap, end not in the past, the delegate must already
hold approve_discount, only an ADMIN may delegate on someone else's behalf; states active / scheduled /
expired / revoked; `authorityFor` records `onBehalfOf`; audited and notified.

### 16.4 Outcomes (`proposals/outcome.ts`)

`recordOutcome` (record_outcomes; a closed proposal cannot be re-closed): WON requires `canFinalize`
and creates the LOCAL contract first (`contractFromProposal`: number `LOC-<acct|id6>-<ref>`, idempotent,
1–120 months, contract + ACTIVE/APPROVED price entries (source `proposal`) + commitments in one
transaction); LOST records the competitor's winning prices as `WIN_LOSS_RECORD` observations;
`DealOutcome` upserted; analytics refreshed (winloss, pricing, conversion).

### 16.5 CRM push

`pushQuote` → Tier 2 Salesforce write-back when enabled (§18.2) else the legacy/file adapter (quotes to
`<INTEGRATION_FEED_DIR>/outbound/quotes`); `CRM_PUSH_MARGIN` / the integration's `pushMargin` decide
whether blended margin leaves Crosswalk; needs `canFinalize`.

---

## 17. Competitive intelligence, documents and public bids

### 17.1 Observations (`src/lib/intelligence/*`, `/intelligence`)

`CompetitorPriceObservation` is append-only: competitor (found or created by name), code, price, UOM,
account / GPO / region, observed date (≤ 1 day in the future), source type, source ref, raw confidence,
notes; verification UNVERIFIED | VERIFIED | DISPUTED. `summarize(obs, ctx)` (pure): same currency and
UOM only; weight = reliability × 0.5^(age/halfLife) × verification (VERIFIED 1, DISPUTED 0.4, else 0.85)
× relevance (account 1, GPO 0.85, region 0.7, market 0.55); basis **KNOWN_ACCOUNT** (an account
observation with confidence ≥ 0.4), **MARKET_ESTIMATE** (weight sum ≥ 0.4; weighted median; confidence
min(0.9, w/(w+1) + 0.15·[≥ 3 obs])), **WEAK** (≤ 0.39), NONE; trend newest third vs oldest third ± 3 %.
Source reliability / half-life (days): CUSTOMER_INVOICE 1.0/365, CUSTOMER_PO 0.95/365, CUSTOMER_BID_FILE
0.9/270, GPO_CONTRACT_FILE 0.85/540, WIN_LOSS_RECORD 0.8/365, INTERNAL_VERIFIED 0.75/270, PUBLIC_BID_DB
0.65/365, REP_OBSERVED 0.55/180, ANECDOTAL 0.35/120. Imports: `.xlsx`/`.csv`/Sheets with Competitor,
Code, Price required (registered as a Document). The page: code search with summary (basis, reference,
confidence, median, range, trend), observation table with Verify / Dispute, coverage by competitor
code, "Record an observation" form, import, "Extract a document…".

### 17.2 Document extraction (`src/lib/integrations/documents/*`, `/intelligence/extractions/[id]`)

`POST /api/documents/extract` (file ≤ 25 MB, type INVOICE | PO | BID_LIST | CONTRACT_TABLE |
COMPETITOR_LIST | OTHER) stores the bytes under `DOCUMENT_STORAGE_DIR` (path from the id only) and runs
the configured provider — `manual` (csv/xlsx grid with header synonyms, confidence 1), `http` (vendor
endpoint, multipart or base64 JSON, response-path mapping, 120 s), `mock`. `runExtraction` → status
REVIEW when forced (`alwaysReview`), any line below the threshold (0.85), a required field missing, or
no lines; else EXTRACTED; a LOW_CONFIDENCE_EXTRACTION review item. The review page shows header fields
and lines with per-cell ✓/✕/correct; `verifyExtraction` → VERIFIED; "Import verified lines" →
`verifiedLinesGrid` → `importObservationRows` (source type from the document type).

### 17.3 Public bids (`src/lib/intelligence/bids.ts`, `/intelligence/bids`)

Sources `sam` (needs `SAM_API_KEY`, key in `x-api-key`, `SAM_MAX_PAGES` 1–5) and `usaspending`
(`spending_by_award`, ≤ 10 pages of 100, hierarchical PSC paths; verified live, 1,000 awards); settings
(keywords, NAICS 339112/339113, PSC 6515, look-back 30 days, minimum amount) saved by
configure_settings; nightly `bids.ingest` per configured source (`BIDS_CRON`), "Pull now" refused within
an hour of a success unless forced; quota errors end the run without failing it; `upsertAwards` matches
competitors by name; bid-file import (portal name + CSV/XLSX, ≤ 20,000 rows; a row with a code and unit
price also records a PUBLIC_BID_DB observation). The page lists awards, recent pulls and the settings.

---

## 18. Integrations

Design: `docs/INTEGRATION_ARCHITECTURE.md`; admin guide: `docs/INTEGRATION_SETUP.md`; systems of record:
`docs/INTEGRATIONS.md`. Nothing is required for the app to run; each integration is a definition a
company fills with credentials, URLs, field mappings and an enable switch.

### 18.1 Legacy routes (`src/lib/integrations/{sync,file,dev,salesforce,sap}.ts`, feeds)

Adapter choice per system: the API adapter when configured (`SF_CLIENT_ID`, `SAP_ODATA_BASE_URL` — the
top-level `salesforce.ts` / `sap.ts` are skeletons that throw `NotConfigured`), else the **file feed**
(`INTEGRATION_FEED_DIR` with `crm-accounts.csv`, `crm-opportunities.csv`, `erp-skus.csv`,
`erp-costs.csv`, `erp-purchases.csv`, `gpo-memberships.csv`; quotes written to `outbound/quotes/`),
else **dev fixtures** (`data/fixtures/integrations/*.json`). `syncCrmAccounts` / `syncErp` /
`syncGpoMemberships` (3 attempts, backoff) reconcile accounts through ExternalRef → `externalCrmId` →
account number (a number already bound to another CRM record fails loudly). `integrationStatus()` and
Settings → Integrations show status and "How to connect"; "Sync now" queues a feed ingest and polls up
to 20 s. Tier 2 integrations, when enabled, take over these entry points.

### 18.2 Tier 2 layer (`src/lib/integrations/core/*` + providers)

External system → provider adapter → **mapping engine** → canonical import record (`types.ts`) →
**domain writers** → DB, with provenance on every row.

- **registry.ts** — one `IntegrationDefinition` per key: `salesforce` (providers salesforce | mock;
  syncs accounts, opportunities, contacts; webhook), `sap` (odata | mock; materials, costs, prices,
  billing), `gpo:premier` / `gpo:vizient` / `gpo:healthtrust` (file | api | mock; memberships; upload;
  `closeMissing`), `documents` (manual | http | mock; threshold 0.85, alwaysReview), `fx` (manual | ecb
  | http | mock; base USD, quotes EUR/GBP/CAD, fallback `fail`, look-back), `competitor-contracts` (file
  | mock; prices; upload; UOM aliases, currencies, unknown-competitor policy, keepExpired). Typed field
  specs (secret flag), mapping specs per entity, factories `buildCrm/Erp/GpoRoster/Extraction/Fx/
  ContractPrices/Any`; mocks refused in production unless `INTEGRATIONS_ALLOW_MOCK=true`.
- **config.ts** — `IntegrationConfig` rows; secrets sealed with AES-256-GCM (`v1.<iv>.<enc>.<tag>`) under
  `INTEGRATIONS_ENCRYPTION_KEY` (else HKDF of `SESSION_SECRET`); `env:NAME` references resolved at use
  time; `configVersion` bumps on save; status NOT_CONFIGURED / CONFIGURED / DISABLED; per-sync-type
  cursors; secrets never echoed (present/absent only).
- **mapping.ts** — `FieldRule {source, constant, transform (trim, upper, lower, number, money, bool,
  date (Excel serials, OData `/Date()/`, SAP yyyymmdd, m/d/yyyy), datetime, int, split, first, join,
  digits), valueMap, unmapped keep|null|error, default, required}`; `applyMapping`, `validateMapping`
  (dry against the spec, live against the provider's described fields), `mergeMapping`.
- **runner.ts** — `runSync(key, syncType, trigger, actor, {queueJobId, full, upload, maxPages,
  fetchImpl})`: checks sync type/upload support, since-watermark from the cursor (ignored on `full` or
  upload), starts an `IntegrationSyncJob`, dispatches by family (accounts re-link parents that arrived
  first; ERP materials trigger embeddings; GPO incremental only for API with a since-param, then
  `reconcileRoster`; FX pulls each base × quote; contracts `ingestContractPrices`), moves the watermark
  only after a complete run, `finishJob` → SUCCEEDED or PARTIAL (row errors, ≤ 5,000 kept, report
  ≤ 200 KB), `recordSyncOutcome` → health (CONNECTED / DEGRADED / ERROR; DISABLED always wins);
  `testConnection`, `validateIntegrationMapping`; `MAX_PAGES` 10,000.
- **writers.ts** — idempotent on ExternalRef(system, entityType, externalId) + payload hash, never
  delete: `writeAccount` (reconciles ExternalRef → CRM id → account number; conflict → DataConflictError;
  CRM GPO affiliation applied unless a roster membership outranks it; ≤ 50 contacts), `writeGpoAffiliation`,
  `writeOpportunity`, `writeContacts`, `writeProduct` (placeholders skipped, source erp),
  `writeStandardCost` (positive; STANDARD | LANDED | TRANSFER), `writeListPrice` (pricebook `<SYSTEM>
  list · <book|condition>`), `writeBilling` (links contract and latest WON proposal).
- **errors.ts / http.ts** — categories AUTHENTICATION, AUTHORIZATION, CONFIGURATION, MAPPING, VALIDATION,
  RATE_LIMIT, PROVIDER_UNAVAILABLE, TIMEOUT, DATA_CONFLICT, NOT_FOUND, UNKNOWN (retryable: rate limit,
  unavailable, timeout); messages redacted (tokens, keys, URL credentials); `httpJson` with 20 s timeout,
  2 retries, status classification, Retry-After honoured (≤ 60 s), equal-jitter backoff (≤ 15 s).
- **jobs.ts, health.ts, review.ts, schedule.ts, webhooks.ts, tabular.ts, admin.ts** — job lifecycle
  (QUEUED → RUNNING → SUCCEEDED | PARTIAL | FAILED | CANCELLED; stale jobs cancelled after 12 h); health
  states; review queue (one OPEN item per dedupe key; kinds UNMATCHED_ACCOUNT, MEMBERSHIP_CONFLICT,
  DUPLICATE, LOW_CONFIDENCE_EXTRACTION, PRICE_EXCEPTION, UNKNOWN_COMPETITOR, MAPPING_ERROR, OVERLAP;
  resolutions LINKED / ACCEPTED / DISMISSED / CORRECTED); one pg-boss schedule per key × sync type
  (`integration-<key>-<type>`, `missed: once`); webhook auth hmac-sha256 | shared-secret | basic | none,
  timing-safe, idempotent by event id; CSV/XLSX grids, file location by newest match (directory, SFTP via
  optional `ssh2-sftp-client`, upload); the Settings admin API (save validates shape, mapping and a
  5-field cron, audits without secret values, reschedules; job detail with row errors; review actions).

Providers: **Salesforce** (`salesforce/`): client-credentials or JWT-bearer (RS256, 3-min expiry, token
cached 50 min, https only), REST client (`query`/`queryMore`, `describeFields`, `upsert` by external id,
`upsertCollection` in chunks of 200 `allOrNone:false`, one re-auth on 401, REQUEST_LIMIT_EXCEEDED → 15-min
rate limit), adapter (SOQL by `LastModifiedDate`, cursor `more:<url>`, GPO affiliations, quote upsert with
the proposal id as idempotency key and lines `<id>-<n>`, `fetchAccountsByIds` ≤ 200), default mapping
(Type valueMap → SOLD_TO/HEALTH_SYSTEM…, `Owner.Territory__c`, `Crosswalk_Quote__c`), webhook
(`x-crosswalk-signature` HMAC; 404 disabled / 403 no secret / 401 bad signature / 200 duplicate / 202 no ids;
pulls the named accounts in a webhook job; 503 on retryable failure), write-back (`buildQuoteWriteback`
only for APPROVED/WON with a CRM-linked account; skipped when the payload hash is unchanged; SyncLog +
audit PUSHED_TO_CRM / CRM_PUSH_FAILED). **SAP** (`sap/`): OData v2/v4 client (basic or OAuth, tokens cached,
`d`/`value` normalised, `@odata.nextLink`), adapter (materials, standard costs ÷ price unit with plant →
region, list prices by condition type, billing net ÷ quantity; cursor `link:<next>`), default mapping
for the S/4 standard APIs. **GPO rosters** (`gpo/`): profiles Premier / Vizient / HealthTrust (HPG)
with default column maps; file adapter (a consumed file hash returns nothing; bad rows rejected, not
dropped), API adapter (next-link or page number, 500/page); `reconcileRoster`: match by account number →
CRM id → prior membership with the same external id; unmatched → review with suggestions; duplicates
with different data → review; a changed membership closes the old row and opens a new one; different-
tier overlap → conflict review; stale memberships closed only on a complete roster with `closeMissing`.
**Competitor contract prices**: mapping with UOM aliases (unknown units flagged ambiguous), file
adapter, `ingestContractPrices` (row errors for missing price / bad dates / bad currency; reviews for
ambiguous UOM, unknown competitor (name suggestions), unknown GPO, in-file duplicate, price differing for
the same key, overlapping validity; expired skipped unless kept; exact repeats skipped; recorded as
GPO_CONTRACT_FILE observations; `resolveContractReview` accept/dismiss re-ingests with known conflicts
accepted). **Documents** (§17.2). **FX** (`fx/`): manual, ECB (SDMX CSV; crosses through EUR tagged
`ecb-cross`), HTTP template (`{base}`/`{quote}`/`{date}`; a rate for another date is refused), mock;
`storeRate` never overwrites a stored historical rate (restatements logged); `rateFor` = stored → provider
on the date → look-back within `maxLookbackDays` → NOT_FOUND; `convertWithProvider`, `pullRates`.
Every family ships a labelled mock with scenarios ok / empty / auth-failure / timeout / rate-limit /
unavailable / partial / malformed / duplicate. Onboarding was simulated end-to-end through the UI with
Playwright on the production build (Tier 2 delivery notes).

---

## 19. Background jobs, feeds, notifications, alerts, metrics, analytics, retention

### 19.1 Queue (`src/lib/jobs/*`)

pg-boss in the app database (schema `JOBS_SCHEMA`, own pool `JOBS_POOL_MAX` 3, maintenance every
`JOBS_MAINTENANCE_SECONDS`); `JOBS_WORKER` inline (workers in the Next process, default) | external
(`npm run worker` / container role `worker`) | off. Queues (all `policy: exclusive`; retry limit / delay /
backoff / heartbeat / expiry / delete-after): `request.run` 2 / 30 s / yes / 60 s / 23 h / 7 d;
`gudid.import` 3 / 60 s / yes / 60 s / 23 h / 7 d; `gudid.refresh` 2 / 120 s / yes / 60 s / 6 h / 2 d;
`integration.sync` 2 / 60 s / yes / 60 s / 12 h / 7 d; `feed.ingest` 2 / 120 s / yes / 60 s / 12 h / 14 d;
`notify.deliver` 5 / 15 s (max 900) / yes / — / 300 s / 3 d (concurrency 4, poll 2 s); `alerts.evaluate`
0 / — / — / — / 600 s / 1 d; `embed.refresh` 2 / 120 s / yes / 60 s / 6 h / 2 d; `analytics.refresh`
1 / 60 s / — / — / 1800 s / 2 d; `bids.ingest` 2 / 300 s / yes / 60 s / 6 h / 7 d; `retention.sweep`
0 / — / — / 60 s / 1 h / 30 d. Handlers: `runRequest`, `runImport`, `refreshStaleRecords`, Tier 2
`runSync` (key given) or legacy syncs, `ingestFeed`, `deliver`, `evaluateAlerts`, `refreshEmbeddings`,
`refreshSnapshots`, `ingestPublicAwards`, `runRetention`. Polling 5 s, batch 1; `attempt = retryCount +
1`, `finalAttempt = attempt > retryLimit`, final failures notify. Cron (UTC, `off` unschedules):
alerts `*/5 * * * *`, gudid.refresh `30 3 * * *`, embed `15 4 * * *`, analytics `0 * * * *`, bids
`0 5 * * *` per source, retention `45 2 * * *` (only when enabled), plus the feed and integration
schedules. `recoverOrphans` at start re-enqueues queued/running requests and imports with no live job
(`resume: true`) or marks them failed once attempts are exhausted (3 runs, 4 imports). Verified live in
Tier 1: `kill -9` during a 4,432-record import → heartbeat lapse → retry resumed at the cursor.
`queueHealth()` (queued, ready, active, failed, oldest ready) feeds `/api/health` (503 when the DB is
down; degraded when the oldest ready job is > 900 s) and the metrics.

### 19.2 Feeds (`src/lib/feeds/*`)

Scheduled file/API ingestion from `INTEGRATION_FEED_DIR`: crm `0 2 * * *` (max age 36 h), erp
`30 2 * * *` (36 h), gpo `0 3 * * 1` (8 d), pricing `15 2 * * *` (36 h), competitor-sizes `0 4 * * 1`
(8 d), competitor-prices `45 2 * * *` (8 d); one run per feed at a time (RUNNING older than 12 h counts
as dead); an unchanged file (content hash cached by mtime + size) is skipped only after a clean run;
`FeedRun` history; failures notify; `FEEDS_RUN_ON_START`. Settings → System shows freshness and "Run now".

### 19.3 Notifications (`src/lib/notifications/*`, `/notifications`)

Kinds RUN_COMPLETE, RUN_FAILED, APPROVAL_REQUESTED, APPROVAL_DECIDED, PROPOSAL_APPROVED, CROSS_PROPOSED,
FEED_FAILED, ALERT, JOB_FAILED, BREAK_GLASS. `notify` dedupes within an hour, writes the in-app row and
enqueues `notify.deliver` per channel (singleton `<id>:<channel>`); email via nodemailer (`SMTP_URL`,
`MAIL_FROM`), Teams MessageCard (`TEAMS_WEBHOOK_URL`); `NOTIFY_DRY_RUN`; delivery idempotent per channel,
throws so the queue retries. Preferences per kind or `*` (defaults: in-app + email on; Teams only for
ALERT, FEED_FAILED, JOB_FAILED); the inbox page lists, marks read, and edits the delivery table; the
sidebar bell polls unread every 30 s while visible. Recipients: approvers (with delegates, minus
submitters), admins (ADMIN + PRICING_DIRECTOR), clinical reviewers + product marketing for proposed crosses.

### 19.4 Alerts and metrics (`src/lib/observability/*`)

Rules (`evaluateAlerts`, one Alert per fingerprint, re-notify after `ALERT_RENOTIFY_HOURS`): model —
≥ 3 of the last 5 calls in 30 min failed → CRITICAL; resolution ratio below `ALERT_RESOLUTION_MIN` on
lists ≥ 5 lines (BENCH-* excluded); more than `ALERT_RUN_FAILURES` failed runs in 24 h; queue stall
≥ `ALERT_QUEUE_STALL_MIN` (CRITICAL at 4×) and failed jobs; feed failed (CRITICAL) / stale (WARNING).
Prometheus text at `/api/metrics` (Bearer `METRICS_TOKEN` or an ADMIN session): http requests/seconds,
openFDA requests/wait, llm calls/tokens, jobs, runs, notifications, alerts firing, queue jobs and oldest
ready, last-run resolution/match ratios, feed age, process start. Structured JSON logs (`LOG_FORMAT`,
`LOG_LEVEL`) with request ids (AsyncLocalStorage) and secret scrubbing; NDJSON export
(`/api/observability/export?kind=llm|runs|sync|feeds|alerts|jobs`, ADMIN). Settings → System card:
alerts, queues, failures + Retry failed, feeds + Run now, model, openFDA (Refresh stale), notifications,
logging, tenancy, embeddings, tax, "Evaluate alerts now".

### 19.5 Analytics (`src/lib/analytics/*`, `/analytics`)

Reports winloss (by competitor, segment, GPO, rep, discount band, family; loss reasons), pricing
(effectiveness, margin trend), conversion (post-win by family), accuracy (rep acceptance and validated
accuracy separately); computed into `AnalyticsSnapshot` (hourly cron, event-driven debounced 30 s after
outcomes/approvals, manual), 24 kept per report, stale after `ANALYTICS_STALE_MINUTES`; `GET
/api/analytics/{report}?fresh=1` recomputes at most once a minute; margin redacted per permission.

### 19.6 Retention and backups (`src/lib/retention.ts`, `docs/BACKUPS.md`, `docs/DATA_ACCESS_POLICY.md`)

Off until `RETENTION_ENABLED=true`; nightly sweep of LLM calls (90 d), sync logs (180 d), feed runs
(180 d), read notifications (180 d), snapshots (90 d, newest per report kept), resolved alerts (90 d),
and requests only when `RETENTION_REQUESTS_DAYS` is set explicitly (≤ 200 per run, never those a
proposal references; MatchDecisions unlinked, not deleted); audit events never swept; every sweep
writes an audit event; `npm run retention -- --dry-run`. The database is the whole state.

## 20. User interface: the 22 pages

The root layout (`src/app/layout.tsx`) renders the sidebar and, when nobody is signed in, `SignInScreen`
in place of every page. There is no standalone sign-in route: sign-in is the screen plus the sidebar's
`DevSignIn` box (dev users in `sso=none`, an SSO link in `oidc`, a note in `proxy`). Every page is a
server component; the interactive parts are client views (`view.tsx`, `client.tsx`, `workspace.tsx`, …)
that call the API routes in §21.

### 20.1 Sidebar (`src/components/sidebar.tsx`)

Thirteen entries, filtered by `!perm || perms.has(perm) || ADMIN`:

| # | Label | Route | Needs |
|---|---|---|---|
| 1 | Overview | `/` | — |
| 2 | Cross-reference | `/requests` | run_cross_reference |
| 3 | Proposals | `/proposals` | view_pricing |
| 4 | Deal desk | `/approvals` | approve_discount |
| 5 | Accounts | `/accounts` | view_pricing |
| 6 | Contracts | `/contracts` | view_pricing |
| 7 | Competitor pricing | `/intelligence` | view_pricing |
| 8 | Public bids | `/intelligence/bids` | view_pricing |
| 9 | Analytics | `/analytics` | view_analytics |
| 10 | Our catalog | `/catalog` | — |
| 11 | GUDID library | `/catalog/gudid` | — |
| 12 | Crosswalk | `/crosses` | — |
| 13 | Settings | `/settings` | — |

Plus the notifications bell (unread badge, polls every 30 s while visible), the "+ New request" button
(run_cross_reference), the identity box, the model status line ("Model: X" or "Heuristic mode · no
model key"), "openFDA · GUDID mirror" and "Deployed for {companyName}". Active state is exact match or
the longest matching prefix. `/settings/pricing` and `/settings/integrations` are reached from the
Settings page, not the sidebar. The `section` headings declared on items 5 and 10 ("Commercial",
"Reference") are never rendered (§26).

### 20.2 Shared components (`src/components/`)

`ui.tsx` — `PageHeader`, `Card`, `Stat`, `MatchChip` (Exact / Close / Alternative / US Downsell / No
match / Not found), `Chip` (with title tooltip), `ScoreBar`, `Empty`, `StatusPill`, `money`, `num`,
`relTime`. `commercial.tsx` — `STATUS_TONE`, `Pill`, `ProposalStatus`, `fmtMoney`, `fmtPct`, `label`.
`sidebar.tsx`, `dev-signin.tsx`, `sign-in.tsx`, `notifications-bell.tsx`. `BinView` (exported from the
request view) is reused by the catalog page; `DelegationPanel` by the approvals queue.

### 20.3 Page by page

| Route | What it shows and does | APIs it calls | Gate |
|---|---|---|---|
| `/` | Four stats (requests, competitor products resolved, our SKUs, known crosses); recent requests (8, scoped, `BENCH-` excluded); Readiness card (catalog / pricing / model / curated crosses); "How a request runs"; New request | none (Prisma) | session |
| `/requests` | Request table (account, pricebook, lines, resolved, E/C/A, our value, status, created; 200) | none | run_cross_reference, scoped |
| `/requests/new` | Three-step wizard: source (Sheets link / upload / paste) → preview (codes, units, merged, skipped, detected columns) → report type, account type/number/name (number auto-filled from an 8+ digit run in the file name), pricebook, requested by → "Use the model" toggle → Continue | `POST /api/intake/preview`, `POST /api/requests` | APIs only |
| `/requests/[id]` | Header (account, status, pricebook, model/heuristic, source link); Re-run, Cancel, Re-grade fresh, Download menu (xref xlsx/csv, offer xlsx/csv/pdf), Google Sheets, Create proposal; progress bar (polls 1.2 s); banners; 6 stats; filters (All / Needs attention / Flagged / Exact / Close / Alternative / Already ours), search, Bulk actions (6), expand all. Per line: competitor with chips, best-fit SKU + MatchChip, fit bar, unit/extended price, Reviewed. Expanded: competitor pane (DI link, GMDN, bin, other GUDID records, est. competitor price, rep note, customer note, Flag to verify), candidates pane (radio, fit/price/cost/margin sub-scores, confidence chip, evidence list ✗/≠/=, price source, compare attributes, side-by-side modal); run log | `GET/DELETE /api/requests/{id}`, `PATCH …/lines/{lineId}`, `POST …/run`, `…/cancel`, `…/bulk`, `…/sheets`, `GET …/export`, `GET …/lines/{lineId}/compare`, `PATCH /api/competitor/{id}`, `POST /api/proposals` | APIs (run_cross_reference; proposal needs edit_proposed_pricing), scoped |
| `/proposals` | Table (version, account, GPO, lines, value, savings, margin with view_margin, status + pending approvals, valid through; 200) | none | view_pricing, scoped |
| `/proposals/[id]` | Workspace: Submit / Reopen / Quote PDF & xlsx (after `finalize.ok`) / Push to CRM / Record outcome / New version; drift banner; outcome banner; sticky KPIs (contract value, savings, gross profit and margin masked without view_margin, share of wallet, approvals); scenarios (RECOMMENDED / AGGRESSIVE / MARGIN_OPTIMIZED / CUSTOMER_REQUESTED / CUSTOM, apply, delete); logistics panel (freight NONE/FLAT/PCT, tax NONE/EXEMPT/MANUAL/PROVIDER, ship-to, Calculate tax); line table with inline proposed price (Floor with view_cost, Margin with view_margin); line drawer (Recommendation with strategy + adjustment + justification, Price waterfall, Competitor prices, Cost basis, Cross evidence, Approvals, customer note, exclude/include); audit trail | `GET /api/proposals/{id}` and every sub-route in §21.7 | server sends `permissions {editPricing, viewCost, viewMargin, approve, export, outcomes}`; editing only DRAFT / CHANGES_REQUESTED and unlocked |
| `/approvals` | Delegation panel (covering for / given, delegate form, revoke); queue items (proposal, account, needed role, below-floor pill, code/SKU, reason, delegation / self-submitted / break-glass notices, proposed / recommended / floor / margin / discount, deal revenue, comments, Approve / Changes / Reject) | `GET /api/approvals`, `POST /api/approvals/{id}`, `GET/POST /api/approvals/delegations`, `DELETE …/{id}` | APIs (view_pricing read, approve_discount decide) |
| `/accounts` | Table (strategic flag, type, parent/IDN, current GPO + tier, region, contract / proposal / purchase counts) | none | view_pricing, scoped |
| `/accounts/[id]` | GPO membership history; applicable contracts (own + GPO unlocked by memberships); proposals; recent purchases (25); competitor prices observed here (25) | none | view_pricing, scoped `findFirst` |
| `/contracts` | Renewal pipeline (active, expiring ≤ 180 d, flags); contracts table; New contract popover (number, type, name, account number lookup, tier, dates) | `GET /api/accounts?q=`, `POST /api/contracts` | view_pricing, scoped; POST needs manage_contracts |
| `/contracts/[id]` | Status, Refresh performance, Terminate / Activate; performance flags; clauses, commitments, rebates & bundles; price entries table + "SKU, price[, minQty, maxQty, tier]" textarea; proposals referencing it | `GET /api/contracts/{id}`, `…/performance`, `PATCH /api/contracts/{id}`, `POST …/entries` | APIs (view_pricing / manage_contracts / edit_contract_pricing) |
| `/intelligence` | Import xlsx/csv; "Extract a document…" (PDF/image/xlsx/csv; type guessed from the file name); code search with summary (basis, reference, confidence, median, range, trend); observations with Verify / Dispute; coverage by competitor code; record-an-observation form | `GET/POST /api/intelligence`, `PATCH /api/intelligence/{id}`, `POST /api/intelligence/import`, `POST /api/documents/extract` | APIs (view_pricing / import / verify) |
| `/intelligence/bids` | Awards search (source SAM / USASPENDING / BIDFILE, awardee); recent pulls; Pull now per source; "What to look for" settings (keywords, NAICS, PSC, look-back, minimum); bid-file import | `GET/POST /api/intelligence/bids`, `POST …/bids/import` | APIs |
| `/intelligence/extractions/[id]` | Extraction review: header fields grid, line table, per-cell ✓ / ✕ with editable value, low-confidence cells amber; Mark remaining verified, Save decisions, Finalise, Import verified lines | `GET /api/documents/extractions/{id}`, `POST …/verify`, `POST …/import` | APIs |
| `/analytics` | "As of" bar + Refresh; 6 stats (decided deals, win rate, median discount to win, recommendation followed, post-win conversion, top-1 acceptance); 11 tables (win/loss by competitor / family / discount band, loss reasons, margin trend (margin with view_margin), price spread, conversion by family, acceptance by family and over time, override reasons) | snapshots read server-side; `POST /api/analytics/all` | view_analytics |
| `/catalog` | 5 stats; category / only (unpriced, no GUDID, discontinued) / search filters; table (SKU, description, category, DI link, list, COGS with view_cost, pricebooks, bin source) with expandable BinView; Enrich from GUDID (polls 1.5 s); Pricing (template, upload, Sheets); Competitor sizes (template, upload, Sheets, coverage worklist); Add SKUs | `/api/catalog/enrich`, `/api/catalog/add`, `/api/pricing/template`, `/api/pricing/import`, `/api/competitor-sizes/{template,import,coverage}` | session; buttons need manage_catalog / import_cost_data (list prices shown without view_pricing, §26) |
| `/catalog/gudid` | 4 stats; manufacturer / family filters, search (CFN, DI, brand, description, GMDN); records table with "Add to our catalog"; detail with AccessGUDID link; Import panel (competitor vs own, labeler query, in-distribution, families, product codes, Preview count, Start, progress polls 2 s, Cancel); Clean up SKUs (preview / remove); import history | `POST /api/catalog/gudid`, `…/plan`, `…/adopt`, `…/prune`, `GET/DELETE …/{id}` | session; manage_catalog to change |
| `/crosses` | Governance panel (published version, entries, pinned proposals, counts by status, Publish new version); review queue (DRAFT / IN_REVIEW: equivalence, Approve clinically, Approve marketing, Approve, Reject; rep-endorsement evidence); 4 stats; filters (match type, competitor, source sheet, search); table of up to 400 | `GET /api/crosswalk/versions`, `GET /api/crosses?status=`, `PATCH /api/crosses/{id}`, `POST /api/crosswalk/publish` | session; queue APIs need view_pricing (§26) |
| `/notifications` | Inbox (unread toggle, mark all / per item); delivery preferences per kind (in-app / email / Teams; channels disabled when unconfigured) | `GET/POST /api/notifications`, `GET/PATCH …/preferences` | session |
| `/settings` | Ranking weights (bin / price / cogs / margin), candidates per line 1–12, company name; Model card; System card (configure_settings: alerts, queues, failures + retry, feeds + run now, model, openFDA refresh, notifications, logging, tenancy, embeddings, tax, evaluate alerts; polls 20 s); Branding card (legal name, address, contacts, colours, validity days, logo ≤ 300 KB, quote/offer titles and terms, footer); Integrations card (CRM / ERP / GPO status, How to connect, Sync now, links); Google card (Test connection); data sources | `POST /api/settings`, `GET/POST /api/system`, `POST /api/feeds`, `GET/PUT /api/settings/branding`, `GET /api/integrations`, `POST /api/integrations/sync`, `GET /api/google?test=1` | session; cards gated by `can()` |
| `/settings/integrations` | Schema-driven admin: list by family (CRM, ERP, GPO rosters, Documents, Exchange rates, Competitor pricing) + Review queue; editor (provider, fields with write-only secrets and clear, mapping JSON, cron, enabled); Save / Test / Validate mapping / Validate against provider / Sync a test record / Run sync / Full resync / Upload; "Required from the company"; needs-review list; sync history | every route under `/api/integrations/config`, `/api/integrations/review`, `/api/integrations/jobs/{id}` | configure_settings (else redirect to `/settings`) |
| `/settings/pricing` | Versioned pricing policies: New draft (family, name, target / minimum margin, default strategy, adjustment, classification, strategic importance, discount authority per role, approval rules JSON); table with Activate (DRAFT) / New version | `GET/POST /api/pricing-policies`, `POST …/{id}/activate` | APIs (view_pricing / configure_pricing_rules) |

## 21. API: the 101 routes

101 `route.ts` files under `src/app/api/`, 132 method handlers (GET 55, POST 59, PATCH 9, DELETE 7,
PUT 2). Every route except `/api/auth/*`, `/api/health` and `/api/metrics` sits behind the proxy's
session gate (§8). Inside the handler, `handle(perm, fn)` (JSON) or `authorize(perm)` (files, CSV)
resolves the actor, returns 401 / 403 (`Missing permission: <perm>`), runs the ownership-scope hook for
`/api/(accounts|requests|proposals|contracts)/<id>` paths, serialises Decimals, and maps errors to
status (`errorResponse`): service messages — not found → 404; already / changed / decided by someone /
being submitted / conflict → 409; otherwise 400; database errors — unique constraint → 409, foreign
key / overflow / bad encoding / too long → 400 with generic text, unreachable → 503, anything else →
500; runtime faults (TypeError and friends) → 500 (a body the runtime could not parse → 400); the raw
driver text never reaches the client. Validators: `requireText`,
`optText`, `oneOf`, `currencyCode`, `positiveMoney` (≤ 1e9), `nonNegativeMoney`, `num`, `str`, `date`.
"scope" below means the path-scope hook applies.

### 21.1 Auth (rate class `auth`, open at the proxy)

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/auth/dev` | Lists active seeded users | 404 if SSO configured, or production without `ALLOW_DEV_SIGNIN` |
| POST `/api/auth/dev` | `{userId}` → HMAC-signed `crosswalk_dev_user` cookie; audit DEV_SIGN_IN | same |
| DELETE `/api/auth/dev` | Clears the dev cookie | — |
| GET `/api/auth/me` | `{actor \| null, sso, ssoMode}` | — |
| GET `/api/auth/oidc/start` | `?next=` (same-origin); sealed state cookie; 302 to the IdP | oidc mode |
| GET `/api/auth/oidc/callback` | code + state → `completeSignIn`, `resolveUser`, `issueSession`; sets `crosswalk_session`; audit SSO_SIGN_IN | oidc mode |
| POST `/api/auth/oidc/logout` | Clears the session; `{ok, redirect}`; audit SSO_SIGN_OUT | oidc mode |

### 21.2 Operations and platform

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/health` | `SELECT 1` + queue health (stalled when the oldest ready job > 900 s); `ready / degraded / down`; 503 when the DB is down | open |
| GET `/api/metrics` | Prometheus text | `Bearer METRICS_TOKEN` (timing-safe) or ADMIN session |
| GET `/api/observability/export` | NDJSON `?kind=llm\|runs\|sync\|feeds\|alerts\|jobs&since=&limit=` (≤ 10,000) | ADMIN |
| GET `/api/system` | Jobs, feeds, alerts, model, openFDA, notifications, logging, tenancy, embeddings, tax status | configure_settings |
| POST `/api/system` | `{action: evaluate-alerts \| refresh-gudid \| retry-failed}` | configure_settings |
| GET `/api/feeds` | Feed statuses + last 30 runs | configure_settings |
| POST `/api/feeds` | `{feed, force}` → `requestIngest` | configure_settings |
| GET `/api/audit` | `?entityType=&entityId=`; latest 200 events, redacted; scoped roles must name an entity they can see | view_pricing |
| GET `/api/google` | Drive status, `?test=1` runs a connection test | session |
| POST `/api/webhooks/salesforce` | Raw body ≤ 256 KB (413 above), HMAC in `x-crosswalk-signature`, replay deduped | HMAC only — open at the proxy for exactly this path (fixed in the Sept 24 debug run) |

### 21.3 Settings and branding

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/settings` | Settings + `llm {available, model}`; the endpoint (`baseURL`) and per-purpose call statistics only for configure_settings | session |
| POST `/api/settings` | `{weights, maxCandidates, companyName, scopeUnassignedParent}` → `saveSettings`; audited | configure_settings |
| GET `/api/settings/branding` | Branding object | view_pricing |
| PUT `/api/settings/branding` | Full branding body; audited (logo size only) | configure_settings |

### 21.4 Accounts

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/accounts` | `?q=` name or number contains; scoped; ≤ 200 with parent, memberships, GPO, counts | view_pricing |
| POST `/api/accounts` | name, accountNumber ≤ 40, type ∈ ACCOUNT_TYPES, parentAccountId, territory, segment, region, country, currency, isStrategic, ownerUserId; audit CREATED | manage_contracts |
| GET `/api/accounts/{id}` | Account with parent, children, memberships, contracts, opportunities, proposals, requests (20), purchases (50), observations (50) | view_pricing, scope |
| POST `/api/accounts/{id}/memberships` | `{gpoName, tier?, effectiveFrom?, effectiveTo?}`; upserts the GPO, closes the open membership, opens a new one; audit MEMBERSHIP_CHANGED | manage_contracts, scope |

### 21.5 Contracts

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/contracts` | Scoped list with account, GPO, counts | view_pricing |
| POST `/api/contracts` | contractNumber ≤ 80, name, type NATIONAL/GPO/IDN/LOCAL, status, accountId / parentAccountId (LOCAL, IDN) or gpoId (GPO), tier, currency, effectiveFrom < effectiveTo, precedence 0–100, committed volume / value, renewal / priceProtection / escalation clauses (Zod), notes ≤ 4000; audited | manage_contracts |
| GET `/api/contracts/{id}` | Contract with scopes, entries (redacted), commitments, rebates, bundles, proposals, parsed clauses, performance | view_pricing, scope |
| PATCH `/api/contracts/{id}` | name, tier, notes, type, status, effectiveTo, precedence, committedValue, clauses; TERMINATED / SUPERSEDED never reactivate; ACTIVE refused on an expired term unless extended; audited | manage_contracts, scope |
| POST `/api/contracts/{id}/entries` | `{entries[≤ 5000]{sku, price > 0, currency = contract's, effectiveFrom/To, tier, minQty ≤ maxQty, volumeTierName}}`; supersedes prior ACTIVE entries for the band; `{created, superseded, unknown[]}`; refused on terminated / superseded | edit_contract_pricing, scope |
| GET `/api/contracts/{id}/performance` | `contractPerformance` | view_pricing, scope |
| POST `/api/contracts/{id}/terms` | `{kind: commitment \| rebate \| bundle \| scope, data}` (Zod per kind); audit `<KIND>_ADDED` | manage_contracts, scope |
| DELETE `/api/contracts/{id}/terms` | `{kind, termId}`; audit `<KIND>_REMOVED` | manage_contracts, scope |
| GET `/api/contracts/renewals` | `?days=` (1–3650, default 180) → `renewalPipeline` | view_pricing |

### 21.6 Cross-reference requests (heavy rate class for run / bulk / export / sheets / POST)

| Method & path | Does | Auth |
|---|---|---|
| POST `/api/intake/preview` | Form: file ≤ 20 MB, sheetUrl, csvText ≤ 5 MB, csvName → `parseIntakeAny` (lines, sheet, source, skipped, duplicatesMerged, detectedColumns); 400 `{error, hint}` on SheetAccessError | run_cross_reference |
| GET `/api/requests` | Scoped list (no `BENCH-`), line count, pricebook | run_cross_reference |
| POST `/api/requests` | Intake fields + pricebookId, accountNumber ≤ 40, accountName ≤ 200, accountType, reportType, useLlm; 1–5000 lines; existing account must be writable (403 "not in your book"); creates Request + lines, `enqueueRun`; returns `{id, reference, jobId, lines, skipped, ignored, duplicatesMerged, accounting, skippedRows}`; 503 with the id if enqueue fails | run_cross_reference |
| GET `/api/requests/{id}` | Request, lines, competitor products, candidates + own products; for roles without view_cost / view_margin every candidate loses COGS, the cost/margin fit scores, and the margin figures in `rationale` and `factorsJson.notes` (`redactCandidateForActor`); `summary`, `log`, `llmAvailable`, `google`, `modelStatus` | run_cross_reference, scope |
| DELETE `/api/requests/{id}` | 409 if proposals exist; audit DELETE | same |
| POST `/api/requests/{id}/run` | `{freshGrades?, useLlm?}` → `{ok, jobId, alreadyRunning}` | same |
| POST `/api/requests/{id}/cancel` | `cancelRun`; audit RUN_CANCEL_REQUESTED | same |
| POST `/api/requests/{id}/bulk` | `{action ∈ review_exact \| review_matched \| select_top \| flag_verify \| clear_flags \| unreview_all, lineIds? ≤ 5000}`; 409 while running; learning recorded; audit `BULK_*` | same |
| PATCH `/api/requests/{id}/lines/{lineId}` | selectedCandidateId (must belong to the line), reviewed, overrideNote ≤ 2000, customerNote ≤ 1000, flag ∈ {verify, null}, estCompetitorPrice 0–1e9; records the MatchDecision; audit LINE_ANNOTATED; returns line + `learned` | same |
| GET `/api/requests/{id}/lines/{lineId}/compare` | `?candidateId=` → attribute rows (GUDID / Bin groups, same?), similarity, candidates; margin sentences stripped without view_margin, price null without view_pricing | same |
| GET `/api/requests/{id}/export` | `?type=xref\|offer&format=xlsx\|csv\|pdf` (PDF offer only); xref hides cost / margin per permission | same |
| POST `/api/requests/{id}/sheets` | `{which?: [xref, offer], anyoneWithLink?}` → native Google Sheets; saves the URLs; 400 unconfigured, 502 upload failure | same |
| PATCH `/api/competitor/{id}` | `{di}` (validated GUDID lookup, manual resolution, confidence 1, bin + embedding hash cleared) or `{manufacturer, description}`; audit CORRECTED | manage_catalog anywhere; run_cross_reference only for a product one of the actor's visible request lines references, else 404 (`docs/DATA_ACCESS_POLICY.md`) |

### 21.7 Proposals (all `/api/proposals/{id}/**` scoped)

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/proposals` | Scoped list ≤ 200 with account, line and pending-approval counts | view_pricing |
| POST `/api/proposals` | `{requestId, accountId?, opportunityId?, objectives? ≤ 4000, validDays? 1–365}` → `createFromRequest` (account resolved or created from the request's number) | edit_proposed_pricing |
| GET `/api/proposals/{id}` | Proposal, lines (redacted: cost, floor, target price, margins), economics (margin fields nulled), never the raw `economicsJson`; `finalize`, `permissions`, `integrations` | view_pricing |
| DELETE `/api/proposals/{id}` | DRAFT only | edit_proposed_pricing |
| GET `…/audit` | ≤ 300 events (proposal, lines, approvals), redacted, actor names | view_pricing |
| GET `…/conversion` | `proposalConversion` | view_pricing |
| GET `…/drift` | `driftFor`; cost / floor nulled without view_cost | view_pricing |
| POST `…/refresh-context` | Re-snapshots a draft; `{refreshed, drift}` | edit_proposed_pricing |
| GET `…/export` | `?format=pdf\|xlsx\|csv` quote | export_proposals |
| PATCH `…/lines/{lineId}` | included, proposedPrice (null clears), reason, justification ≤ 4000, notes ≤ 4000, customerNote ≤ 1000 (editable proposals only); returns line + economics | edit_proposed_pricing |
| POST `…/lines/{lineId}/recommend` | `{strategy?, adjustmentPct?, adjustmentAmount?, justification?, apply?}` → `rerecommendLine` | edit_proposed_pricing |
| GET / PATCH / POST `…/logistics` | Read / set `{freightMode, freightValue, taxMode, taxRate, taxExemptionNo, shipTo}` / calculate tax; totals with `taxStale`, `taxNote` | view_pricing / edit_proposed_pricing |
| POST `…/submit` | `{notes?}` → `submitForApproval` | edit_proposed_pricing |
| POST `…/reopen` | `{reason?}` → `reopen` | edit_proposed_pricing |
| POST `…/version` | `newVersion` → the new proposal | edit_proposed_pricing |
| POST `…/outcome` | `{outcome WON\|LOST\|NO_DECISION, competitorName, priceReason, commercialReason, contractMonths}` → `recordOutcome` | record_outcomes |
| POST `…/push-crm` | `pushQuote` | export_proposals |
| GET / POST `…/scenarios` | List `ScenarioView[]` (economics redacted) / create `{kind ∈ RECOMMENDED, AGGRESSIVE, MARGIN_OPTIMIZED, CUSTOMER_REQUESTED, CUSTOM, FINAL (default CUSTOM), name?}` | view_pricing / edit_proposed_pricing |
| GET / PATCH / DELETE `…/scenarios/{sid}` | Read / `{lineId, proposedPrice? > 0, included?}` / delete | view_pricing / edit_proposed_pricing |
| POST `…/scenarios/{sid}/apply` | `applyScenario` | edit_proposed_pricing |

### 21.8 Approvals

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/approvals` | `queueFor(actor)`, redacted | view_pricing |
| POST `/api/approvals/{id}` | `{decision APPROVED\|REJECTED\|CHANGES_REQUESTED, comments?}` → `decide` (break-glass rules inside) | approve_discount |
| GET `/api/approvals/delegations` | `?all=1` → `{delegations, users, me, admin}` | view_pricing |
| POST `/api/approvals/delegations` | `{fromUserId?, toUserId, startsAt?, endsAt, reason?}` | approve_discount |
| DELETE `/api/approvals/delegations/{id}` | `revokeDelegation`: the delegator, the delegate or an ADMIN; anyone else → 404 | view_pricing |

### 21.9 Crosswalk governance

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/crosses` | `?status=&q=` ≤ 200 KnownCross rows (no prices in the payload); `?conflicts=open` → the Evidence-conflicts queue (`openConflicts`, parsed `conflict` record per row) | view_pricing or manage_crosswalk or review_crosswalk_clinical |
| POST `/api/crosses` | `proposeCross` (rep-proposed) | run_cross_reference |
| PATCH `/api/crosses/{id}` | approvalStatus, clinicalReviewStatus (review_crosswalk_clinical or ADMIN), marketingReviewStatus, equivalenceLevel, approvedUsage, justification, effective dates → `setReview` | manage_crosswalk |
| POST `/api/crosses/{id}/conflict` | `{decision: RETIRE \| REPLACE \| KEEP, note?}` → `decideConflict` (§28.1; audited `CONFLICT_<decision>`) | manage_crosswalk |
| GET `/api/crosswalk/versions` | Versions with entry / proposal counts, `byStatus` | view_pricing or manage_crosswalk or review_crosswalk_clinical |
| POST `/api/crosswalk/publish` | `{notes?}` → `publishVersion` | publish_crosswalk |

### 21.10 Catalog and GUDID (heavy class)

| Method & path | Does | Auth |
|---|---|---|
| POST `/api/catalog/add` | `{skus ≤ 100, category?}` → openFDA lookup under our labelers; per-SKU status added / exists / not-found / invalid; 260 ms pacing; embeddings queued | manage_catalog |
| GET / POST `/api/catalog/enrich` | In-memory (per-instance) job status / start `enrichOwnProducts {onlyMissing?}` | manage_catalog / manage_catalog |
| GET / POST `/api/catalog/gudid` | `libraryStats` / start an import `{query ≥ 3, kind OWN\|COMPETITOR, addToOwnCatalog, families, productCodes, inDistributionOnly}` | session / manage_catalog |
| POST `/api/catalog/gudid/plan` | Preview `{total, existing, requests, labelers, productCodes}` | manage_catalog |
| GET / DELETE `/api/catalog/gudid/{id}` | Job status / cancel QUEUED or RUNNING | session / manage_catalog |
| POST `/api/catalog/gudid/adopt` | `{recordKeys ≤ 500}` → `{added}`; audited | manage_catalog |
| POST `/api/catalog/gudid/prune` | `{families?, dryRun?}` → `{deleted, deactivated, kept, rebinned}` | manage_catalog |
| GET `/api/competitor-sizes/coverage` | `?limit` 1–2000 → rows + totals (codes, sized, unsized, unsized spend, covered spend %) | manage_catalog |
| GET `/api/competitor-sizes/template` | `?format=csv\|xlsx` | manage_catalog |
| POST `/api/competitor-sizes/import` | file ≤ 20 MB or sheetUrl → `{upserted, rows, skipped, rebinned}`; audited | manage_catalog |

### 21.11 Pricing, costs, purchases, policies

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/pricing/template` | Template with every SKU, `?format=` | import_cost_data |
| POST `/api/pricing/import` | file ≤ 20 MB or sheetUrl → `{updated, rows, pricebooks, unknownSkus, invalid}`; audit IMPORT_PRICING | import_cost_data |
| POST `/api/costs/import` | CSV (SKU, Cost, Currency, Plant, Region, Cost Type, Effective From/To) → `importCostsGrid` | import_cost_data |
| POST `/api/purchases/import` | CSV (Account Number, SKU, Quantity, Net Price, Currency, Invoice Date, Contract Number, Invoice Number); registers a Document | import_purchases |
| GET / POST `/api/pricing-policies` | All versions (target and minimum margins nulled without view_margin) / `draftPolicy(PolicyInput)` | view_pricing / configure_pricing_rules |
| POST `/api/pricing-policies/{id}/activate` | `activatePolicy` (supersedes the active version) | configure_pricing_rules |

### 21.12 Competitive intelligence and documents

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/intelligence` | `?sku=&accountId=` → `{summary, rows}` or `{recent, bySku, sourceTypes}`; account-scoped, market rows shared | view_pricing |
| POST `/api/intelligence` | competitorName ≤ 120, competitorSku ≤ 80, price > 0, currency, uom, accountId, gpoId, region, observedAt (≤ 1 day ahead), sourceType, sourceRef ≤ 500, rawConfidence 0–1, notes ≤ 4000 → `recordObservation` | import_competitor_pricing |
| PATCH `/api/intelligence/{id}` | `{status VERIFIED\|DISPUTED\|UNVERIFIED, notes?}` | verify_competitor_pricing |
| POST `/api/intelligence/import` | file (registered Document) or sheetUrl → `{recorded, rows, skipped}` | import_competitor_pricing |
| GET `/api/intelligence/bids` | `?q=&source=&competitorId=&sinceDays=` → awards, runs, totals, competitors, settings, sources, queue | view_pricing |
| POST `/api/intelligence/bids` | `{action: settings}` (+ configure_settings) or `{action: pull, source sam\|usaspending, lookbackDays?, force?}` → `bids.ingest` (refused when unconfigured, queue off, or pulled within the hour without force) | import_competitor_pricing |
| POST `/api/intelligence/bids/import` | file ≤ 20 MB or sheetUrl + portal → `{awards, observations, rows, skipped}` | import_competitor_pricing |
| POST `/api/documents/extract` | file ≤ 25 MB + documentType → provider or manual (csv / xlsx) → `runExtraction` | import_competitor_pricing |
| GET `/api/documents/extractions/{id}` | Extraction, fields, document (rawJson stripped) | view_pricing |
| POST `…/verify` | `{decisions[{fieldId, status VERIFIED\|CORRECTED\|REJECTED, correctedValue ≤ 2000}], finalize}` | verify_competitor_pricing |
| POST `…/import` | VERIFIED only, ≥ 1 verified line → `importObservationRows` | import_competitor_pricing |

### 21.13 Integrations

| Method & path | Does | Auth |
|---|---|---|
| GET `/api/integrations` | `{status (crm / erp / gpo, feedDir, tier2), recent 50 SyncLog, counts}` | view_pricing |
| POST `/api/integrations/sync` | `{system crm\|erp\|gpo}` → feed ingest, polls ≤ 20 s | manage_contracts |
| GET `/api/integrations/config` | Summaries | configure_settings |
| GET / PUT `/api/integrations/config/{key}` | Definition + config (secrets present / absent) + jobs + open reviews / `{provider, enabled, config, secrets, mapping, scheduleCron}` → `{status, configVersion, errors, detail}` | configure_settings |
| GET `…/{key}/jobs` | `?limit=50` | configure_settings |
| POST `…/{key}/test` | `testConnection` → `{ok, message, details?, category?}` | configure_settings |
| POST `…/{key}/validate-mapping` | `{live?}` → `{entities, live, ok}` | configure_settings |
| POST `…/{key}/sync` | `{syncType, mode test\|queue\|inline, full}` | configure_settings |
| POST `…/{key}/upload` | file ≤ 25 MB + syncType → `runSync` | configure_settings |
| GET `/api/integrations/jobs/{id}` | `jobDetail` with row errors | configure_settings |
| GET `/api/integrations/review` | `?key=&kind=&status=` | view_pricing |
| POST `/api/integrations/review/{id}` | `{type link\|supersede\|accept\|dismiss, accountId?, corrections?}`; permission by item: `gpo:*` manage_contracts, competitor-contracts import_competitor_pricing, documents verify_competitor_pricing, else configure_settings | dynamic |

### 21.14 Notifications and analytics

| Method & path | Does | Auth |
|---|---|---|
| GET / POST `/api/notifications` | `?unread=1&take=` → `{items, unread}` / `{all: true}` or `{ids ≤ 500}` → `{marked}` (own rows) | session |
| GET / PATCH `/api/notifications/preferences` | `{kinds, channels, preferences}` / `{kind ("*" or KIND), inApp?, email?, teams?}` | session |
| GET `/api/analytics/{report}` | `?fresh=1` (≤ once a minute); data redacted + `_meta {asOf, ageMs, stale, source, durationMs, staleAfterMs}` | view_analytics |
| POST `/api/analytics/{report\|all}` | Queued or inline refresh (throttled) | view_analytics |

## 22. Scripts

### 22.1 `package.json` scripts (29 on `main`)

| Script | Runs | Use |
|---|---|---|
| `dev` / `build` / `start` | `next dev` / `next build` / `next start` | Development server on :3000; production build; serve it |
| `setup` | `npm install && prisma generate && prisma migrate deploy && tsx prisma/seed.ts && tsx prisma/seed-enterprise.ts` | First-time setup |
| `postinstall` | `prisma generate` | Automatic after install |
| `db:migrate` / `db:reset` / `db:studio` | `prisma migrate dev` / `prisma migrate reset --force` / `prisma studio` | Development migrations; wipe and re-migrate (runs the seed hook); browse |
| `db:seed` / `db:seed:enterprise` | `tsx prisma/seed.ts` (`-- --gudid` to enrich) / `tsx prisma/seed-enterprise.ts` | Curated sheets and catalog; users, policies, demo commercial data |
| `db:migrate:http` | `tsx scripts/migrate-http.ts` | Apply migrations over Neon HTTP when TCP is blocked |
| `db:preflight` | `tsx scripts/db-preflight.ts` | Rows that would violate the CHECK constraints (exit 1 if any); the container entrypoint runs it |
| `typecheck` | `tsc --noEmit` | CI |
| `check` / `check:enterprise` | `tsx scripts/check.ts` (19) / `tsx scripts/check-enterprise.ts` (21) | Pure regression checks, CI |
| `test` / `test:watch` | `vitest run` / `vitest` | Full suite (§23) |
| `test:enterprise` | `tsx scripts/test-enterprise.ts` | 18-step end-to-end commercial workflow against the DB (needs openFDA) |
| `test:adversarial` | `tsx scripts/test-adversarial.ts` | 24 reliability steps against the DB, CI |
| `eval` | `tsx scripts/eval.ts` | Matcher top-1 / top-3 against curated crosses |
| `eval:model` / `eval:gate` | `tsx scripts/model-eval.ts [--gate]` | Model grading agreement; CI gate on prompt / bin / model version |
| `benchmark` | `tsx scripts/benchmark.ts` | Accuracy across cases in `data/benchmark/` |
| `profile:run` | `tsx scripts/profile-run.ts` | Per-stage timings and query counts for one run |
| `embed` | `tsx scripts/embed.ts` | pgvector embeddings for the catalog |
| `catalog:hygiene` | `tsx scripts/catalog-hygiene.ts` | Deactivate placeholder SKUs and crosses (`-- --apply`) |
| `worker` | `tsx scripts/worker.ts` | Dedicated pg-boss worker (`JOBS_WORKER=external`) |
| `secrets:check` | `tsx scripts/with-secrets.ts --check` | Production secret and configuration checks |
| `retention` | `tsx scripts/retention.ts` | Manual retention sweep (`-- --dry-run`) |

`mac-demo` adds `mac:setup`, `mac:start`, `mac:stop`, `mac:reset`, `mac:doctor`, `db:seed:demo` and
`engines.node >=20.9 <25`.

### 22.2 `scripts/*.ts` (20 files + `scripts/lib/harness.ts`)

| Script | Usage | Purpose |
|---|---|---|
| `benchmark.ts` | `[--dir data/benchmark] [--case n]… [--from-requests] [--llm] [--keep] [--label] [--out docs/benchmarks]` | Runs benchmark cases through the real pipeline; writes a `BenchmarkRun` row and optionally a markdown report |
| `catalog-hygiene.ts` | `[--apply]` | Reports or fixes placeholder own SKUs / crosses (deactivate) and deletes E2E fixtures |
| `check.ts` | `npm run check` | 19 pure matcher checks: CFN normalisation, variants, binning, similarity, CSV |
| `check-enterprise.ts` | `npm run check:enterprise` | 21 pure commercial checks: money, waterfall, cost, rebates, bundles, price decay, recommendation, authority, approval rules, RBAC |
| `db-preflight.ts` | `npm run db:preflight` | Counts constraint-violating rows before migrating |
| `embed.ts` | `[--own \| --competitor]` | Refreshes embeddings (needs `OPENAI_API_KEY` and pgvector) |
| `eval.ts` | `[--n 80] [--seed 7] [--family X] [--no-crosses]` | Top-1 / top-3 accuracy against curated crosses; own bins built with SKU + manufacturer so the access profile applies |
| `eval-pacr.ts` | `run <PACR.xlsx> --label x [--llm] [--fresh] [--rebin] [--out] [--json]` · `report <json> [--before <json>]` · `fixture <json> [--codes]` | REQ-7628 PACR-vs-Crosswalk evaluation; raw per-line records and derived metrics in `docs/eval/`; `fixture` writes the offline regression fixture |
| `gen-constraints.ts` | `[dir]` | Regenerates the Tier 0 and Tier 2 CHECK-constraint migrations from `src/lib/db/constraints.ts` |
| `migrate-http.ts` | `DATABASE_URL=… [--dry-run]` | Applies migrations over the Neon HTTP driver and records them in `_prisma_migrations` |
| `model-eval.ts` | `[--accept] [--gate [--db]] [--n 40 --seed 7 --family --fresh --notes]` | Model grading evaluation and the baseline gate (`data/eval/model-baseline.json`) |
| `profile-run.ts` | `npm run profile:run -- <intake> [label]` | Stage timings, Prisma query counts, slow statements |
| `record-openfda.ts` | — | Re-records `tests/recorded/openfda/*` (API key stripped) |
| `retention.ts` | `[--dry-run \| --force]` | Manual retention sweep |
| `run-sample.ts` | `[intake.xlsx] [--account … --name …]` | Headless run; both exports to `./out`; defaults to the MSK sample |
| `seed-sanford-benchmark.ts` | `<SSXrefReport_REQ-7628.xlsx> [--clean]` | Sanford account, Vizient T1 membership, LOCAL / GPO / list contracts from the 54 PACR-stated prices (source `benchmark:REQ-7628`) |
| `test-adversarial.ts` | `npm run test:adversarial` | 24 DB steps: sessions, money, stale approvals, concurrency, authorization, CSV injection, redaction |
| `test-enterprise.ts` | `npm run test:enterprise` | 18-step MSK deal: import → cross-reference → proposal → approvals → export → CRM → won → contract → compliance; cleans up after itself |
| `with-secrets.ts` | `[--check] -- <cmd>` | Loads secrets from `SECRETS_PROVIDER`, optionally checks them, runs the command, forwards signals |
| `worker.ts` | `npm run worker` | Dedicated pg-boss worker: loads and checks secrets, starts the workers |
| `lib/harness.ts` | library | `test()` / `report()` that self-run or register with Vitest via `__vitest_harness` |

### 22.3 `scripts/mac/*.sh` (`mac-demo` only; Bash 3.2 / BSD-safe)

`lib.sh` (helpers: `say/ok/warn/die`, `env_get`, `db_mode` docker / brew / external, `node_ok` ≥ 20.9,
`db_up`, `wait_for_db`), `setup.sh` (`[--docker | --brew | --external URL]`: writes `.env` from
`.env.mac.example` with a random `SESSION_SECRET`, never overwrites; starts Postgres; `npm ci`, migrate,
generate, three seeds), `start.sh` (database then `next dev`, next free port), `stop.sh` (data kept),
`reset.sh` (localhost only: `migrate reset --force` + enterprise + demo seeds), `doctor.sh` (read-only
diagnosis).

## 23. Tests and evaluation harnesses

### 23.1 Vitest (`npm test`; 45 files, 714 cases after the Sept 25 decisions work — 43 / 698 after the Sept 24 debug run, 13 files / 299 before it)

`vitest.config.mts`: `tests/**/*.test.ts`, setup `tests/setup.ts` (dotenv, `globalThis.__vitest_harness`
so `scripts/check*.ts` register their cases, `setActorForTests`), 120 s timeouts, `fileParallelism:
false`, `LOG_SILENT=true`, `JOBS_WORKER=off`, `NOTIFY_DRY_RUN=true`, alias `@` → `src`. Database suites
wrap themselves in `describe.skipIf(!process.env.DATABASE_URL)` and expect the demo seed.

| File | Covers | Cases | DB |
|---|---|---|---|
| `unit/cfn-placeholders` | `isPlaceholderSku`, `isTestFixture` | 3 | no |
| `unit/pure-checks` | imports `scripts/check.ts` | 19 | no |
| `unit/enterprise-checks` | imports `scripts/check-enterprise.ts` | 21 | no |
| `unit/match-quality` | size-parser matrix, brand registry, component classification, hard and soft constraints, score vs confidence vs classification, SELF_MATCH, intake accounting | 72 | no |
| `unit/pacr-regression` | the 20 REQ-7628 PACR-win cases and adversarial matches from `tests/fixtures/trocar-benchmark.json` | 31 | no |
| `unit/openfda-replay` | resolver against `tests/recorded/openfda/` (unrecorded URL fails) | 1 | yes |
| `unit/tier0-units` | OIDC client against an in-memory IdP (RS256, PKCE, nonce, issuer, audience), secrets, rate limiting, CSP | 32 | no |
| `unit/tier1-units` | log redaction, request context, Tier 1 pure modules | 11 | no |
| `unit/tier2-units` | mapping engine, error classification / redaction, sealed secrets, webhook verification, field validator, registry, provider adapters with injected fetch | 33 | no |
| `db/tier0` | ownership and territory scoping, OIDC subject → user, break-glass audit, retention sweep (loopback DB only) | 19 | yes |
| `db/tier1` | run recovery after restart, rate-limited import, stale GUDID, learning loop, feeds, drift, notifications | 24 | yes |
| `db/tier2` | integration config + sealed secrets, admin route auth, Salesforce, SAP, GPO reconciliation, extraction → review → verify, FX, contract-price ingestion (mock providers) | 16 | yes |
| `db/tier3` | embedding shortlist and fallback, analytics snapshots, delegation, tax outside margin, public awards, bulk actions, branded PDF | 17 | yes, pgvector |

Recorded fixtures: `tests/recorded/openfda-scenario.ts` (codes `1DLMC05`, `SPMII`, `1190500`,
`PPM1510X3`, `1410015010`, `112660`; strict pass then list-context pass), `tests/recorded/openfda/`
(11 files: `index.json`, `expected.json`, 9 responses), `tests/fixtures/trocar-benchmark.json` (141 KB
offline catalog + competitors + crosses).

### 23.2 Database-backed tsx suites outside Vitest

`npm run test:adversarial` (24) and `npm run test:enterprise` (18) — see §22. Both pass but the process
does not exit on its own (pre-existing, documented in the Tier 0 report); run with `JOBS_WORKER=off`.

### 23.3 Evaluation harnesses

| Harness | Measures | Baseline / artefacts |
|---|---|---|
| `npm run eval -- --n 80 --seed 7 --no-crosses` | attribute-only top-1 / top-3 against curated crosses | all 42/68 of 120; stapling 9/25; lap 30/34; trocar 30/38 (heuristic, Sept 24) |
| `npm run eval:model` / `eval:gate` | model grading agreement; gate on prompt / bin / model version | `data/eval/model-baseline.json`: gpt-6-astra, prompt v3, bins v6, 27/40 top-1 (accepted Sept 17). Model-name mismatch is a warning without a key, a failure with one |
| `scripts/eval-pacr.ts` | PACR vs Crosswalk on REQ-7628 (proposals, diameter / component mismatches, PACR-win cases, pricing, own-SKU, curated top-1, flags) | `docs/eval/baseline.*`, `docs/eval/after.*`; report `docs/REQ-7628_Crosswalk_superiority_run.md` |
| `npm run benchmark` | accuracy across historical lists in `data/benchmark/` (gitignored) | `BenchmarkRun` rows; `--from-requests` builds cases from reviewed requests |
| `npm run profile:run` | throughput | 30 lines 1.4 s / 138 statements; 300 lines 4.6 s / 1,998 statements (Sept 23) |

### 23.4 CI (`.github/workflows/ci.yml`)

Job **check** (Postgres `pgvector/pgvector:pg17` service; `DATABASE_ADAPTER=pg`, `COMPANY_NAME=Medtronic`):
checkout → Node 22 → `npm ci` → `prisma migrate deploy` → `typecheck` → `check` → `check:enterprise` →
`build` → seeds without reference data → `test:adversarial` (`SESSION_SECRET=ci-only-secret`) → `npm test`
→ `eval:gate`. Job **image** (needs check): Buildx build `crosswalk:ci` → boot test on a `cw` network
with a pgvector DB and `JOBS_WORKER=external` → poll `/api/health` (60 × 2 s) → assert a CSP header on `/`
→ run the `check` role with a strong secret → assert the `check` role fails with `SESSION_SECRET=short`.

## 24. Documentation index

| Document | Read it for |
|---|---|
| `BUILD_NOTES.md` | this document — the whole application |
| `PRODUCTION_READINESS.md` | where new team members start: the gap from prototype to production |
| `ARCHITECTURE.md` | matching-engine architecture and the decisions behind it |
| `MATCH_QUALITY_MODEL.md` | substitution decisions, confidence and classification (REQ-7628) |
| `AI_BOUNDARY.md` | the model boundary: the model layer never reaches the database; the application reads, prompts, validates and writes |
| `ENTERPRISE_ARCHITECTURE.md` | deal-desk platform plan and implementation record (ER diagram, phases, decisions, risks) |
| `BUSINESS_RULES.md` | every commercial rule → implementing file → test |
| `FEATURES.md` | feature inventory and roadmap (v0.7) |
| `DEPLOYMENT.md` | container image, worker, pgvector Postgres, IdP, secrets |
| `OPERATIONS.md` | jobs, monitoring, alerts, runbooks, engine throughput |
| `BACKUPS.md` | backup, recovery and retention runbook |
| `DATA_ACCESS_POLICY.md` | what is held, who sees it, protection, retention — for legal sign-off |
| `INTEGRATIONS.md` | systems of record, adapter boundaries, credentials still needed, how to connect |
| `INTEGRATION_ARCHITECTURE.md` | the vendor-neutral integration layer design |
| `INTEGRATION_SETUP.md` | admin guide for Settings → Integrations and the company checklist |
| `FULL_APPLICATION_DEBUG_REPORT.md` | the Sept 15 full debug run (38 bugs) |
| `TIER0_DEBUG_REPORT.md` / `TIER1_DEBUG_REPORT.md` / `TIER3_DEBUG_REPORT.md` | tier-scoped bug hunts |
| `REQ-0013_vs_PACR_comparison.md` | MSK list scorecard against PACR |
| `REQ-7628_PACR_vs_Crosswalk_comparison.md` | Sanford trocar list before the match-quality work |
| `REQ-7628_Crosswalk_superiority_run.md` | Sanford trocar list after it, with method and metrics |
| `eval/` | raw and rendered `eval-pacr` output (baseline, after) |
| `crosswalk-build-notes.md` | local, gitignored session notes |

Root: `README.md`, `README-MAC.md` (mac-demo), `CONTRIBUTING.md`, `AGENTS.md` (Next.js 16 notice),
`.env.example`, `.env.mac.example` (mac-demo), `Dockerfile`, `deploy/{entrypoint.sh,docker-compose.yml}`,
`docker-compose.yml` (mac-demo).

## 25. Decisions log

Decisions taken with Dev (Alex), in order. Ones marked *FDE* were taken at the builder's discretion
and reported afterwards.

| When | Decision | Why / consequence |
|---|---|---|
| Sept 13 | Next.js web app on localhost, not Electron or a CLI | one codebase for the UI, the API and the worker |
| Sept 13 | OpenAI Responses API with the model ID from `.env`; deterministic heuristic fallback | the app must run and be demonstrable with no key |
| Sept 13 | Competitor CFN lookup via openFDA Device UDI (a searchable GUDID mirror) first, LLM hints as fallback | AccessGUDID's own API only supports DI lookup |
| Sept 13 | Own catalog = the 313 SKUs from `Endomechanical.xlsx` (+ 8 hernia SKUs from the legacy report), enriched from openFDA; grown via Catalog → Add SKUs and GUDID imports | reference sheets stay out of git; seed tolerates their absence |
| Sept 13 | Pricing optional (List, COGS, pricebooks); ranking weights renormalise over the factors present | a run never blocks on missing prices |
| Sept 14 | Google Sheets first-class: link reads with no credentials, service-account Drive write-back when configured; .xlsx/.csv kept alongside | reps live in Sheets |
| Sept 14 | Sibling lines graded in one model call with a consistency rule and a deterministic floor; verdicts cached in `LlmGrade` by input hash; "Re-grade fresh" bypasses | re-runs must not flip lines |
| Sept 14 | Rename CRACR → Crosswalk | CRACR read too close to PACR |
| Sept 14 | Git history handed over as bundles; Alex owns the GitHub push | the bridge shell has no credentials; CI workflow files cannot be written over the bridge |
| Sept 14 | Enterprise v0.4: dev sign-in + an SSO adapter contract; Neon Postgres provisioned now; all ten phases built coherently and tested | one platform, not a chain of prototypes |
| Sept 14 | Money is `Decimal(18,4)` in Postgres and decimal.js in code (`src/lib/money.ts` is the only arithmetic point) | no float money anywhere |
| Sept 15 | GUDID library: whole-labeler imports, library-first resolution, `manage_catalog` permission | faster, offline-capable resolution |
| Sept 15 | BIN_VERSION 6: FDA review-panel and non-surgical keyword exclusions; "Other" family never adopted; imported SKUs lose ties and carry a note; prune tool | a whole-Medtronic import (88k records) had polluted ranking |
| Sept 15 | Recommendation: import **Covidien** (the surgical labeler) for own products, not "Medtronic" | labeler scope matches the product families |
| Sept 15 | Debug-run safety rules: no destructive testing against real data, no real external actions, no secrets in reports, never weaken validation | run against a Neon branch, then apply migrations to dev |
| Sept 17 (*FDE*) | pg-boss in the app database (schema `pgboss`), workers inline in the Next server by default, `JOBS_WORKER=external` + `npm run worker` to split | no extra infrastructure for a pilot |
| Sept 17 (*FDE*) | Vitest as the runner; check scripts register as Vitest tests through `__vitest_harness` | one `npm test` |
| Sept 17 (*FDE*) | Email (SMTP) + Teams webhook + in-app notifications with per-kind switches | no vendor lock-in |
| Sept 17 (*FDE*) | Structured JSON logs + `/api/health` + `/api/metrics` + NDJSON export instead of an OTel dependency | scrapeable by anything |
| Sept 17 | Rep overrides become DRAFT rep crosses used only as a soft prior (`REP_PRIOR_BOOST`), never a tier | the learning loop cannot promote a guess |
| Sept 17 | Model-eval baseline accepted at gpt-6-astra / prompt v3 / bins v6 after placeholder hygiene | 68 % top-1, 2 false No Match; the CI gate warns on a model mismatch when no key is set |
| Sept 18 | Single-tenant per deployment (`src/lib/tenancy.ts`) | one company per database; seeds never create a second |
| Sept 18 | Live tax service = AvaTax, with MANUAL / EXEMPT / NONE fallbacks; tax and freight never enter margin | quote-level totals only |
| Sept 18 | Public bids from SAM.gov + USAspending + bid-file import | verified live with 1,000 awards |
| Sept 18 | pgvector + `text-embedding-3-small` for retrieval, scan fallback when unavailable | shortlist quality without a hard dependency |
| Sept 18 | `mac-demo` branch = `v0.6.0` + tooling only; `main` never carries Mac files | collaborators on Macs could not run the build |
| Sept 19 | Built-in OIDC client (auth-code + PKCE, roles from a claim, own signed session); `SSO_MODE=proxy` keeps the header contract | works with Entra / Okta without a proxy |
| Sept 19 | Ownership + territory scoping for SALES_REP / REGIONAL_MANAGER only; everyone else sees everything; unassigned accounts visible to all | matches how the deal desk works |
| Sept 19 | Rotate the Neon password now; `staging` and `ci` branches; pluggable secret loader (`env \| aws \| vault \| doppler \| file`) | the dev URL had been shared |
| Sept 19 | Audited break-glass: ADMIN self-approval needs a reason, is flagged, and notifies other ADMINs / PRICING_DIRECTORs | no silent self-approval |
| Sept 19 | CHECK constraints generated from code (`src/lib/db/constraints.ts`), NOT VALID + VALIDATE, with a preflight | the schema comments had been stale |
| Sept 19 | Retention off until `RETENTION_ENABLED=true`; requests only with an explicit `RETENTION_REQUESTS_DAYS`; audit never swept | the data policy needs sign-off first |
| Sept 23 | Integration layer: external → adapter → mapping → canonical record → domain writers; secrets sealed with AES-256-GCM; mocks refused in production unless `INTEGRATIONS_ALLOW_MOCK` | a new company supplies only credentials, URLs, mappings and a switch |
| Sept 23 | FX: a stored historical rate is never overwritten; restatements are logged | reproducible economics |
| Sept 23 | Engine speed-ups with zero output change (throttled progress, prefetch, chunked persist, parallel variants, openFDA memo) | verified identical outputs before and after |
| Sept 23 | Prisma CLI uses Neon's direct host, never the pooler | `migrate deploy` had hung on an advisory lock held by a pooled backend |
| Sept 24 | Match quality: coverage never gained by guessing; Exact must not get easier; curated data is evidence, not immutable, and never rewritten; no Sanford-specific hard-coding; baseline reproduced first | the PACR superiority run is measured, not asserted |
| Sept 24 | Score, confidence and classification are separate quantities; the cap binds the LLM grader; curated rows contradicted by evidence are labelled and demoted, not deleted | reviewers see why, and the sheet owner decides |
| Sept 24 | Runs price through the contract waterfall when the request names a known account; `priceSource` per candidate | PACR priced 101 lines under Sanford contracts where Crosswalk had priced 18 at list |
| Sept 25 | Owner decisions become product mechanisms: sibling-family evidence from the labeler's catalog (`gudid:siblings`), the Evidence-conflicts queue with Retire / Replace / Keep on the `KnownCross`, and a per-company setting for children of unassigned accounts (§28.1) | Crosswalk is deployed at many companies; nobody there owns a spreadsheet of corrections |
| Sept 26 | Model boundary: `src/lib/llm/` holds only provider calls and prompts (no database import, directly or transitively); the application reaches it only through `src/lib/ai/gateway.ts`, which records calls; the application validates answers against the hard constraints and writes every result (`AI_BOUNDARY.md`, enforced by `tests/unit/llm-boundary.test.ts`) | the model must only ever see what the application hands it and only ever hand results back to the application |

Standing constraints: never sync `.env` between machines; destructive Neon operations only when asked;
no secrets in docs, logs or reports; DB tests run against local Postgres, never Neon; reference
spreadsheets, `.env`, service-account JSON and bundles stay out of git.

## 26. Known issues, inconsistencies and gaps

### 26.1 Bugs found while writing this document — all fixed in the Sept 24 debug run (see §28)

| # | Where | Problem | Effect |
|---|---|---|---|
| 1 | `src/proxy.ts` `OPEN` list vs `src/app/api/webhooks/salesforce/route.ts` | The webhook is documented as HMAC-only, but the proxy gate only opens `/api/auth/`, `/api/health` and `/api/metrics` | Salesforce calls (no cookie, no `x-sso-subject`) get 401 before the handler runs; no test covers the path |
| 2 | `/crosses` governance panel | The review queue loads from `GET /api/crosses` and `GET /api/crosswalk/versions`, both `view_pricing`; CLINICAL_REVIEWER holds only `manage_crosswalk` + `review_crosswalk_clinical` | clinical reviewers see "Nothing awaiting review" |
| 3 | `src/app/contracts/tools.tsx` | `gpoId` is always null, the `gpoName` input is never rendered, and there is a dead `fetch("/api/intelligence")` | GPO contracts cannot be created from the UI ("a GPO contract needs a gpoId") |
| 4 | `/catalog` (server render) | List and pricebook prices are rendered with no `view_pricing` check (COGS is gated by `view_cost`) | a CLINICAL_REVIEWER sees list prices; other server-rendered pages (`/crosses`, `/catalog/gudid`, `/requests/new` pricebook names, `/settings` model stats) also have no page-level check although their APIs do |
| 5 | `src/app/settings/integrations.tsx` | Links to `/docs/INTEGRATIONS.md`, which is not a route and not in `public/` | 404 |
| 6 | `src/lib/pipeline/run.ts` `enqueueRun` | Always writes `optionsJson` without weights, so a run uses `DEFAULT_WEIGHTS` | the weight sliders saved on Settings never reach a queued run |
| 7 | `GET /api/catalog/enrich` | No `handle()` / `authorize()`; only the proxy session check; job state is a per-instance module variable | any signed-in user reads enrich progress; wrong on a multi-instance deploy |
| 8 | `PATCH /api/competitor/{id}` | No ownership scope on the shared competitor-product cache | any `run_cross_reference` user can correct a record other users' requests read |
| 9 | UI | Buttons shown regardless of permission and rejected by the API: New contract, Terminate / Activate, Verify / Dispute, New draft (policies), approval buttons | 403 toasts instead of hidden controls |
| 10 | `src/components/sidebar.tsx` | `section` headings declared but never rendered | cosmetic |

### 26.2 Code inconsistencies

- `"US Downsell Match"` ranks 2nd in `score.ts` `MATCH_ORDER` but 3rd in `line.ts` `GRADE_ORDER`.
- Scenario kinds: `createScenario` accepts four kinds; the CHECK constraint also allows
  `CUSTOMER_REQUESTED` and `FINAL` (the UI offers CUSTOMER_REQUESTED).
- FX look-back defaults disagree: the service uses 5 days, the registry field default 3.
- `cfnVariants()` in `src/lib/cfn.ts` is dead code.
- Legacy `src/lib/integrations/salesforce.ts` and `sap.ts` skeletons still throw `NotConfigured`; the
  Tier 2 providers supersede them but the files remain.
- Single-tenant defaults are Medtronic / labelers Covidien, Medtronic, Sofradim (`COMPANY_NAME`,
  `OWN_LABELERS`); a new company must set both.
- Per-instance state: rate limiting, the enrich job, the openFDA memo and token bucket are all
  process-local (documented in the Tier 0 report; fine for one web instance plus one worker).
- Contract entries are not written in one transaction (pre-existing, documented).
- `test:enterprise` / `test:adversarial` do not exit on their own after passing (pre-existing).

### 26.3 Repository inconsistencies (all resolved in the Sept 24 debug run: version 0.7.0, schema comments, CONTRIBUTING, `.env.example`; mac-demo tooling stays branch-specific by design)

- `package.json` version `0.4.0`; `FEATURES.md` says v0.7; the only tag is `v0.6.0`.
- CHECK constraints allow more values than the schema comments list: Account `type` adds BILL_TO and
  GPO_MEMBER; Request `status` adds `cancelled`; IntegrationReviewItem `kind` adds OVERLAP;
  CompetitorPriceObservation `sourceType` adds PUBLIC_BID_DB; ProposalLine `contractPriceSource` adds
  NATIONAL. The constraints are right; the comments are stale.
- `CONTRIBUTING.md` describes CI without `test:adversarial`, `npm test`, `eval:gate` and the image job.
- `.env.example` omits `DATABASE_POOL_MAX`, `PREFLIGHT_ON_START`, `MIGRATE_ON_START`,
  `POSTGRES_PASSWORD`, `WEB_PORT`, `PRISMA_LOG`, `LOG_SILENT` (all documented in §5).
- Mac tooling exists only on `mac-demo` (15 commits ahead of `main`).
- `docs/crosswalk-build-notes.md` is gitignored; this file replaces it as the tracked record.

### 26.4 Data and evaluation caveats

- The local eval database differs from Neon (3,652 curated rows including the Access-PACR sheets), so
  Neon numbers will differ from `docs/REQ-7628_Crosswalk_superiority_run.md`.
- 11 curated rows were classified stale or inconsistent and 3 ambiguous (report §8); they should be
  retired or corrected by the sheet owner.
- Ethicon Xcel / BASX and Applied Kii codes carry no sizes in GUDID; the competitor-sizes import closes
  the gap once marketing supplies the table.
- Dev DB still holds the W. L. Gore catalog and ~1,113 imported Medtronic SKUs (Sofamor Danek
  retractors under the General Surgery panel remain; prunable by family).
- Model-eval baseline is at gpt-6-astra while the code default is `gpt-5.6-astra`; the gate warns.
- Tier agreement in model grading is prompt calibration work (platform-variant prefixes read as
  construction changes).
- A "current platform" flag (VersaOne vs Versaport Plus ties) and stapler-reload profiles are the next
  matcher extensions.

### 26.5 Left to the company (cannot be built here)

| Item | Where it plugs in |
|---|---|
| Register the app with the IdP (Entra / Okta) and set `SSO_MODE=oidc`, `SSO_*`; then disable dev sign-in | §5, `docs/DEPLOYMENT.md` |
| Production secrets via `SECRETS_PROVIDER`; `SESSION_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`, `METRICS_TOKEN` | `src/lib/secrets.ts` |
| Salesforce, SAP OData, GPO roster, OCR, FX and contract-price credentials, URLs, mappings, data owners | checklist at the end of `docs/INTEGRATION_SETUP.md` |
| A webhook relay on the Salesforce side (and fix §26.1 #1) | `/api/webhooks/salesforce` |
| Real target and minimum margins per family (policies are seeded with placeholders) | `/settings/pricing` |
| Sign the data-access policy, raise Neon history retention, schedule dumps, then set `RETENTION_ENABLED` | `docs/DATA_ACCESS_POLICY.md`, `docs/BACKUPS.md` |
| AvaTax and SAM.gov credentials | `TAX_*`, `SAM_API_KEY` |
| SMTP / Teams for external notification delivery | `SMTP_*`, `TEAMS_WEBHOOK_URL` |
| Model key, then `npm run embed`, `npm run eval:model -- --accept`, `eval-pacr --llm` | `OPENAI_API_KEY` |
| Competitor sizes table; historical lists in `data/benchmark/` | Catalog → Competitor sizes; `npm run benchmark` |
| Branding (logo, address, terms) | Settings → Branding |
| Apply pending migrations on Neon and push to GitHub | §27.2 |

## 27. Operator checklists

### 27.1 New developer

1. Clone; Node 22 (`.nvmrc` on `mac-demo`); Postgres 17 with pgvector (Docker `pgvector/pgvector:pg17`
   or Neon).
2. `cp .env.example .env`; set `DATABASE_URL`, `DATABASE_ADAPTER=pg`, `SESSION_SECRET` (≥ 32 chars),
   `ALLOW_DEV_SIGNIN=true`, `COMPANY_NAME`, optionally `OPENAI_API_KEY` + `LLM_MODEL`.
3. `npm run setup` (install, generate, migrate, seed curated + enterprise). Put the reference sheets in
   `data/reference/` first if you have them; the seed tolerates their absence.
4. `npm run dev`; pick a user in the sidebar (`alex.rep`, `maria.manager`, `sam.contracting`,
   `priya.analyst`, `dana.director`, `committee`, `lee.marketing`, `dr.clinical`, `finance`, `admin`,
   `exec` @crosswalk.dev).
5. Before a PR: `npm run typecheck && npm run check && npm run check:enterprise && npm test` (DB
   suites need `DATABASE_URL`; never point them at Neon).
6. On a Mac with no Postgres: `git checkout mac-demo; npm run mac:setup -- --docker; npm run mac:start`.

### 27.2 After pulling a build from Alex's workflow (bundle → checkout)

1. `git status` — confirm no modified tracked files you meant to keep.
2. `git fetch .claude-bundles/<bundle> main:refs/bundles/main mac-demo:refs/bundles/mac-demo;
   git reset --hard refs/bundles/main; git branch -f mac-demo refs/bundles/mac-demo`.
3. `npm install` (when `package.json` changed) → `npm run db:preflight` → `npx prisma migrate deploy`
   → `npx prisma generate`. Restart `next dev` if it was running (`npm run dev:clean` after a
   branch change — §27.5, stale route tree).
4. `git push origin main mac-demo` (and any tag). CI runs the check and image jobs.
5. Currently pending on Neon: `20260924000000_match_quality` (additive). Pending push: `main`
   `1b43393`+, `mac-demo` `21344fc`+.

### 27.3 Running a cross-reference for a customer

1. Catalog readiness (Overview card): own SKUs present and priced, competitor sizes imported for the
   competitor's families, curated crosses seeded, model key set if grading is wanted.
2. Accounts → make sure the account exists with its GPO membership and contracts (or import them via
   Settings → Integrations); a run only prices through the waterfall when the request names a known
   account.
3. Cross-reference → New request → paste / upload / link → check the preview accounting (data rows,
   lines, merged, skipped with reasons, ignored summary rows) → choose the pricebook → Continue.
4. On the request page: work the "Needs attention" and "Flagged" filters first (confidence < 0.75),
   use Side-by-side and the evidence list, select alternatives, add notes; Bulk actions for the rest.
5. Download the rep workbook or write to Google Sheets; Create proposal.
6. Proposal: pick a scenario, set logistics, exclude unpriced identity lines, Submit; Deal desk
   approves; export the quote PDF / xlsx; Push to CRM; Record outcome (WON creates the LOCAL contract).

### 27.4 Production deploy

1. `npm run secrets:check` with production env; `SSO_MODE=oidc`, `ALLOW_DEV_SIGNIN` unset,
   `NODE_ENV=production`, `TRUST_PROXY_HOPS` set behind a load balancer, `METRICS_TOKEN`,
   `INTEGRATIONS_ENCRYPTION_KEY`, `RETENTION_*` per policy.
2. Build the image (`Dockerfile`); run `deploy/docker-compose.yml` or equivalent: one `web` (Next),
   one `worker` (`JOBS_WORKER=external`, `npm run worker`), pgvector Postgres or Neon. The `web` role
   of `deploy/entrypoint.sh` runs the preflight and `migrate deploy` on start unless
   `PREFLIGHT_ON_START=false` / `MIGRATE_ON_START=false`; the `migrate` and `check` roles run those
   steps alone.
3. Verify `/api/health` → `ready`, `/api/metrics` with the token, a CSP header on `/`, Settings →
   System shows queues on and feeds scheduled.
4. Register the IdP, sign in as an admin, set Branding, Integrations, Pricing policies.
5. Alerts: scrape `/api/metrics`; Teams / SMTP for `ALERT`, `JOB_FAILED`, `FEED_FAILED`, `BREAK_GLASS`.

### 27.5 When something goes wrong

| Symptom | Look at |
|---|---|
| Run stuck in queued / running | Settings → System (queue depth, oldest ready, failed jobs → Retry); `/api/health` degraded when the oldest ready job > 900 s; worker logs by `requestId` |
| Codes not resolving | GUDID library coverage for the labeler (import it); openFDA 429 pause in the System card; `OPENFDA_API_KEY` |
| Wrong match | request line → evidence list (✗ hard, ≠ soft, = agree), Side-by-side, `docs/MATCH_QUALITY_MODEL.md`; correct the competitor record (DI) and re-run; propose a cross |
| Prices missing on a run | request must name a known account with ACTIVE contracts / GPO membership; `priceSource` and the unpriced reason on the candidate |
| Approval stuck | Deal desk → who it "needs"; delegations; stale requests are withdrawn when a price changes — resubmit |
| Export disabled | `finalize.ok` reasons on the proposal (pending approvals, unpriced lines, stale tax) |
| Integration sync failing | Settings → Integrations → Test, Validate against provider, job detail with row errors, review queue |
| Migration hangs on Neon | use the direct host (`DIRECT_DATABASE_URL`); check `pg_locks` for advisory lock 72707369 |
| Constraint violation on migrate | `npm run db:preflight`, fix the rows, re-run |
| Dev sign-in refused | production needs `ALLOW_DEV_SIGNIN=true` or SSO |
| `next dev` answers an existing API route with the app's HTML not-found page (404, ~6 kB gzipped; `/api/auth/dev`, `/api/requests/{id}`…) while other routes work | a stale Turbopack dev cache (`.next/dev/cache/turbopack`) restored a route tree without those routes — seen Sept 25 after bundles were fetched under a stopped server. `npm run dev:clean` (deletes `.next/dev`, then starts); `next.config.ts` now sets `experimental.turbopackFileSystemCacheForDev: false` so a restart always rescans |


## 28. Full-application debugging run (Sept 24)

Branch `debug/2026-09-24-full-application`, run directory `docs/debug-runs/2026-09-24-full-application/`
(manifest, inventory, coverage matrix, bug log in Markdown and JSON, test ledger, blockers,
checkpoint, final report, independent review, five workstream reports, sanitised evidence). Everything
in §26.1–26.3 and every KN-01…KN-24 item of the brief was reproduced and closed there; the sections
above were corrected where behaviour changed. Highlights that change how the application behaves:

- **Security:** `SSO_MODE=proxy` trusts `x-sso-subject` only with `x-sso-proxy-secret` =
  `SSO_PROXY_SHARED_SECRET` (production refuses to start without it); CSRF gate on cookie-authenticated
  mutations; the Salesforce webhook is open at the proxy for exactly its path; forwarded
  `X-Forwarded-Host` / `x-request-id` count only behind a declared proxy; decompression-bomb guard on
  spreadsheet uploads; integration URL fields refuse loopback/private/metadata hosts; error mapping no
  longer turns runtime faults into 400s.
- **Redaction:** scenario economics, raw `economicsJson`, approval snapshots, matcher rationale and
  `factorsJson` notes, `targetPrice`, policy margins, the xref workbook's rationale prose and the NDJSON
  export are redacted for roles without cost/margin permission; `GET /api/settings` shows the model
  endpoint and call statistics to operators only.
- **Commercial atomicity:** contract price entries, submission, decisions (proposal row locked —
  two approvers deciding two lines at once no longer strand a proposal), reopen, WON, policy activation
  and feed ingestion are single transactions / advisory-locked; `money()` accepts plain decimal notation
  only; scenario kinds are the constraint's six; CRM push is gated by `canFinalize`.
- **Matching:** BIN_VERSION 8 (structured cm/inch sizes, negations, Versaport bladeless-with-cannula,
  "for use with … trocar"); preferred-column reviewer notes are never SKUs (and never published —
  **re-publish the crosswalk in every environment whose published version predates this run**);
  SELF_MATCH follows successor chains with a cycle guard; deterministic tie-break; run weights
  snapshotted at enqueue; the sibling floor never lifts a hard cap; NFKC folding of codes; openFDA
  timeout (`OPENFDA_TIMEOUT_MS`).
- **Platform:** `OWN_LABELERS` implemented, strict single-tenant start-up (`TENANCY_STRICT`),
  `JOBS_WORKER` values validated, entrypoint execs local binaries so SIGTERM reaches the server,
  the harness releases pg-boss so the tsx suites exit, health sees stalled jobs, job retry limits are
  honoured, a malformed cron cannot take the job system down, rotated encryption keys fail safely, the
  runner never advances the watermark past a page cap, FX look-back canonical at 5 days.
- **UI:** GPO contracts can be created; prices gated by `view_pricing` on server pages; `/docs/[doc]`
  serves the two allow-listed guides; every control follows role and business state
  (`PermissionsProvider`); sidebar groups; error/not-found boundaries; hooks-order lint gate (`npm run
  lint`, in CI); 0 axe violations and 0 horizontal-scroll pages at four widths; polling stops on unmount.
- **Still open (missing inputs):** `eval:gate` until the model baseline is re-measured at the
  current bins with a key; Docker image build/boot (no daemon here); live-provider, macOS and
  browser-matrix verification.

### 28.1 Owner decisions moved into the product (Sept 25)

The run's three "needs an owner" items were decisions Crosswalk asked a person with a spreadsheet to
make. At the companies it is deployed for nobody owns that spreadsheet, so each became a mechanism:

- **Is B12LTH optical?** — answered from the labeler's own catalog. Ethicon marks optical products in
  the line as "ENDOPATH XCEL OPTIVIEW" (codes 2B12LT, 2B5ST…); a plain "ENDOPATH XCEL" record carries
  no marker, and the absence is now evidence with the sibling records as provenance (`gudid:siblings`,
  `src/lib/match/siblings.ts`, MATCH_QUALITY_MODEL §3.4; BIN_VERSION 9). The run builds the sibling
  index per competitor manufacturer from `GudidDevice`. Generic: any labeler that marks a binary
  feature on some of a line's records has said what the others are.
- **Thoracoport** — GUDID says "Trocar" and "…Single Use Trocar; Non-conductive Sleeve"; the component
  reading now treats a sleeve named as an attribute of a trocar as a trocar, and a sleeve sold *with*
  its obturator (Ethicon "Thoracic Trocar Sleeves with Rounded Tip Obturator", TT012) as the complete
  device (`component.ts`), so the thoracic ports cross to each other (WS1-F27's TT012 concern is
  gone); "sleeve only" / "sleeve assembly" / "universal sleeve" remain cannula.
- **The 14 flagged curated rows, and every row like them anywhere** — the **Evidence conflicts** queue
  (Crosswalk page; `src/lib/xref/conflicts.ts`; `GET /api/crosses?conflicts=open`,
  `POST /api/crosses/{id}/conflict`). A run that contradicts a curated row marks the `KnownCross`
  (`conflictStatus`, `conflictJson`, `conflictCount`, `conflictSeenAt`, decided-by/at/note; migrations
  `20260925000000_curated_conflicts` + tier-3 CHECK). A `manage_crosswalk` reviewer settles it with
  Retire / Replace with \<SKU\> / Keep (MATCH_QUALITY_MODEL §5.5). Runs never wait; KEEP holds only
  against soft findings; decisions survive re-runs and re-seeds; audited as `CONFLICT_<decision>`.
- **Children of an unassigned parent (B-08)** — not derivable from data, so a per-company setting:
  Settings → "Account visibility" (`scopeUnassignedParent`, `inherit` by default — the behaviour before
  the setting existed; `own` keeps a hospital with its own owner with that owner while its IDN is
  unassigned). The default was `own` until Sept 26, when CI showed it taking a rep's IDN member out of
  a territory-less manager's view — and the approvals on it with it; narrowing is now opt-in.
  `scopeFor` reads it; `accountWhere` builds the parent clause accordingly (DATA_ACCESS_POLICY).

Tests: `tests/unit/decisions-siblings.test.ts`, `tests/db/decisions-conflicts.test.ts`, the scope
fragment case in `tier0-units`. Deploy note: `npx prisma migrate deploy` now has two migrations to
apply; re-publish the crosswalk after the first decisions.

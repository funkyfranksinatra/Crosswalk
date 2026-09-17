# Crosswalk

**Competitor Product Cross Reference Engine.** In healthcare data a *crosswalk* is a mapping between two code systems; this one maps what a hospital buys from a competitor to the products you sell.

A local tool for medical-device sales teams. Point it at what a prospect buys
from a competitor (catalog numbers + quantities — a Google Sheets link, a
pasted range, or an .xlsx/.csv), and Crosswalk resolves every code against FDA
GUDID, bins the product attributes, ranks your best-fit and next-best SKUs
with prices, and produces both a rep-editable cross-reference workbook and a
customer-facing contract offer — as Google Sheets, .csv, or .xlsx.

```
Google Sheet / .csv / .xlsx ──▶ resolve (openFDA/GUDID) ──▶ bin attributes ──▶ match & rank ──▶ review UI ──▶ Google Sheets / .csv / .xlsx
                                     ▲ LLM hints                  ▲ LLM bins         ▲ LLM grading
```

Since v0.4 Crosswalk is also a **deal desk**: contracts and GPO tiers, a price
waterfall with effective dating, competitor price intelligence with
confidence decay, versioned pricing policies and discount authority, priced
proposals with scenarios and approval routing, published crosswalk versions,
won/lost outcomes that feed contract compliance, and role-based access with a
full audit trail. See `docs/ENTERPRISE_ARCHITECTURE.md` and
`docs/BUSINESS_RULES.md`.

The app is Next.js UI + API, Prisma 7 on **PostgreSQL** (Neon in dev; any
Postgres 15+ in prod), openFDA over HTTPS, and (optionally) an
OpenAI-compatible model. **Nobody needs an Excel licence**: Google Sheets is
the first-class path, and every download opens in Sheets for free.

## Quick start

```bash
cp .env.example .env          # set DATABASE_URL (ask the owner for the shared Neon dev URL); add OPENAI_API_KEY + LLM_MODEL if you have them
npm run setup                 # install, generate Prisma client, migrate, seed catalog + enterprise demo data
npm run dev                   # http://localhost:3000
```

`DATABASE_ADAPTER` stays `pg` on a normal machine. A **production build** (`npm run
build && npm start`) refuses the development sign-in unless `ALLOW_DEV_SIGNIN=true`
is set (demo boxes only) or SSO is configured, and wants a `SESSION_SECRET`; `npm
run dev` needs neither. Set it to `neon-ws` only in
an HTTPS-only environment (cloud sandboxes) — see `.env.example`. With no SSO
configured the sidebar shows a labelled **development sign-in** with the
seeded users (`alex.rep`, `maria.manager`, `sam.contracting`, `dana.director`,
`committee`, `admin`, …); pick one to see what that role sees.

The seed loads the curated `data/reference/Endomechanical.xlsx` (own SKUs +
human-verified crosses) and the hernia SKUs/prices from the legacy BAT report.
To also pull GUDID data for every own SKU (recommended, ~2 minutes):

```bash
npm run db:seed -- --gudid
```

Then open **New request** and either paste a Google Sheets link (shared as
*Anyone with the link → Viewer*), paste cells copied from a sheet, or drop in
`data/reference/CrossReference_0001880967.xlsx` — then **Continue request**.

### Google Sheets — three tiers, all free

| Tier | Needs | Gives |
| --- | --- | --- |
| Links | nothing | Paste a link to a sheet shared *Anyone with the link*; Crosswalk reads the tab in the link. Downloads (.xlsx/.csv) open in Sheets via Drive → New → File upload. |
| Paste / CSV | nothing | Copy a range from Sheets and paste it; or upload a Sheets → File → Download → CSV. |
| Drive write-back | a Google service account (free) | **Send to Google Sheets** writes both exports into a Drive folder as native Sheets (tabs + formatting kept) and links them from the request. Private sheets shared with the service-account email are readable too. |

Service-account setup (about 10 minutes, no cost): Google Cloud project →
enable Drive API + Sheets API → create a service account → JSON key → share a
Drive folder with the service-account email as *Editor* → set
`GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_DRIVE_FOLDER_ID` in `.env`. The
steps are also shown in **Settings → Google Sheets & Drive**, with a
*Test connection* button.

### Without a model key

Crosswalk runs fully in *heuristic mode*: deterministic regex/keyword binning and
attribute similarity. Add a key to get sharper bins, plain-language match
rationales, and model hints for codes GUDID can't find.

```
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-5.6-astra        # any model ID your endpoint accepts
# OPENAI_BASE_URL=https://.../v1  # optional gateway / Azure
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on :3000 |
| `npm run build && npm start` | Production build |
| `npm run db:seed [-- --gudid]` | (Re)load curated sheets; `--gudid` enriches own SKUs from openFDA |
| Catalog → GUDID library → **Import from GUDID** | Bulk-import a labeler's GUDID catalog (competitor or own); preview the count first; large labelers split by FDA product code |
| `npm run db:seed:enterprise [-- --no-demo]` | Seed dev users, roles, default pricing policy (+ demo accounts, GPO, contracts, observations) |
| `npm run db:studio` | Browse the Postgres database |
| `npm run check` / `npm run check:enterprise` | Pure unit checks: matcher rules / commercial engines (waterfall, cost, confidence, recommendation, rebates, bundles, clauses) |
| `npm run test:enterprise` | End-to-end commercial workflow against the database (request → proposal → approvals → export → won → compliance) |
| `npm run test:adversarial` | State machines, concurrency, authorization, money and import edge cases against the database |
| `npm test` | Vitest: the pure checks, Tier 1 unit tests, the resolver against recorded openFDA responses (no network), and the Tier 1 database suite |
| `npm run worker` | A dedicated job worker (only when the web server runs with `JOBS_WORKER=external`); see `docs/OPERATIONS.md` |
| `npm run benchmark [-- --llm --from-requests --out docs/benchmarks]` | Multi-list accuracy benchmark per family and tier (`data/benchmark/README.md`) |
| `npm run eval:model [-- --accept]` / `npm run eval:gate` | Measure model grading agreement against the curated crosses; the gate (also in CI) fails on an unmeasured prompt / bin / model change |
| `npx tsx scripts/run-sample.ts [file.xlsx]` | Headless run + both exports into `./out` |
| `npx tsx scripts/eval.ts --n 80 --no-crosses` | Score the matcher against curated crosses |
| `npx tsx scripts/record-openfda.ts` | Re-record the openFDA fixtures the offline tests replay |

## How matching works

1. **Resolve** — each code is searched in openFDA's Device UDI index (a
   searchable mirror of AccessGUDID) by `catalog_number` / `version_or_model_number`.
   Variants cover Excel-stripped leading zeros, punctuation, `-S`/`X` suffixes,
   list-wide hospital item prefixes (detected when ≥3 codes share one), and a
   wildcard *contains* tier. Two passes: unambiguous codes first, then the messy
   ones ranked with *list context* (manufacturers and product families already
   seen). Every hit gets a confidence; < 75 % is flagged **Verify** in the UI
   with the alternates one click away. Codes that turn out to be **our own**
   products are flagged *Already ours* and self-matched.
2. **Bin** — product → `{ productType, family, dimensions, materials, features,
   compatibility, singleUse, sterile, implantable }`. Heuristic binner always;
   model binner when configured (lazy, cached per product). GUDID leaves many
   competitor codes unsized (Ethicon meshes, most reloads); **Catalog →
   Competitor sizes** gives you a template pre-filled with every unsized code
   you have seen — fill in width/length or diameter from the competitor
   catalog and import it (file or Sheets link). Imported sizes beat GUDID and
   regex, and affected lines re-bin on the next run.
   **GUDID library** (Catalog → GUDID library) lets an authorised user pull a
   whole labeler's GUDID catalog (competitors' and our own) into the database;
   the resolver answers from it first — no network round trip per code — and
   anyone can look a product up by code, DI, brand or description. Codes the
   library does not hold still go to openFDA live. For *your own* products
   import the surgical labeler (Covidien), not the whole corporation, and only
   the families you sell into — adopted SKUs enter the matcher's candidate
   pool (ranked below curated SKUs, flagged as unpriced); **Clean up imported
   SKUs** removes anything the binner now classifies as another division.
3. **Retrieve** — curated crosses for the code + top attribute neighbours in
   the same family.
4. **Rank** — composite of attribute fit, competitive price, COGS, margin
   (weights in Settings; renormalised when a factor is missing). Curated
   crosses set a floor; a family mismatch caps at *Alternative*. The model, if
   present, grades the short list and writes the rationale.

Ground truth lives in **Known crosses**; `scripts/eval.ts` measures top-1/top-3
hit rate against it so heuristics can be tuned with evidence.

## From cross-reference to contract (v0.4)

```
request (cross-referenced lines)
  └─ Create proposal ──▶ per line: contract price (waterfall) · cost (plant/region) · competitor price (confidence-weighted)
                                    · floor / target · recommendation + explanation · required approval authority
       ├─ scenarios (recommended / aggressive / margin-optimised) — compare, apply
       ├─ submit ──▶ auto-approve within the rep's incremental discount authority, route the rest (manager → contracting → director → committee)
       ├─ export quote / push to CRM   (blocked until every included line is approved)
       └─ record outcome ──▶ WON: prices become a LOCAL contract + commitments (compliance, renewals)
                            LOST: competitor prices become intelligence observations
```

Pages: **Proposals**, **Approvals**, **Accounts**, **Contracts**,
**Competitor pricing**, **Analytics**, **Settings → Pricing policies /
Integrations**; **Known crosses** gained clinical/marketing review and
published versions. Every page is filtered by the signed-in role; cost, margin
and floor are redacted server-side for roles without `view:cost`.

## Layout

```
prisma/schema.prisma        data model — catalog & matching (Company, OwnProduct, CompetitorProduct, CompetitorSpec, KnownCross,
                            Request/RequestLine/MatchCandidate, LlmCall, LlmGrade) + commercial (User/UserRole, Account, Gpo,
                            Contract/PriceEntry/Commitment/Rebate/Bundle, StandardCost, CompetitorPriceObservation, PricingPolicy,
                            Proposal/Line/Scenario, ApprovalRequest, CrosswalkVersion, PurchaseRecord, DealOutcome, AuditEvent, …)
prisma/migrations/          Postgres migrations (SQLite history kept in migrations-sqlite-v0.3/)
prisma/seed.ts              curated sheets → DB · seed-enterprise.ts users, roles, policy, demo commercial data
src/lib/cfn.ts              catalog-number normalisation
src/lib/gudid/openfda.ts    openFDA client · enrich.ts own-catalog enrichment · library.ts bulk labeler import + library-first lookup
src/lib/llm/client.ts       OpenAI adapter (structured outputs, logged) · tasks.ts bin / hints / grade
src/lib/match/bin.ts        bin schema, heuristic binner, similarity · score.ts ranking
src/lib/pipeline/resolve.ts two-pass CFN resolution · run.ts the request pipeline
src/lib/excel/              intake parser (xlsx/csv/Sheets → grid), pricing + competitor-sizes import/template, exports
src/lib/sheets/             Google Sheets link reader, Drive write-back (service account), CSV codec
src/lib/money.ts            the only place money arithmetic happens (decimal.js, banker's rounding)
src/lib/auth/               roles, permission matrix, actor resolution (dev sign-in / SSO header), redaction
src/lib/contracts/          price waterfall, pricing context, rebates, bundles, structured clauses
src/lib/catalog/            standard cost resolution, FX
src/lib/intelligence/       competitor price observations, confidence decay, summaries, import
src/lib/pricing/            versioned pricing policies, floor/target, recommendation engine, authority
src/lib/proposals/          proposal service (snapshots, scenarios, versions), deal economics, outcomes, quote export
src/lib/approvals/          routing rules, submit / decide / finalize gating
src/lib/xref/governance.ts  cross approval, clinical/marketing review, published crosswalk versions
src/lib/compliance/ · analytics/   contract performance, conversion, renewals · win/loss, effectiveness, accuracy
src/lib/integrations/       CRM / ERP / GPO adapter contracts, dev fixtures, Salesforce/SAP skeletons, idempotent sync
src/lib/audit.ts            audit events (before/after/context)
src/app/                    Next.js App Router UI + API routes (`src/lib/api.ts` wraps every route with a permission)
docs/ARCHITECTURE.md        decisions and rationale (matching pipeline)
docs/ENTERPRISE_ARCHITECTURE.md  the deal-desk platform: plan, ER diagram, scenario walk-through, decisions, risks, role review
docs/BUSINESS_RULES.md      every commercial rule, where it is implemented, and its test
docs/INTEGRATIONS.md        systems of record, adapters, and the credentials / data feeds still required
docs/PRODUCTION_READINESS.md what stands between this prototype and a production system (start here if you're joining the team)
docs/REQ-0013_vs_PACR_comparison.md  latest head-to-head against the legacy PACR tool
CONTRIBUTING.md             setup without the reference data, commands, conventions, review checklist
```

# Crosswalk architecture & decisions

## Decisions (agreed with Dev, Sept 2026)

| Topic | Decision | Why |
| --- | --- | --- |
| App shape | Next.js 16 web app on localhost, single repo | One `npm run dev`, designed UI, later deployable behind SSO |
| Database | **v0.4: Prisma 7 + PostgreSQL** (Neon in dev; `pg` / `neon-ws` driver adapters). v0.1–0.3 used SQLite via libSQL for zero-install demos; history kept in `prisma/migrations-sqlite-v0.3/` | The commercial platform needs `Decimal` money, real transactions, concurrent users and effective-dated rows; Neon gives the team a shared dev database and branches without hosting anything. See `docs/ENTERPRISE_ARCHITECTURE.md` |
| LLM | OpenAI Responses API, model ID from `LLM_MODEL` in `.env`, deterministic fallback | "gpt 5.6 astra" is not a public model ID; keep it configurable, never blocking |
| Competitor lookup | openFDA Device UDI first, LLM hints as fallback | AccessGUDID's own API only looks up by DI; openFDA searches by catalog number and returns the full GUDID record |
| Own catalog | The MDT SKUs in `Endomechanical.xlsx` (+ hernia SKUs from the legacy BAT report), enriched from openFDA | Small, curated, matches the reference data; grows via **Add SKUs** |
| Pricing | Optional import (List, COGS, pricebooks); ranking renormalises when missing | openFDA carries no pricing; the tool must be useful before finance data arrives |
| GUDID library | Bulk import of a labeler's whole GUDID catalog (`GudidDevice`, keyed by openFDA record key; `GudidImport` job rows) behind `manage_catalog`; the resolver checks the library per variant before calling openFDA; "own" imports can adopt SKUs into `OwnProduct` (source `gudid-import`) filtered by family | A hospital list costs one openFDA round trip per variant (~300 ms, rate-limited); a competitor catalog held locally resolves in one indexed query, and product lookup no longer needs the FDA site. Catalog numbers collide across labelers, so the library is keyed by record, not by code. Whole-labeler adoption into our catalog is family-filtered so the matcher's candidate pool stays relevant |
| Whole-labeler imports and the matcher | Adopted SKUs are `source: gudid-import`; "Other" is never adopted; the FDA review panel (`OFF_SPECIALTIES`) and a non-surgical keyword rule force other divisions to "Other" whatever GUDID's own mesh/plug wording says; the candidate pool loads imported SKUs only in the families the request is about; imported SKUs lose ranking ties to curated ones and carry a note; **Clean up imported SKUs** re-bins and removes what no longer belongs | A full Medtronic pull (88k records) adopted 71k SKUs — spinal cages filed as "Mesh, Surgical, Metal", bypass tubing "plugs", DBS bore plugs — and a hernia line then matched a Pyramesh cage. A keyword binner cannot tell divisions apart; the FDA panel can. Import **Covidien** for the surgical business, not "Medtronic" |
| Competitor sizes | Optional import keyed by competitor code (`CompetitorSpec`); template pre-filled with every unsized code seen | GUDID has no dimensions for Ethicon meshes and many reloads, so those lines tied to our smallest product; the rep knows the size from the competitor catalog |
| Spreadsheets | Google Sheets first-class, tiered: link reads with no credentials, service-account Drive write-back when configured; .xlsx/.csv kept | Demo users shouldn't need an Excel licence; .xlsx is a format Sheets opens for free, so the real win is link-in / Sheet-out convenience without forcing every machine through Google Cloud setup |

## Data flow

```
intake.xlsx
  └─ parseIntake()            header detection, CFN normalisation, duplicate merge
Request + RequestLine[]
  └─ runRequest()
       ├─ pass 1  resolveCfn(strict)          exact / punctuation / zero-pad variants — GUDID library first, openFDA when the library has nothing
       ├─ buildContext()                       manufacturers, families, list-wide prefixes
       ├─ pass 2  resolveCfn(ctx)             prefix-stripped + wildcard tiers, scored with context
       │           └─ KnownCross description  └─ cfnHints() (LLM) → retry
       ├─ auto-add own SKUs the customer already buys (identity matches)
       ├─ specFor() imported competitor sizes  (beat GUDID + regex; import clears stale bins)
       ├─ binProduct() per unique competitor  (LLM or heuristic, cached on CompetitorProduct)
       ├─ retrieve: KnownCross + attribute neighbours in family
       ├─ binProduct() lazily for our candidates (cached on OwnProduct)
       ├─ scoreCandidates()                    bin · price · cogs · margin, renormalised
       ├─ groupSiblings() → gradeGroup() (LLM) siblings (manufacturer+brand+family+construction) graded in ONE call;
       │                                        verdicts cached in LlmGrade by input hash → re-runs replay
       ├─ applyGroupGrades()                   model verdicts + sibling floor (Alternative for one → ≥Alternative for all)
       └─ MatchCandidate[] + selection
exports
  ├─ buildCrossReferenceWorkbook()  legacy SSXrefReport columns + next-best + rationale + candidates + unresolved
  └─ buildContractOfferWorkbook()   customer-facing, selected lines only, no internal cost/margin
```

## Google Sheets integration

* **Reading a link** uses the sheet's CSV export endpoint
  (`/spreadsheets/d/{id}/export?format=csv&gid=…`), which works for any sheet
  shared *Anyone with the link* — no API key, no OAuth. A login redirect or
  HTML response is turned into a precise "share it like this" hint.
* **Private sheets** go through the Sheets API with a service-account JWT
  (`google-auth-library`, REST via `fetch`; no `googleapis` bundle). Public
  fallback is automatic.
* **Write-back** reuses the ExcelJS workbooks: the `.xlsx` is uploaded to
  Drive with `mimeType: application/vnd.google-apps.spreadsheet`
  (convert-on-upload), so tabs, number formats, fills and freeze panes arrive
  intact and we maintain one export code path. Files land in the shared
  folder; links are stored on the `Request`.
* All three sources reduce to a plain grid before `parseIntakeGrid`, so the
  header detection / duplicate merge logic is identical everywhere.

## Resolution details that matter

* **Excel eats leading zeros.** BD/Bard codes are 7-digit zero-padded
  (`0112660`); the intake shows `112660`. We try widths 7, 6, 5, 8.
* **Hospitals prefix item numbers.** In the MSK sample every Medtronic code
  carried `3583`. A prefix shared by ≥3 codes is trusted (tier 1); a guessed
  prefix is tier 2 and needs context to win.
* **Numbers collide across manufacturers.** `74006` is both a lubricant and
  (with the prefix) ProTack. Hits are scored on exactness, variant tier,
  reprocessor penalty, distribution status, and whether the manufacturer /
  family already appears on the list. Confidence < 0.75 → *Verify* badge.
* **Reprocessors relabel codes** (Sterilmed, Stryker Sustainability,
  Provision). They are penalised, never preferred.
* **Not-found is retried every run**; resolved records are cached across
  requests. Manual corrections (`resolution = manual`) are sticky.

## Binning

`Bin` is the comparable shape for both sides. Bins carry the heuristic rule
version (`v`, or `hv` for model bins that corrected a heuristic draft); bumping
`BIN_VERSION` rebuilds both kinds on the next run. Dimensions are normalised
(dual-unit labels collapsed, `height 1 mm` → `thickness`) before they reach the
model or the similarity function. The heuristic binner reads
sizes from GUDID `device_sizes` first, then regex over text (`12 mm x 100 mm`,
`7.5 cm x 10 cm x 1 mm`, `13 gauge`, `30 tacks`, `Round 12 cm x 1`), normalises
negations (`nonabsorbable` ≠ `absorbable`), and tags features (bladeless,
optical, fixation cannula, reload colour, reinforced, barrier…). Family rules
run before the sales category so `ProTack — Fixation Device` never lands in
*Hernia Mesh* because its GMDN term mentions mesh.

Similarity = weighted average of family, product-type token overlap,
dimension closeness (per canonical name, in mm; unknown-on-one-side = 0.35),
feature and material Jaccard, and description overlap; a family mismatch
halves the score and caps the match type at *Alternative*.

## Grading consistency

Model grading is non-deterministic, so two guards keep results stable:
sibling lines (same manufacturer, brand, family **and construction signature** —
materials plus barrier / absorbability / plug tags, so Phasix and Phasix ST, or
GORE DUALMESH and GORE-TEX Soft Tissue Patch, never share one verdict) are
graded together in one call with an explicit consistency rule and a deterministic floor (a SKU
that is an Alternative for one sibling cannot be No Match for another), and
every group verdict is cached in `LlmGrade` keyed by a SHA-256 of the exact
inputs (competitor bins, candidate bins, model ID, prompt version). **Re-run**
replays cached verdicts for unchanged lines; **Re-grade fresh** ignores the
cache. Bumping `GRADE_PROMPT_VERSION` invalidates all cached verdicts.

## Observability

Every model call is logged to `LlmCall` (purpose, model, tokens, ms, error)
and summarised in Settings. The record is written by the application gateway
(`src/lib/ai/gateway.ts`), never by the model layer, which has no database access
at all — see `AI_BOUNDARY.md`. Every request keeps a run log. `scripts/eval.ts`
reports resolution rate and top-1/top-3 hit rate against the curated crosses.

## Roadmap candidates

* Embedding-based retrieval when the catalog grows past a few thousand SKUs.
* Pricebook tiers per account/GPO (the BAT screenshot's "Pricebook Tiers").
* Review workflow: assign lines, comments, approval before the offer exports.
* Learning loop: rep selections → new KnownCross rows.

## Beyond matching

The commercial layer added in v0.4 (contracts, waterfall, competitor intelligence, pricing policy, proposals, approvals, governance, outcomes, analytics, RBAC, integrations) is documented in `docs/ENTERPRISE_ARCHITECTURE.md` (plan + implementation record) and `docs/BUSINESS_RULES.md` (rule → file → test). This document stays about the matching pipeline that feeds it.

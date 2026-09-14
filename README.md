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

Everything runs on your machine: Next.js UI + API, Prisma on a SQLite file
(libSQL driver — prebuilt binaries, no C++ toolchain needed on Windows),
openFDA over HTTPS, and (optionally) an OpenAI-compatible model. **Nobody
needs an Excel licence**: Google Sheets is the first-class path, and every
download opens in Sheets for free.

## Quick start

```bash
cp .env.example .env          # add OPENAI_API_KEY + LLM_MODEL if you have them
npm run setup                 # install, generate Prisma client, migrate, seed
npm run dev                   # http://localhost:3000
```

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
| `npm run db:studio` | Browse the SQLite database |
| `npx tsx scripts/run-sample.ts [file.xlsx]` | Headless run + both exports into `./out` |
| `npx tsx scripts/eval.ts --n 80 --no-crosses` | Score the matcher against curated crosses |

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
3. **Retrieve** — curated crosses for the code + top attribute neighbours in
   the same family.
4. **Rank** — composite of attribute fit, competitive price, COGS, margin
   (weights in Settings; renormalised when a factor is missing). Curated
   crosses set a floor; a family mismatch caps at *Alternative*. The model, if
   present, grades the short list and writes the rationale.

Ground truth lives in **Known crosses**; `scripts/eval.ts` measures top-1/top-3
hit rate against it so heuristics can be tuned with evidence.

## Layout

```
prisma/schema.prisma        data model (Company, OwnProduct, CompetitorProduct, CompetitorSpec, KnownCross,
                            Pricebook/PriceEntry, Request/RequestLine/MatchCandidate, LlmCall, LlmGrade)
prisma/seed.ts              curated sheets → DB
src/lib/cfn.ts              catalog-number normalisation
src/lib/gudid/openfda.ts    openFDA client · enrich.ts own-catalog enrichment
src/lib/llm/client.ts       OpenAI adapter (structured outputs, logged) · tasks.ts bin / hints / grade
src/lib/match/bin.ts        bin schema, heuristic binner, similarity · score.ts ranking
src/lib/pipeline/resolve.ts two-pass CFN resolution · run.ts the request pipeline
src/lib/excel/              intake parser (xlsx/csv/Sheets → grid), pricing + competitor-sizes import/template, exports
src/lib/sheets/             Google Sheets link reader, Drive write-back (service account), CSV codec
src/app/                    Next.js App Router UI + API routes
docs/ARCHITECTURE.md        decisions and rationale
docs/PRODUCTION_READINESS.md what stands between this prototype and a production system (start here if you're joining the team)
docs/REQ-0013_vs_PACR_comparison.md  latest head-to-head against the legacy PACR tool
CONTRIBUTING.md             setup without the reference data, commands, conventions, review checklist
```

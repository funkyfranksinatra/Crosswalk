# Tier 3 debug report — product and scale

Scope: **only the Tier 3 changes** (commit `cae1781` and its fix commit). Nothing outside the
ten Tier 3 items was reviewed or re-tested beyond running the existing suites to prove they
still pass. Full-system testing stays deferred, as agreed.

Date: 18 September 2026. Build under test: `next build` of the fix commit, run against a
local Postgres 16 with pgvector and the demo seed; network only to USAspending (one real
pull to prove the request shape), never to SAM.gov, Avalara or OpenAI.

## Method

1. Three independent adversarial reviews of the Tier 3 diff, each with a different lens:
   security / authorization / data exposure; correctness / money math / data integrity;
   concurrency / jobs / failure modes / UI–API contract. Every finding was verified against
   the source before being accepted, and several review claims were rejected after checking.
2. `tests/db/tier3.test.ts` (17 cases, no network) extended to pin each fix.
3. Live checks on the production build: sign in as six seeded roles and exercise every new
   route (system, analytics, branding, delegations, bids, bid-file import, run → bulk actions
   → compare → notes → offer PDF → proposal → freight/tax → submit → quote PDF/xlsx), plus a
   real USAspending pull through the queue.
4. Rendered the quote and contract-offer PDFs to images and looked at them.

## Findings

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| P0 | 0 | — | 0 |
| P1 | 3 | 3 | 0 |
| P2 | 21 | 21 | 0 |
| P3 | 24 | 21 | 3 (documented below) |

### P1 — would have shipped broken

1. **Every PDF had two blank trailing pages per real page.** The footer was drawn below
   pdfkit's `page.maxY()`, which starts a new page even with `lineBreak:false`. A 3-line
   quote rendered as 3 pages. The test only checked byte length. Fix: stamp the footer inside
   the bottom margin; `pdfPageCount()` asserted in tests (a 2-line offer = 1 page, 120 lines
   = 3–8 pages). Verified: 1 page each on the live build.
2. **An approved proposal could never export its quote.** Tax staleness compared
   `taxCalculatedAt` with `ProposalLine.updatedAt`, and submission, approval, reopen, drift,
   notes and the new customer-note edit all bump `updatedAt`. The normal workflow — calculate
   tax in the draft, submit, approve, export — ended in "recalculate". The test passed only
   because it set logistics after approval. Fix: the tax figure stores a fingerprint of what
   was taxed (priced included lines × qty, freight mode/value, ship-to, mode, rate,
   exemption); staleness is "fingerprint differs from the quote now". Notes, approvals,
   unchanged saves and economics refreshes no longer disturb it; a price committed *during*
   a provider call lands stale because the fingerprint is taken from the rows as read.
3. **The nightly embedding sweep starved most of a large catalog.** It scanned the N most
   recently updated rows and hashed them; on a 30k-row GUDID-import catalog the untouched
   tail was never embedded, and retrieval silently ignored it. Fix: candidates are selected
   in SQL (never embedded, other model, or edited since embedding), oldest-embedded first,
   and `limit` applies to that set; unchanged-but-touched rows are re-stamped so they leave
   the queue.

### P2 — wrong under realistic conditions

- **Retrieval excluded curated SKUs.** The ANN query filtered `OwnProduct.category` against
  the *bin family*; curated categories ("Synthetic Mesh") are not family names ("Hernia
  Mesh"), so only GUDID-import rows came back — and HNSW post-filtering a selective WHERE
  returned a handful of rows. Fix: no WHERE on family; over-fetch ×4 with `hnsw.ef_search`
  raised; filter by bin family in the app; fall back to the scan when fewer than 5
  neighbours survive.
- **Duplicate candidates under concurrency.** Two lines sharing an out-of-pool neighbour
  both lazy-loaded and pushed it. Fix: promise memo per id; candidates deduped by product.
- **One embedding call per line, no timeout, no breaker.** Duplicate codes re-embedded the
  same competitor product; a dead endpoint meant a failing call per line with the default
  600 s timeout. Fix: per-run memo of competitor vectors; OpenAI client 20 s / 1 retry;
  the first failure switches the rest of the run to the scan.
- `pgvectorAvailable()` cached a transient DB error as "not installed" for the process.
- **Lent permission without attribution.** A delegate could use a delegator's
  `approve_below_floor` on a line their own role covered, recording `onBehalfOf = null` and
  bypassing the no-proxy-approval rule. Fix: permissions are attributed to the delegator
  that lends them; `authorityFor` takes the permission and an exclusion list; the delegator
  who submitted a request lends nothing for it (queue and decide agree); notifications skip
  delegates of the submitter; a delegate must already be an approver.
- Approval queue and delegations directory returned cost fields / a user directory
  unredacted; the analytics API returned margin to `view_analytics` users without
  `view_margin`. All now go through the redaction helpers.
- Analytics manual refresh was a synchronous full recompute for any analytics user; the
  event debounce dropped later events' report lists (the exclusive singleton keeps the first
  payload). Fix: manual refresh goes through the queue (or inline at most once a minute
  without one); event refreshes always cover every report; fresh reads prune history.
- **`listAwards` spread two `OR` filters into one key**, dropping the date window whenever a
  search term was present. Fix: `AND: [{OR…},{OR…}]`.
- Competitor matching accepted prefixes ("Bard" ⊂ "Bardot"). Now whole-word only.
- **USAspending rejects the PSC filter Tier 3 sent** (`[["6515"]]` → 422 "Tier1 PSC filter
  values must be one of Research and Development / Service / Product") and returns
  NAICS/PSC as `{code, description}` objects. Both verified against the live API; fix:
  hierarchical `pscPath()` and `codeOf()`. A real pull now imports 1,000 awards.
- Bid-file column detection was first-loose-match ("Department" became the code column,
  "Updated Date" the award date). Now anchored names first, dates excluding
  updated/valid/expiry, and `$1,250.00` / Excel serial dates parsed.
- SAM.gov: key moved from the query string to `x-api-key`; one page per NAICS by default
  (`SAM_MAX_PAGES`); a 429 fails the run without the queue retrying it; manual pulls once an
  hour per source (`force` to override); a RUNNING FeedRun from a crash is closed out.
- Bid-file import: 20 MB / 20,000-row caps, `http(s)` URL check, observations linked to the
  uploaded Document, an audit event per file; pull settings need `configure_settings`.
- Customer notes on a proposal now follow the price lock (draft or changes-requested only);
  request-line notes and flags are audited.
- `flag_verify` bulk action un-reviewed lines a rep had accepted. Now skips reviewed lines.
- Compare route gated the list price but not the candidate unit price, and returned scorer
  rationales containing margin text. Both gated. Offer PDF needs `export_proposals`.
- The `.xlsx` quote had no freight/tax lines and no stale gate, so it disagreed with the PDF.
- Freight `PCT` bound was only checked when a value was sent (a FLAT 5000 became 5000 %).
- A ship-to with only `country` counted as an address and shadowed the account default.
- Saving the logistics form unchanged discarded the calculated tax (a billable call each
  time with AvaTax).

### P3 — fixed

pg-boss rejects `:` in schedule keys (found live: `embed.refresh` and `analytics.refresh`
never scheduled); `off` and try/catch for the new crons so a bad value cannot stop orphan
recovery; seeds resolve the company the way `getCompany()` does; SVG logos rejected (the
renderer never drew them) and logo pixel count capped (decompression bomb); PDF column
widths, Courier row heights, totals block with wrapping labels, "(none)" equivalence
suppressed; UI: admins see the delegations they set, day windows in the browser's zone, no
double submit, compare fetch aborts on candidate switch, bid settings not overwritten by
searching, logistics form kept while colleagues edit, analytics refresh busy/queued states,
branding card error handling; `.env.example` and OPERATIONS.md corrected (timeouts, endpoint
overrides, SAM pages, pgvector is required by the migration).

### P3 — open, by choice

- **Delegation windows are calendar days in the browser's zone**, not a configured business
  zone. Fine for a single-region pilot; multi-region needs a company timezone setting.
- **The embedding sweep loads `binJson` for every pending row into memory** when run without
  a limit (`npm run embed` on a very large catalog). Batching the load is straightforward
  when a catalog that size exists.
- **`createDelegation` overlap check is check-then-insert** (no unique index). Two
  simultaneous identical delegations from one browser are prevented client-side; a true race
  produces two overlapping rows, both valid, no privilege effect.

## Review claims rejected after verification

- "The test-only actor seam is exploitable": it is fenced on `VITEST` *and*
  `NODE_ENV !== "production"` on both set and read, has no callers in `src/`, and is
  unreachable over HTTP.
- "Raw SQL in embeddings is injectable": every value is a bind parameter; the table name is
  a closed TypeScript union reachable only from job data.
- "AvaTax credentials can leak": `/api/system` exposes only configured/env/dryRun; the
  adapter never logs or stores the key.

## Verified live (production build)

Sign-ins as rep, manager, director, admin, executive, marketing, finance:
tenancy line and retrieval coverage on Settings → System; analytics margin redacted for
executive, present for finance; manual refresh queued; branding PUT 403 for a rep, 400 on a
bad colour; delegation to a rep refused ("cannot approve pricing"), director → manager
created, stranger's revoke 403, owner's revoke 200; bid settings 403 for a rep / saved by
admin; USAspending pull queued and — after the PSC fix — completed with 1,000 awards; SAM
refused without a key; a CSV bid file produced one award and one price observation; a run
through the queue, `flag_verify` (1 line), `review_exact` (1 line), unknown action 400;
side-by-side with 18 rows and a similarity score; customer note + flag saved; offer PDF 200
(1 page), xref PDF 400, marketing 403; proposal created, freight 3 % + manual 8.25 % tax
calculated ($945.68 on $11,462.75 + $343.88), unchanged save kept it, PROVIDER refused
without AvaTax, quote export 400 before approval, 200 after (PDF 1 page, xlsx), customer note
locked after approval; embedding counters present in `/api/metrics`; all ten queues
registered.

Suites after the fixes: Vitest 96 (Tier 3 17), `test:enterprise` 18, `test:adversarial` 24,
`check` 19, `check:enterprise` 21, `tsc` and `next build` clean.

## What Alex still has to do

- `npm install` (pdfkit), `npx prisma migrate deploy` (Neon has pgvector), `npx prisma generate`.
- `npm run embed` once with the model key (353 own products on the demo catalog take a minute).
- Settings → Branding: logo, address (also the tax ship-from), terms.
- For AvaTax: `AVATAX_ACCOUNT_ID`, `AVATAX_LICENSE_KEY`, `AVATAX_COMPANY_CODE` (sandbox first,
  `TAX_DRY_RUN=true` to demo without an account). For SAM.gov: `SAM_API_KEY`.
- CI now uses the `pgvector/pgvector:pg17` image; the migration hard-requires the extension.

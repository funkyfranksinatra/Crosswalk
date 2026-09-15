# Crosswalk — Full Application Debug, Stress, Security and Reliability Report

Date: 15 September 2026 · Codebase: Crosswalk v0.4 (commits `1a7846c` → `0c1aa81` on `main`) · Environment: **development** (Neon Postgres). All destructive and concurrency testing ran on an isolated Neon branch (`debug-run`, `br-frosty-credit-b5yn6jrl`); the shared dev database received only the two additive migrations.

## Executive summary

**Initial status.** All existing checks were green (16 + 21 pure cases, 17 end-to-end steps, typecheck, build) — and the application was not safe to expose to a second user. Fifteen API routes that predate the v0.4 authorization layer accepted anonymous requests, including the cross-reference export that carries cost-fit and margin-fit columns, the COGS import, and global settings. The development session cookie was the bare user id, so anyone who had seen the sign-in list could become the administrator by editing a cookie. The approval workflow had a chain that let an unreviewed price become an approved, exportable quote. Contractual documents were totalled in floating point and quoted prices could differ from stored and contracted prices by fractions of a cent.

**Final status.** 38 defects discovered, 38 fixed, 0 open P0/P1. The four suites now run 19 + 21 pure cases, 18 end-to-end steps (including a full "critical scenario" reconstruction check), and a new 24-case adversarial suite that reproduces every serious defect found here and runs in CI against a Postgres service. Typecheck and production build are clean. A 300-line proposal that took 70 s to recompute and 63 s to submit now takes 0.4 s and 7 s.

**Assessments.** Security: *materially improved, not complete* — authentication remains a development mechanism (no SSO), there is no ownership/territory scoping, no rate limiting, and cookie signing depends on `SESSION_SECRET` being set. Data integrity: *good* — money is decimal end to end, prices are stored at the currency's minor unit, all multi-write operations that mattered are now atomic or compensated, and imports are idempotent. Production readiness: **READY FOR STAGING** (see the last section for what stands between staging and production).

## Bug summary

| ID | Sev | Area | Description | Status | Fix |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | P0 | Authorization | 15 legacy API routes (requests CRUD/run/export/sheets, intake preview, settings GET/POST, pricing & COGS import/template, competitor-sizes import/template, competitor correction, google status) had no authorization at all | Fixed | `src/proxy.ts` gate on `/api/*`; every route authorises via `authorize()`/`handle()`; cost/margin redacted per role |
| BUG-002 | P0 | Authentication | Session cookie was the raw user id — forgeable from the public sign-in list; dev sign-in active in production builds | Fixed | HMAC-signed cookie (`signSession`/`verifySession`), `secure` in production, dev sign-in refused in production unless `ALLOW_DEV_SIGNIN=true`, `SESSION_SECRET` |
| BUG-003 | P0 | Approvals (chain) | Changes-requested on one line unlocked the proposal; a sibling line with a *pending* request could be repriced; the approver then approved the stale snapshot and the new price became approved and exportable | Fixed | `decide()` verifies the snapshot price against the line; price/inclusion edits void pending requests |
| BUG-004 | P0 | Authorization | Server-rendered pages (accounts, contracts, catalog **with COGS**, requests) rendered for anonymous visitors and for roles without pricing visibility | Fixed | Layout renders a sign-in screen for anonymous users; page-level permission checks; catalog hides COGS without `view_cost` |
| BUG-005 | P1 | Approvals | After CHANGES_REQUESTED or REJECTED, resubmission left the old decision counted → proposal status stuck, never APPROVED, never exportable | Fixed | Submission and reopen supersede every prior live request |
| BUG-006 | P1 | Concurrency | Two approvers deciding the same request both succeeded (two decisions, two audit events, last write wins) | Fixed | Atomic `updateMany … WHERE status = PENDING` claim |
| BUG-007 | P1 | Concurrency | Double submit created two sets of approval requests | Fixed | Atomic proposal lock claim; failed submission rolled back |
| BUG-008 | P1 | Financial / data | A $0.01 price against a $300 cost overflowed `Decimal(9,6)` **after** the price had been written — line left with new price, stale margins, no rollup | Fixed | Columns widened to `Decimal(12,6)`, clamped `toDbPct`, price + derived fields written in one statement |
| BUG-009 | P1 | Data exposure | `/api/audit` and `/api/proposals/[id]/audit` returned floor, margin and cost inside before/after/context JSON to any `view_pricing` role; `recommendationJson` and its prose explanation leaked the same to reps | Fixed | `redactAuditEvent`, deep `redactJsonForActor`, `explanationPublic` |
| BUG-010 | P1 | State machine | A WON proposal could be re-recorded as LOST (and vice-versa), leaving the LOCAL contract created on win alive | Fixed | Closed proposals refuse a second outcome; LOST requires a submitted proposal |
| BUG-011 | P1 | Import / data | Purchase import: the `Invoice Date` header matched the invoice-number pattern first, so `externalId` was the date; no idempotency → re-importing a file doubled conversion and compliance figures | Fixed | `src/lib/imports/purchases.ts`: specific header patterns, per-row validation, update-on-re-import |
| BUG-012 | P1 | Financial | Customer quote and rep workbooks totalled with JS floats (`total += ext`, `Math.round(x*100)/100`); prices entered with sub-cent precision were stored at 4 dp, quoted at 2 dp and contracted at 4 dp | Fixed | Decimal totals with banker's rounding; proposed prices stored at the currency's minor unit |
| BUG-013 | P1 | Financial (chain) | Competitor intelligence ignored unit of measure: a case price observed at the account became the KNOWN_ACCOUNT reference for a per-unit recommendation | Fixed | Observations must match the context UOM; mismatches are reported, never converted |
| BUG-014 | P1 | Data (chain) | Renaming the company in Settings upserted a **second** Company row → every SKU, request and price disappeared from the UI | Fixed | Rename updates the existing row; `getCompany` is single-tenant |
| BUG-015 | P1 | Pricing config | Policy drafts were unvalidated: `minMarginPct: 1` yields no finite floor (floors silently disabled), inverted authority bands, unknown strategies | Fixed | `PolicyInputSchema` + cross-field `policyProblems` |
| BUG-016 | P1 | Authorization (IDOR) | Contract term deletion took any `termId` regardless of contract | Fixed | Deletes scoped to `{ id, contractId }` |
| BUG-017 | P1 | Performance | Per-line recompute cost ~4 round trips; 300-line proposal: recompute 70 s, submit 63 s, scenario 20 s | Fixed | `recomputeAllLines` + single `UPDATE … FROM unnest()`; batched submit, scenario create/apply, version clone |
| BUG-018 | P1 | Information leak | Prisma errors (query text, file paths, column names) returned to clients and stored in sync reports | Fixed | `publicErrorMessage`; conflicts map to 409 |
| BUG-019 | P2 | Input | `proposedPrice: "abc"` cleared the price silently | Fixed | Refused with 400 |
| BUG-020 | P2 | Authorization | Scenario routes not scoped to their proposal; scenario prices unvalidated | Fixed | Scoped; positive, rounded |
| BUG-021 | P2 | State machine | Justification editable after lock; notes/justification changes unaudited | Fixed | Justification follows the lock; audited |
| BUG-022 | P2 | Input | Contracts/accounts/memberships/entries: `String(undefined)` → "undefined" names, negative prices, inverted dates, arbitrary status/type strings, reactivating terminated contracts, entries on terminated contracts, currency mismatch | Fixed | Validators in `src/lib/api.ts`; contract state rules |
| BUG-023 | P2 | Governance | A cross could be APPROVED on one signature, with equivalence NONE, or with an invented status | Fixed | Both reviews required; enums enforced |
| BUG-024 | P2 | Input | Intake accepted negative and implausible quantities/prices | Fixed | Skipped with a reason |
| BUG-025 | P2 | Security | CSV exports did not neutralise formula injection (`=HYPERLINK(...)` in a competitor description) | Fixed | Apostrophe-prefix for string cells |
| BUG-026 | P2 | Proposals | Proposal could be created from a request still running; duplicate drafts on double-click; retired SKUs quoted; a failure mid-creation left a partial proposal | Fixed | Guards + compensating delete |
| BUG-027 | P2 | State machine | `validThrough` never enforced — expired approved proposals exportable/pushable/winnable | Fixed | `canFinalize` checks expiry (WON exempt) |
| BUG-028 | P2 | Import | Cost import: wrong permission (`configure_pricing_rules`), no validation, duplicate rows on re-import | Fixed | `import_cost_data`; `src/lib/imports/costs.ts` idempotent |
| BUG-029 | P2 | Data | Won → contract created contract, entries and commitments in separate writes, and the outcome was recorded before the contract | Fixed | Transaction; contract first |
| BUG-030 | P2 | Data | Deleting a request with proposals orphaned them (`SetNull`) | Fixed | 409 when proposals exist; audited |
| BUG-031 | P2 | Authorization | Request-line PATCH accepted a candidate id from another request | Fixed | Candidate must belong to the line |
| BUG-032 | P2 | Config | Ranking weights / maxCandidates unvalidated (negative, NaN, 10⁹) | Fixed | Bounds |
| BUG-033 | P2 | Performance | Requests list and overview loaded every candidate of every line of every request | Fixed | Selected candidate only, `take: 200` |
| BUG-034 | P2 | Security config | No security headers; `X-Powered-By` on | Fixed | nosniff, DENY framing, referrer policy, `Cache-Control: private, no-store` |
| BUG-035 | P2 | UI | After a refused mutation the workspace/queue kept stale state | Fixed | Reload on refusal |
| BUG-036 | P2 | Input | No upload/paste size caps; request line count unbounded | Fixed | 20 MB / 5 MB / 5,000 lines |
| BUG-037 | P2 | Audit | Competitor corrections, catalog adoption/prune, size imports, settings changes, pricing imports, request deletion were unaudited | Fixed | Audit events added |
| BUG-038 | P2 | Import | Pricing import accepted negative list/COGS; unusable cells skipped silently | Fixed | Validated, reported |

## Critical / high bugs

### BUG-001 — Unguarded legacy routes (P0)
*Symptoms.* `curl /api/requests/<id>/export` with no cookie returned the rep workbook (COGS-fit and margin-fit columns); `curl -X POST /api/pricing/import` accepted a COGS file; `POST /api/settings` changed ranking weights and the company name.
*Root cause.* The v0.4 authorization layer (`handle()`) was applied to the new commercial routes; the v0.3 routes were never migrated, and nothing enforced a default-deny.
*Impact.* Anonymous read of cost/margin-derived data and customer lists; anonymous writes to cost data and settings.
*Fix.* `src/proxy.ts` refuses any `/api/*` request without a session (except `/api/auth/*`) — defence in depth so a forgotten route fails closed. Each legacy route now calls `authorize(permission)`; new permissions `import_cost_data` and `configure_settings`. Request payloads and workbooks redact cost/margin for roles without the permission.
*Regression test.* `test-adversarial` (permission cases) and the role smoke run in this report (anonymous 401 on all API paths; clinical 403 on pricing routes; rep 403 on cost import and settings).

### BUG-002 — Forgeable session (P0)
*Reproduction.* `GET /api/auth/dev` lists user ids; set `crosswalk_dev_user=<admin id>` → admin.
*Fix.* Cookie value is `<id>.<HMAC-SHA256(id, SESSION_SECRET)>`, constant-time compared; production builds without SSO refuse dev sessions unless `ALLOW_DEV_SIGNIN=true`. *Test:* "a bare user id is not a session".

### BUG-003 — Stale approval chain (P0)
*Reproduction.* Submit a 3-line proposal (stapler → committee, trocar → manager). Committee returns CHANGES_REQUESTED on the stapler → proposal unlocks. Rep reprices the trocar from $80 to $70 (30 % off contract, needs a contracting manager). Manager approves the trocar request they saw at $80 → line APPROVED at $70 → proposal APPROVED → exportable.
*Root cause.* `decide()` trusted the request, not the line; `setProposedPrice` reset the line's state but left the request pending.
*Fix.* Snapshot price must equal the current price or the request is withdrawn and the caller told to resubmit; any price/inclusion change withdraws pending requests. *Test:* "CHAIN: changes-requested on one line must not let a repriced sibling line be approved against a stale snapshot".

### BUG-005/006/007 — Approval state and races (P1)
Resubmission superseded only PENDING requests, so a REJECTED/CHANGES_REQUESTED decision from round one made round two's status permanently non-APPROVED. Decisions and submissions were read-then-write; two approvers or a double click both won. Fixes: supersede all live requests on submit/reopen; atomic `updateMany` claims; compensating rollback of a half-routed submission. *Tests:* "resubmission after changes-requested…", "two managers deciding…", "double submit…".

### BUG-008 — Overflow after write (P1)
`marginPct` for $0.01 against $300 cost is −29,999 (−2,999,900 %); `Decimal(9,6)` overflowed on the *second* statement, after the price landed. Fix: columns widened, `toDbPct` clamps at ±999,999, and price + derived fields are computed first and written in one statement. *Test:* "negative, zero, NaN and absurd prices are refused; a 100% discount needs the committee".

### BUG-012 — Quote ≠ approved ≠ contract (P1)
`quoteRows` accumulated `total += ext` in floats and rounded with `Math.round(x*100)/100`; a rep could store $296.1222, the quote showed $296.12, the WON contract carried $296.1222. Fix: decimal totals, banker's rounding at the minor unit, and prices rounded when stored so approved = exported = contracted. *Test:* e2e "CRITICAL SCENARIO" and adversarial "exported quote carries exactly the approved prices".

### BUG-013 — UOM chain (P1)
A single rep-observed "$24,000 per case" at the account became the known-account price; MATCH/UNDERCUT then recommended relative to a case price for a per-unit line. Fix: `summarize()` only uses observations in the context's UOM and says how many were excluded. *Test:* "competitor intelligence: an absurd observation (case price as unit price)…".

### BUG-014 — Company rename (P1)
`getCompany()` upserted by name; changing `companyName` in Settings created a second Company and every product/request belonged to the old one. Fix: rename in place; single-tenant fallback. *Test:* "renaming the company keeps the catalog".

### BUG-017 — O(n) round trips (P1)
Measured on the isolated branch from the sandbox (≈60 ms RTT): recompute 300 lines 70.6 s → 0.38 s; scenario create 20.7 s → batched; scenario apply → 0.7 s; submit 63.4 s → 6.9 s (remaining cost is one create + one audit per routed request).

## Medium / low bugs
Grouped by family: **input validation** (BUG-019, 022, 024, 032, 036, 038) — every route body now goes through the validators in `src/lib/api.ts` and domain errors are 400s with a sentence, never 500s with a stack; **scoping/IDOR** (016, 020, 031) — every child id is checked against its parent; **state machines** (021, 026, 027, 029, 030) — proposals cannot be created from incomplete requests, cannot exist twice as drafts, cannot quote retired SKUs, cannot be exported past `validThrough`, cannot lose their request; **governance** (023); **audit coverage** (037); **security hygiene** (025, 034, 018); **performance** (033); **UI** (035).

## Bug chains discovered
1. **Changes-requested → unlock → sibling reprice → stale approval → export of an unreviewed price** (BUG-003 + 005). Two defects combined: the unlock was correct, the request lifecycle was not tied to the line.
2. **Case-price observation → KNOWN_ACCOUNT → recommendation anchored to a case price → 90 % "discount" → below-floor approval triggered / or a wildly high price recommended** (BUG-013).
3. **Rename company in Settings → new Company row → catalog "empty" → re-seed creates a second catalog → cross-references match nothing** (BUG-014).
4. **Purchase file re-imported → invoice number read from the date column → idempotency collides on the date → conversion double counts, then *loses* rows once idempotency keyed on the wrong value** (BUG-011; the second half was introduced by the first version of the fix and caught by the test — see third pass).
5. **Sub-cent proposed price → stored 4 dp → quoted 2 dp → WON contract at 4 dp → next waterfall resolves a price the customer never saw** (BUG-012).
6. **Policy draft with minMargin 1.0 → floor undefined → below-floor rule never fires → committee never consulted** (BUG-015).
7. **Extreme price → overflow after the price write → line with new price and old margin → economics rollup skipped → deal summary disagrees with the line** (BUG-008).

## Security findings
*Authentication.* Development sign-in only; now signed and production-guarded. SSO remains an adapter contract (`x-sso-subject` from a trusted proxy) — an unauthenticated proxy header would be trusted, so SSO must be enabled only behind an authenticating reverse proxy that strips inbound `x-sso-subject`.
*Authorization.* Default-deny at the edge for APIs; per-route permissions; server-side redaction of cost, margin, floor in lines, economics, audit payloads, recommendation JSON and prose, request payloads and workbooks. **Not implemented:** horizontal scoping — every rep sees every account, request and proposal (single-tenant, one sales organisation). Documented as a decision for the business, not a defect fixed here. ADMIN may decide its own request (by design; audited).
*Data isolation.* Single tenant. No cross-tenant surface exists.
*Sensitive information.* The shared Neon dev connection string was present in a local `.env` and in an earlier session transcript; **rotate the `crosswalk_owner` password before any external sharing** and use Neon branches per environment.
*Injection.* Prisma parameterised throughout; the one raw statement (`bulkWriteDerived`) uses tagged `Prisma.sql` parameters. CSV formula injection fixed; ExcelJS writes strings as strings.
*Browser security.* Cookies `httpOnly; sameSite=lax; secure` (prod). Security headers added. No CSP yet (Tailwind inline styles would need nonces).
*API security.* Driver errors sanitised; body validation; upload caps; conflict semantics (409). No rate limiting.

## Financial integrity findings
Money is `Decimal(18,4)` in the database and `decimal.js` in code; `src/lib/money.ts` is the single arithmetic point, and after this run no `+=`/`Math.round` money arithmetic remains in `src/lib` (verified by grep; the remaining `toNumber()` calls are policy-fraction comparisons with an epsilon). Verified by test: 0.1 + 0.2 = 0.3; banker's rounding at $0.005/$0.015/$0.025; $999,999.99 × 1,000,000 exact; zero cost → 100 % margin; zero price → margin undefined (never Infinity); negative margins reported; 100 % and >100 % discounts; margin (price−cost)/price is never confused with markup (there is no markup function). Waterfall: contracts starting today apply, ending today apply until midnight, tomorrow's and yesterday's do not; equal precedence picks the lowest price and says so; EUR entries never price a USD question; pending entries never apply; recommendations never go below floor or above reference; missing cost → floor null, margin null, never zero. Prices are stored at the minor unit so quote, approval snapshot and won-contract entry are identical. Deal revenue equals Σ price × qty exactly (asserted in the critical scenario).

## Database findings
Two additive migrations: `20260915210000_widen_pct_columns` (`Decimal(9,6)` → `Decimal(12,6)` on three percent columns) and `20260915220000_purchase_external_index`. Transactions: won→contract is one transaction; submission has a compensating rollback; proposal creation has a compensating delete; line writes are single statements; decisions and submissions use conditional updates as optimistic locks. Idempotency: purchase (account + sku + invoice number), cost (natural key), CRM/ERP/GPO sync (external ref + hash), quote push (hash), GUDID import (record key). Indexes reviewed on every hot table; one added. Still relying on application checks rather than constraints: enum-valued `String` columns (status/type/level) — a CHECK constraint migration would be a reasonable follow-up.

## Performance findings
See BUG-017. Also fixed: list pages fetching every candidate (BUG-033). Remaining: analytics compute on read; runs, GUDID imports and syncs are in-process; the GET proposal payload for 300 lines is ~380 KB (acceptable).

## Tests added
* `scripts/test-adversarial.ts` (24 cases, `npm run test:adversarial`, now in CI): signed sessions; money edge cases; waterfall dates/ties/currency/approval state; recommendation bounds and missing cost; UOM mismatch; submit routing and lock; the stale-approval chain; resubmission after changes-requested; export equals approved prices; role denials; concurrent decisions; double submit; parallel edits; invalid prices; closed-proposal outcome; intake sanitation and CSV injection; audit/nested redaction; cross approval rules; import idempotency; policy validation; company rename; proposed-cross validation; expiry enforcement.
* `scripts/test-enterprise.ts`: new "CRITICAL SCENARIO" step (export equals approved, totals equal line sum, every approved line reconstructible with floor/margin/policy, crosswalk pinned, post-approval mutation refused, unauthorized export/redaction).
* `scripts/check-enterprise.ts`: `canFinalize` expiry cases.

## Files changed (important)
`src/proxy.ts` (new), `src/lib/auth/index.ts`, `src/lib/auth/permissions.ts`, `src/lib/api.ts`, `src/app/layout.tsx`, `src/components/sign-in.tsx` (new), all 15 legacy routes under `src/app/api/`, `src/app/api/proposals/**`, `src/app/api/contracts/**`, `src/app/api/accounts/**`, `src/app/api/audit`, `src/app/api/intelligence`, `src/app/api/costs/import`, `src/app/api/purchases/import`, `src/lib/approvals/{service,rules}.ts`, `src/lib/proposals/{service,outcome,export}.ts`, `src/lib/pricing/{recommend,policy,policy-model}.ts`, `src/lib/intelligence/summarize.ts`, `src/lib/xref/governance.ts`, `src/lib/settings.ts`, `src/lib/money.ts`, `src/lib/sheets/csv.ts`, `src/lib/excel/{intake,export,pricing}.ts`, `src/lib/imports/{costs,purchases}.ts` (new), `src/lib/requests.ts`, `src/lib/integrations/sync.ts`, `next.config.ts`, `prisma/schema.prisma` + 2 migrations, `.github/workflows/ci.yml`, `.env.example`, `README.md`.

## Remaining risks
*Confirmed, deliberately not changed (needs a business decision):* no rep/territory ownership scoping; ADMIN self-approval.
*Suspected risk:* `proxy.ts` only checks cookie presence — the route still validates, but a future route that skips `handle()` would be reachable by any signed-in user; the e2e suite publishes a crosswalk version on each run (v25 on the dev DB) — harmless but noisy.
*Architectural debt:* in-process jobs; analytics on read; enum columns without CHECK constraints; no CSP; no rate limiting; no proposal-context drift warning (a draft created before a GPO/contract change keeps its snapshot silently, by design — but the UI does not say the live context moved).
*Integration not testable:* Salesforce, SAP, SSO (skeletons); openFDA rate limits under a full-company import.
*Dependencies:* `npm audit` reports `uuid < 11.1.1` via `exceljs` (moderate), `deepmerge-ts` via `prisma`'s config package (high, build-time only), `mysql2` (high, an unused transitive of Prisma's config) — none fixable without upstream releases; none reachable from user input.
*Feature not implemented:* SSO; ownership; CHECK constraints; job queue.

## Production readiness — READY FOR STAGING
The application now fails closed at the API edge, signs sessions, redacts commercially sensitive figures per role, keeps approvals tied to the price that was reviewed, survives concurrent approvers and double submits, produces quotes that equal the approved and contracted prices, and handles hostile input with 400s. It is not production-ready because identity is still a development mechanism (SSO must be implemented behind an authenticating proxy), there is no horizontal access control, background work is in-process, and the shared dev credential must be rotated. A staging deployment with `SESSION_SECRET` set, `ALLOW_DEV_SIGNIN=true` only for the pilot team, and a dedicated Neon branch is a sound next step.

## Recommended next steps (priority order)
1. Rotate the Neon `crosswalk_owner` password; create per-environment branches; set `SESSION_SECRET`.
2. Implement the SSO adapter (OIDC) and remove `ALLOW_DEV_SIGNIN` from any shared instance.
3. Decide and implement ownership scoping (rep → accounts/proposals; manager → territory).
4. Move runs, GUDID imports and syncs to a queue (pg-boss) with resumable stages.
5. Add CHECK constraints for status/type/level columns and a CSP.
6. Add rate limiting and structured request logging with request ids.
7. Keep `npm run test:adversarial` green in CI; add cases whenever a new mutation path is introduced.

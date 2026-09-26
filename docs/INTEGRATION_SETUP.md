# Integration setup guide

Everything in this guide is configured under **Settings → Integrations** (permission
`configure_settings`). No source change is needed to connect a company's Salesforce org, SAP
system, GPO rosters, OCR vendor, FX provider or contract-price files: the connectors, the mapping
engine, the review queue, the sync scheduler and the health model are built. What a company
supplies is credentials, endpoints, its own field names, and the people who own the data.

The app runs fully without any of this: manual imports, manual exchange rates, manual document
extraction and the labelled demo data keep working. Enabling an integration adds automation; it
never becomes a dependency.

Architecture, models and the "do not" rules: [INTEGRATION_ARCHITECTURE.md](INTEGRATION_ARCHITECTURE.md).

---

## Common to every integration

### The lifecycle

1. **Pick a provider** — the real system, a file location, or a clearly labelled *mock* (demo /
   test only; refused in production unless `INTEGRATIONS_ALLOW_MOCK=true`).
2. **Fill in the fields** — URLs, object names and options are stored as configuration;
   **secrets are sealed** (AES-256-GCM under `INTEGRATIONS_ENCRYPTION_KEY`) and are *never shown
   again*: the form displays "stored" and lets you replace or clear them. A secret may also be the
   reference `env:NAME`, which reads the value from the environment (and so from the configured
   `SECRETS_PROVIDER`) at use time instead of storing it.
3. **Map fields** — each canonical field can be overridden with the company's field name
   (`{ "gpoName": { "source": "GPO__c" } }`), a value map, a transform, a default or a constant.
   Defaults cover what a standard system provides; company-specific fields (GPO affiliation,
   territory, custom objects) have no default on purpose.
4. **Save** → status *configured*. Saving bumps the configuration version (every synced record
   remembers which version mapped it) and re-applies the schedule.
5. **Test connection** → *connected* (or the exact reason it is not: authentication, authorization,
   configuration, provider unavailable, timeout).
6. **Validate mapping** — against the canonical specs, or **against the provider** (field names
   are checked with the system's own describe / metadata where it can).
7. **Sync a test record** — pulls the first page only, writes it through the normal path, moves
   no watermark.
8. **Run sync now** (queued; one run per integration + sync type at a time) or **Full resync**
   (ignores the incremental watermark). File integrations also take an **Upload**.
9. **Schedule** — a 5-field cron expression (UTC). Leave blank for manual-only.
10. **Review queue** — anything the integration would not decide on its own (unmatched members,
    conflicting memberships, unknown competitors, ambiguous units, overlapping prices, low-confidence
    extractions) waits for a person. Nothing in the queue has been applied.

### Health states

`NOT_CONFIGURED` → `CONFIGURED` (saved, untested) → `CONNECTED` (test passed / last sync succeeded)
→ `DEGRADED` (partial run, rate limit or transient failure) → `ERROR` (authentication,
configuration or repeated failure) — and `DISABLED` when switched off. The last error, its category
and the time are shown on the card; they are redacted before storage.

### Sync jobs

Every run is an `IntegrationSyncJob`: `QUEUED → RUNNING → SUCCEEDED | PARTIAL | FAILED | CANCELLED`
with counters (received / created / updated / unchanged / errors / to review), the cursor before and
after, and row-level errors (`IntegrationSyncError`: entity, external id, category, message). A row
that cannot be applied never stops the run and is never silently dropped — it is a row error or a
review item. A connection failure fails the run and leaves the watermark where it was.

### Idempotency

Inbound records are keyed by `(system, entityType, externalId)` in `ExternalRef` with a payload hash,
so re-running a sync changes nothing unless the source changed. Outbound quotes use the proposal id
as the idempotency key: a retry updates the same CRM quote. Webhook events are deduplicated by event
id. FX rates and GPO memberships are effective-dated; history is closed, never rewritten.

### Security

- Reading or changing any integration configuration, mapping, log or manual sync requires
  `configure_settings` (server-side, on every route). Reading the review queue needs `view_pricing`;
  resolving roster items needs `manage_contracts`, contract-price items `import_competitor_pricing`,
  document items `verify_competitor_pricing`.
- Secrets are never returned by any API, logged, or written to the audit trail (the audit records
  *which* secret fields changed, not their values).
- Webhooks authenticate with an HMAC-SHA256 signature over the raw body; unsigned or mis-signed
  requests are rejected before anything is parsed.
- Every external value goes through the mapping engine's validation (types, enums, required
  fields) before it reaches a writer.

### Observability

Structured log events: `integration.configured`, `integration.test` / `integration.test_failed`,
`integration.sync.start` / `.done` / `.failed`, `integration.http` / `integration.http_error` / `integration.http_failed` (status, attempts,
latency, retry-after — no headers or bodies), `integration.webhook.received` /
`.duplicate` / `.rejected`, `integration.quote_writeback` / `_failed`, `fx.rate_restated_ignored`,
`documents.extracted` / `.extraction_failed`. None carries a credential.

### Environment

| Variable | Purpose |
| --- | --- |
| `INTEGRATIONS_ENCRYPTION_KEY` | 32-byte key (64 hex or 44 base64 chars) that seals stored secrets; any other length is refused. Required in production; outside production a key derived from `SESSION_SECRET` stands in. Rotate by setting the new key and re-saving each integration's secrets: until then the integration reads as `NOT_CONFIGURED` with "Stored integration secrets cannot be decrypted … re-enter them", the settings page still opens (`secretsUnreadable` on the detail), a save that supplies no secret values keeps the old sealed blob untouched (restoring the previous key still recovers it), and a save that supplies them replaces it. A tampered blob fails the same way. |
| `SF_*`, `SAP_*` (retired) | The legacy `SF_LOGIN_URL` / `SF_CLIENT_ID` / … and `SAP_ODATA_BASE_URL` / … variables selected API skeletons that only ever threw `NotConfigured`; those files are gone. Leave the variables unset. While any is set and the matching integration is **not** enabled here, the legacy crm / erp syncs, the feeds and the CRM push refuse with a message naming the variables and this page — they never fall back to files or fixtures under credentials the operator believes are in use. |
| `INTEGRATIONS_ALLOW_MOCK` | `true` lets mock providers run on a production build (demo instances only). |
| `DOCUMENT_STORAGE_DIR` | Where uploaded document bytes are kept (default `./.data/documents`). |
| `JOBS_WORKER` | `inline` (default) runs scheduled syncs in the web process; `external` in a dedicated worker. |

---

## 2.1 Salesforce (CRM)

1. **Purpose and data flow** — Accounts, hierarchy (ParentId), type, territory, segment, region,
   currency, strategic flag, owning rep (matched to a Crosswalk user by email), GPO affiliation and
   tier, opportunities and optionally contacts come *in*; approved proposals go *out* as quotes.
   Canonical records: `AccountImportRecord`, `OpportunityImportRecord`, `ContactImportRecord`,
   `GpoAffiliationRecord`, `QuoteWriteback`.
2. **Required from the company** — a Connected App (consumer key + secret, or a certificate for
   the JWT bearer flow); a run-as integration user with read on Account / Opportunity / Contact and
   create/edit on the quote objects; which field (or related object) carries GPO affiliation and
   tier; territory / segment / strategic-flag field names if they differ from the defaults; the
   quote and quote-line object and field names (or the CPQ objects); a sandbox for the first test.
3. **Credentials and permissions** — *Client credentials*: Connected App with "Enable Client
   Credentials Flow" and a run-as user. *JWT bearer*: upload the certificate to the Connected App,
   pre-authorise the user's profile, paste the PKCS8 private key. The secret may be `env:SF_CLIENT_SECRET`.
4. **Configuration fields** — Login URL (`https://login.salesforce.com`, `https://test.salesforce.com`
   or My Domain), API version, OAuth flow, consumer key / secret, username + private key (JWT),
   account filter (SOQL WHERE), page size, quote object, quote line object, *include margin in the
   quote* (off by default), GPO affiliation object + fields (only when affiliation is a related
   object), webhook shared secret.
5. **Field mapping** — entities `Account`, `Opportunity`, `Contact`, `Quote`, `QuoteLine`. The
   defaults use standard fields (`Name`, `AccountNumber`, `ParentId`, `Type` with a value map to
   Crosswalk account types, `Owner.Email`, `BillingState`, `CurrencyIsoCode`, `LastModifiedDate`).
   **`gpoName` / `gpoTier` have no default** — map them (`{"Account": {"gpoName": {"source":
   "GPO__c"}, "gpoTier": {"source": "GPO_Tier__c"}}}`). Quote / QuoteLine mappings are the field
   names on the company's quote objects (constants), e.g. `externalIdField: Crosswalk_Proposal_Id__c`
   — the external-id field is what makes write-back idempotent.
6. **Sync types and schedule** — `accounts` (accounts + hierarchy + affiliations), `opportunities`,
   `contacts`. Incremental by `LastModifiedDate` from the last successful run; a child whose parent
   arrives later is re-linked at the end of the run. Cross-run cursor: the watermark; in-run cursor:
   Salesforce `nextRecordsUrl`.
7. **Testing** — *Test connection* fetches API limits and describes Account, Opportunity and both
   quote objects, then reports every mapped field that does not exist in the org. *Validate against
   provider* does the same for the mapping alone. *Sync a test record* pulls one page.
8. **Webhook** — `POST /api/webhooks/salesforce`, body `{ "eventId": "…", "type":
   "account.changed", "accountIds": ["001…"] }`, header `X-Crosswalk-Signature: <hex HMAC-SHA256 of
   the raw body with the shared secret>`. Salesforce has no single webhook shape; relay Platform
   Events / Change Data Capture / Outbound Messages through a small middleware or a Flow HTTP
   callout. Duplicate event ids return `duplicate: true`; the named accounts are re-pulled in a
   webhook-triggered job; a retryable failure answers 503 so the relay retries.
9. **Quote write-back** — approved / won proposals only; the account must be linked to a Salesforce
   record; unchanged payloads are skipped by hash; changed payloads update the same quote (upsert by
   external id) and its lines (`<proposal id>-<line no>`); margin is written only when *include
   margin* is on. Failures are logged (`integration.quote_writeback_failed`), audited
   (`CRM_PUSH_FAILED`) and surfaced to the user.
10. **Errors and the review queue** — `AUTHENTICATION` (token refused; check the Connected App and
    flow), `AUTHORIZATION` (object/field access), `RATE_LIMIT` (`REQUEST_LIMIT_EXCEEDED`; the run
    becomes DEGRADED and retries later), `VALIDATION` (row errors — a record without a name, an
    opportunity whose account has not been synced), `DATA_CONFLICT` (an account number already linked
    to a different CRM record — fix in the CRM). Roster-sourced GPO memberships outrank the CRM
    affiliation field and are never overwritten by it.
11. **Mock provider** — three accounts (one IDN with a child), two opportunities, one contact;
    scenarios `ok`, `empty`, `auth-failure`, `timeout`, `rate-limit`, `unavailable`, `partial`
    (one nameless record), `malformed`, `duplicate`. Quote write-backs are recorded in memory so
    idempotency is observable.

## 2.2 SAP ERP (OData)

1. **Purpose and data flow** — Material master → `OwnProduct` (description, family, UOM, list
   price, status, discontinued); standard costs by plant / valuation area → `StandardCost`;
   list-price condition records → `PriceEntry` in an ERP pricebook; billing document items →
   `PurchaseRecord`. Canonical: `ProductImportRecord`, `StandardCostImportRecord`,
   `PriceEntryImportRecord`, `BillingImportRecord`.
2. **Required from the company** — Gateway URL and client; a technical user (basic) or OAuth
   client with read on the product, valuation, pricing-condition and billing services; service and
   entity-set names when the company uses custom (Z*) services; plant → region mapping; which
   condition types are list prices; field names where the company's views differ from the standard
   S/4 APIs.
3. **Credentials and permissions** — basic auth (technical user, password sealed or `env:SAP_PASSWORD`)
   or OAuth 2 client credentials (token URL, client id, secret). Read-only authorisations on the
   OData services are sufficient.
4. **Configuration fields** — base URL, OData version (v2 / v4), `sap-client`, auth mode and
   credentials, timeout, company code, page size (`$top`), plant → region JSON, list-price condition
   types, and per service: service path, entity set, change-date field (incremental), extra `$filter`.
5. **Field mapping** — entities `Material`, `Cost`, `Price`, `BillingDocument`; defaults follow the
   S/4 API names (`Product`, `ProductDescription`, `ProductGroup`, `BaseUnit`, `IsMarkedForDeletion`,
   `LastChangeDateTime`; `ValuationArea`, `StandardPrice`, `PriceUnitQty`; `ConditionRateValue`,
   `ConditionType`, `ConditionValidityStartDate`; `BillingDocument`, `SoldToParty`, `Material`,
   `BillingQuantity`, `NetAmount`, `BillingDocumentDate`). OData v2 `/Date(...)/` values are
   understood. Costs are divided by the price unit; billing net value ÷ quantity gives the unit price.
6. **Sync types and schedule** — `materials`, `costs`, `prices`, `billing`; incremental when a
   change-date field is set, otherwise full. Cursors are the OData next links inside a run and the
   watermark across runs. Sync materials before costs / prices / billing (unknown SKUs are row
   errors, not silent skips).
7. **Testing** — *Test connection* probes each configured service and entity set (`$top=1`) and
   checks the mapped field names on the first record.
8. **Webhook** — none (SAP is pulled on a schedule).
9. **Write semantics** — products are upserted by `(company, SKU)`; costs, price entries and
   purchases are keyed by natural keys (SKU + plant + effective date; SKU + condition + currency +
   effective date; billing document + item) and updated in place when the source changes.
10. **Errors** — `AUTHENTICATION` / `AUTHORIZATION` (Gateway), `PROVIDER_UNAVAILABLE` (5xx, retried
    with back-off, run DEGRADED), `TIMEOUT`, `VALIDATION` (material without a SKU, cost or price
    that is not positive, billing item with an unknown account or missing quantity), `NOT_FOUND`
    (a service path that does not exist — shown by the connection test).
11. **Mock provider** — three materials (one discontinued), three costs (two plants), two price
    conditions, one billing item; the same scenario switch.

## 2.3 GPO rosters (Premier, Vizient, HealthTrust)

1. **Purpose and data flow** — Member facilities, tiers and effective dates → `GpoMembership`
   (effective-dated; changes close the old row and open a new one; `externalMembershipId`,
   `memberName`, address and the importing job are kept). Canonical: `GpoMembershipImportRecord`.
   One integration per GPO (`gpo:premier`, `gpo:vizient`, `gpo:healthtrust`), each with a starting
   column profile.
2. **Required from the company** — roster access (portal export schedule, SFTP credentials or API
   credentials); the roster's column names; which column carries *our* account number (the strongest
   match key); whether a full roster may close memberships that are missing from it.
3. **Credentials and permissions** — file: a readable directory on the server or SFTP host + user +
   password / private key (`ssh2-sftp-client` is loaded on demand); API: bearer token, API-key
   header, basic, or none (IP allow-listed).
4. **Configuration fields** — file: location (directory / SFTP), directory, file-name pattern
   (newest match wins), worksheet, header row; API: endpoint, auth, records path, paging (next link /
   page parameter), page size, incremental parameter, extra query; common: *close memberships missing
   from a complete roster* (off by default).
5. **Field mapping** — entity `GpoMembership`: `externalMembershipId`, `accountNumber`,
   `accountExternalId`, `memberName`*, address, `tier`, `effectiveFrom`*, `effectiveTo`,
   `lastVerifiedAt`, `parentMemberName`. Profiles supply typical headers (`Premier Entity Code` /
   `Supplier Customer Number`, `Vizient Member ID` / `Supplier Account Number`, `COID` / `Vendor
   Account Number`) — correct them to the columns actually received.
6. **Sync types and schedule** — `memberships`. Files are always complete rosters; APIs are
   incremental when an incremental parameter is configured. Uploads from the screen run the same path.
7. **Testing** — file: the location is checked and the newest file named; API: the endpoint is
   called for one page; mock: the fixture.
8. **Reconciliation** — match by account number → CRM account id → a previous membership with the
   same external membership id. Unmatched members go to the review queue with name / postal-code
   suggestions (never auto-linked); in-file duplicates with differing data are flagged; a tier or
   date change closes the previous row at the new start date and opens a new one; a membership that
   would move to another account is a `DATA_CONFLICT`; a roster row that overlaps an open membership
   with a different tier is a `MEMBERSHIP_CONFLICT` for a person to accept (supersede) or dismiss;
   expired rows are kept as history. Stale memberships are closed only when the run was complete
   *and* the option is on.
9. **Review actions** — *Link* (choose the account), *Accept roster* (close the current membership,
   open the roster's), *Dismiss*.
10. **Errors** — malformed dates and missing required columns are row errors (the rest of the file
    still loads); an unreadable location or a rejected credential fails the run.
11. **Mock provider** — three members: one matching by account number, one unmatched (Pine Ridge),
    one expired tier overlapping an existing membership.

## 2.4 Document extraction (OCR / IDP)

1. **Purpose and data flow** — An uploaded invoice, PO, bid list or contract table →
   `DocumentExtraction` + `ExtractedField` rows (header and line fields, each with the reader's
   confidence and page) → human review → **verified** lines → competitor price observations (via
   the existing importer, with the *source type's* commercial confidence — extraction confidence is
   never commercial confidence). Canonical: `ExtractedDocument`.
2. **Required from the company** — whether to use a vendor at all (manual works without one); the
   vendor's endpoint, credentials and response shape; the review threshold policy.
3. **Credentials and permissions** — bearer token or API-key header for the HTTP provider; none
   for manual.
4. **Configuration fields** — provider `manual` (CSV/XLSX column mapping), `http` (endpoint, auth,
   multipart or base64-JSON encoding, file field, model id, extra body, timeout, response mapping:
   lines path, line field paths, per-line and per-field confidence paths, header field paths,
   overall confidence path, page path), `mock`; common: review threshold (0–1), *always route to
   review* (on by default).
5. **Field mapping** — for the manual provider, entity `Line` (`competitorSku`, `description`,
   `quantity`, `uom`, `unitPrice`, `extendedPrice`, `lineDate`, `manufacturer`, `tier`) with loose
   header matching. For the HTTP provider the response mapping plays this role.
6. **Sync types** — none; extraction is triggered per document (Competitor pricing → *Extract a
   document…*, `POST /api/documents/extract`).
7. **Testing** — *Test connection* calls the provider's health path (HTTP) or reports readiness.
8. **Review** — `/intelligence/extractions/<id>`: confirm, correct or reject every field; lines below
   the threshold or missing a required field are amber; *Finalise as verified* marks the extraction
   VERIFIED and resolves the queue item; *Import verified lines* records the observations (rejected
   cells are dropped, corrected values used).
9. **Routing rules** — any line below the threshold, any missing required field, no lines at all,
   an unknown overall confidence, or the *always review* policy → status REVIEW and a
   `LOW_CONFIDENCE_EXTRACTION` queue item; otherwise EXTRACTED (still requires verification before
   import).
10. **Errors** — a malformed vendor response is a `VALIDATION` failure recorded on the extraction
    (status FAILED); timeouts and 5xx are retried then recorded; nothing partial is ever imported.
11. **Mock provider** — a two-line invoice with header fields; *low confidence* halves every
    confidence; `partial` puts one line below the threshold.

## 2.5 Exchange rates

1. **Purpose and data flow** — Daily reference rates → `ExchangeRate` rows keyed by base, quote,
   date and provider. Conversions stay explicit: `convert()` uses a stored rate on or before the
   date and returns the rate row it used; nothing converts silently and no live rate is fetched in
   the middle of a pricing calculation. Canonical: `FxRateRecord`.
2. **Required from the company** — the currencies it prices in; whether a paid vendor is required
   (ECB is free, EUR-based, no key) and its credentials; the fallback policy for missing dates.
3. **Credentials and permissions** — none (manual, ECB) or bearer / API-key header / query key (HTTP).
4. **Configuration fields** — provider `manual`, `ecb` (base URL), `http` (endpoint template with
   `{base}` `{quote}` `{date}`, rate path, date path, auth), `mock`; common: base currencies, quote
   currencies, fallback (`fail` — recommended — or `previous-business-day`), max look-back days.
   **Missing-rate policy (canonical, one definition in `src/lib/integrations/fx/service.ts`):**
   `fail` — a date with no rate is an error, never a substituted current rate. With
   `previous-business-day` the lookup walks back at most *max look-back days* calendar days
   (default **5**, allowed 0–30: five covers a weekend plus a holiday on either side of it with one
   day to spare, e.g. Tue 29 Dec → Mon 28 (holiday) → weekend → Thu 24 (holiday) → Wed 23) and
   labels the conversion with the date it used and how many days earlier it was. A stored rate for
   the date always wins over the provider; a pair the provider does not publish is `NOT_FOUND`
   after the walk. The registry's form default and the service default are the same constant.
5. **Field mapping** — the HTTP provider's rate / date paths.
6. **Sync types and schedule** — `rates`: pull today's rate for every base × quote pair (schedule
   after the provider publishes, e.g. `30 16 * * 1-5` for ECB). Pairs the provider does not publish
   are reported as row errors, never invented.
7. **Testing** — the provider is asked for a recent USD/EUR rate.
8. **Manual entry** — always available under Settings → Exchange rates; manual rows coexist with
   provider rows for the same day and are preferred by the lookup.
9. **History** — a rate already stored for a provider and day is never overwritten; a restated
   value is logged (`fx.rate_restated_ignored`) and ignored. Every conversion records the rate row
   id it used.
10. **Errors** — a missing rate is `NOT_FOUND` with an actionable message (enter one manually or
    configure a provider); a rate the HTTP provider returns for another date is refused; provider
    failures fail the run (`AUTHENTICATION`, `PROVIDER_UNAVAILABLE`, `TIMEOUT`).
11. **Mock provider** — a fixed table (USD/EUR/GBP/CAD/JPY) with no weekend rates, so the missing-
    rate path is exercised.

## 2.6 Competitor GPO contract prices

1. **Purpose and data flow** — Contract-price files from marketing / contracting →
   `CompetitorPriceObservation` rows with `sourceType = GPO_CONTRACT_FILE` and contract provenance
   (`tier`, `contractRef`, `validTo`, `sourceSystem`, `sourceOwner`, `syncJobId`,
   `competitorDescription`) — the same intelligence model the summaries and recommendations read.
   Canonical: `CompetitorPriceImportRecord`.
2. **Required from the company** — who owns the files and where they land; the column names;
   competitor names as they appear in the files (aliases); UOM conventions.
3. **Credentials and permissions** — a readable directory or SFTP credentials; uploads need
   `configure_settings` (the screen) — resolving review items needs `import_competitor_pricing`.
4. **Configuration fields** — provider `file` (location, pattern, worksheet, header row, source
   owner, default GPO) or `mock`; common: extra UOM aliases (JSON), accepted currencies, unknown
   manufacturer policy (*review* — recommended — or *create*), keep already-expired prices as history.
5. **Field mapping** — entity `CompetitorContractPrice`: `gpoName`, `competitorName`*,
   `competitorSku`*, `description`, `price`*, `currency`, `uom`, `packSize`, `tier`,
   `effectiveFrom`, `effectiveTo`, `contractRef`, `sourceOwner`. Defaults expect `GPO`,
   `Manufacturer`, `Catalog Number`, `Description`, `Contract Price`, `UOM`, `Tier`, `Effective
   Date`, `Expiration Date`, `Contract Number`.
6. **Sync types and schedule** — `prices` (newest file at the location, or an upload).
7. **Testing** — the location is checked and the newest file named.
8. **Validation** — missing SKU / manufacturer / price, non-positive price, invalid currency,
   malformed dates, expiration before effective date → row errors. Unknown UOM → `PRICE_EXCEPTION`
   (add an alias); unknown manufacturer → `UNKNOWN_COMPETITOR` (with name suggestions; *Create
   competitor and record* from the queue); unknown GPO → `PRICE_EXCEPTION`; a row repeated within the
   file → `DUPLICATE`; the same contract / tier / effective date already recorded with a **different**
   price → `PRICE_EXCEPTION` (the recorded price stays; accepting records a new observation);
   overlapping validity for the same contract and tier → `OVERLAP`; already-expired prices are
   skipped (or kept as history when configured). An identical row already recorded is skipped, so
   re-running a file is safe.
9. **Review actions** — *Record anyway* (accept the row as a new observation — history untouched),
   *Create competitor and record*, *Dismiss*.
10. **Errors** — row errors are listed per job; an unreadable file fails the run.
11. **Mock provider** — three rows (Covidien and Ethicon on Vizient and Premier contracts);
    `partial` adds a row with no price and the unit "bundle"; `duplicate` repeats the first row.

---

## Company onboarding checklist

### Built by the software (nothing to do)

- Provider adapters: Salesforce REST (client-credentials / JWT), SAP OData v2 / v4, GPO roster
  files (CSV / XLSX, directory / SFTP / upload) and JSON APIs, HTTP document extraction, manual
  extraction, ECB and HTTP FX providers, contract-price files — plus a labelled mock for each.
- Canonical models with provenance, the configurable mapping engine with validation (dry and live),
  the sealed-secret configuration store with `env:` references, the health model, sync jobs with
  counters and row-level errors, idempotent writers, the review / exception queue with resolution
  actions, per-integration cron schedules, the webhook receiver with signature verification and
  event dedupe, quote write-back with idempotency keys, structured logs and audit, the Integration
  Settings screen and the extraction review screen, automated unit and database tests for every
  integration and failure mode.

### Required from the customer

| Integration | What the company provides |
| --- | --- |
| Salesforce | Connected App key + secret (or certificate) · run-as user with object permissions · the GPO affiliation / tier field · territory / segment / strategic field names if custom · quote + quote-line object and field names · a sandbox |
| SAP | Gateway URL + client · technical user or OAuth client with read on product, valuation, pricing-condition and billing services · custom service / entity names if any · plant → region · list-price condition types |
| GPO rosters | Premier / Vizient / HealthTrust roster access (export, SFTP or API) · column names · which column is our account number · close-missing policy |
| Documents | Whether to use an OCR / IDP vendor · endpoint, credentials, response shape · review threshold |
| FX | Currencies in use · vendor + key if not ECB · fallback policy |
| Contract prices | File owner and location · column names · competitor aliases · UOM conventions |

### Order of work for a new company

1. Set `INTEGRATIONS_ENCRYPTION_KEY` (and `SECRETS_PROVIDER` if secrets live in a vault).
2. Salesforce: configure → test → validate against provider → map GPO field → sync a test record →
   run `accounts` then `opportunities` → schedule.
3. SAP: configure → test → run `materials` → `costs` → `prices` → `billing` → schedule.
4. GPO rosters: configure each GPO → upload the current roster → work the review queue → schedule.
5. Contract prices: configure → upload the current file → work the review queue.
6. FX: choose ECB unless the company mandates a vendor → schedule after publication time.
7. Documents: start with *manual*; add a vendor when one is chosen; keep *always review* on until
   its accuracy is known.
8. Turn on the Salesforce webhook relay once scheduled syncs are stable.

# Integration architecture

How Crosswalk talks to the systems around it — CRM, ERP, GPO rosters, document
extraction, FX rates and competitor contract-price files — without the core of the
application knowing which vendor sits on the other side. Setup for a specific company is
in [INTEGRATION_SETUP.md](INTEGRATION_SETUP.md); this document is the design.

## The boundary

```
External system ──► Provider adapter ──► Validation / mapping ──► Canonical import record
                    (vendor-specific)     (configuration)          (src/lib/integrations/types.ts)
                                                                          │
                                                                          ▼
                                                                  Domain writers ──► Database
                                                                  (src/lib/integrations/sync.ts,
                                                                   intelligence, catalog, fx)
```

Three rules hold everywhere:

1. **Domain code sees canonical records only.** `AccountImportRecord`, `ProductImportRecord`,
   `StandardCostImportRecord`, `PriceEntryImportRecord`, `BillingImportRecord`,
   `GpoMembershipImportRecord`, `CompetitorPriceImportRecord`, `ExtractedDocument`,
   `FxRateRecord`. No Salesforce, SAP, Premier or vendor field name appears south of the
   adapter. The writers in `sync.ts` are the same ones the file feeds and the dev fixtures
   have always used; a real adapter is just another producer of the same records.
2. **Company-specific knowledge is configuration, not code.** Credentials, base URLs,
   service names, object names, field mappings, plant/region/tier/UOM tables and
   schedules live in `IntegrationConfig` rows (secrets encrypted) edited from Settings →
   Integrations. Adding a company means filling forms, not editing adapters.
3. **Nothing depends on a live integration.** Every integration has `manual`/`file` and
   `mock` providers; with nothing configured the application runs on manual entry, CSV
   import and demo data exactly as before.

## Layout

```
src/lib/integrations/
  core/
    errors.ts        IntegrationError + categories (AUTHENTICATION, AUTHORIZATION, CONFIGURATION,
                     MAPPING, VALIDATION, RATE_LIMIT, PROVIDER_UNAVAILABLE, TIMEOUT, DATA_CONFLICT)
    http.ts          fetch wrapper: timeouts, retry with backoff + Retry-After, error classification,
                     structured logs without headers or bodies, test seam
    mapping.ts       the mapping engine: FieldMap → canonical record, transforms, value maps, validation
    fields.ts        FieldSpec: how a provider describes its configuration to the UI and the validator
    config.ts        IntegrationConfig read/write, secret encryption (AES-256-GCM), `env:VAR` references,
                     redaction for API responses
    health.ts        status model (NOT_CONFIGURED … DISABLED) and its transitions
    jobs.ts          IntegrationSyncJob lifecycle, row-level errors, counters, cursors
    review.ts        the review queue (unmatched accounts, conflicts, duplicates, low-confidence
                     extraction, price exceptions)
    registry.ts      every integration: providers, fields, sync types, factories
    contracts.ts     the adapter interfaces
    webhooks.ts      signature verification + idempotent receipt for inbound events
  salesforce/        auth (client-credentials, JWT bearer), REST/SOQL client, mapping defaults,
                     CRMAdapter, quote write-back, webhook handler, mock
  sap/               OData client (v2/v4), service mapping, ERPAdapter, mock
  gpo/               roster framework: file (CSV/XLSX, feed dir, upload, SFTP) and API modes,
                     Premier/Vizient/HealthTrust profiles, reconciliation, mock
  documents/         DocumentExtractionProvider: manual, generic HTTP/JSON provider, review routing, mock
  fx/                FxRateProvider: manual, ECB, generic HTTP, conversion recording, mock
  competitor-contracts/  file/API ingestion of competitor GPO contract prices → price observations, mock
  types.ts           canonical records (existing, extended with provenance)
  sync.ts            domain writers (existing; now take an adapter + job context)
  file.ts, dev.ts    existing file-feed and fixture adapters (kept)
```

## Configuration and secrets

`IntegrationConfig` (one row per integration key: `salesforce`, `sap`, `gpo:premier`,
`gpo:vizient`, `gpo:healthtrust`, `documents`, `fx`, `competitor-contracts`) holds:

- `provider` — which implementation (`salesforce` / `odata` / `api` / `file` / `http` / `ecb`
  / `manual` / `mock`); the registry says which providers each integration offers.
- `configJson` — non-secret settings (URLs, versions, object and service names, plant and
  tier tables, schedules), validated against the provider's `FieldSpec`s.
- `secretsJson` — secrets encrypted at rest with AES-256-GCM under
  `INTEGRATIONS_ENCRYPTION_KEY` (or, outside production, a key derived from
  `SESSION_SECRET`). A secret may instead be the reference `env:NAME`, which resolves
  from the environment — and therefore from `SECRETS_PROVIDER` — at use time, so a
  company that keeps secrets in Vault never stores them in the database at all.
- `mappingJson` — the field mappings, versioned (`configVersion` increments on every save).
- health columns — status, last test, last successful connection, last successful sync,
  last attempt, last error and its category.

API responses never include secret values: the config endpoint returns `{ set: true }`
per secret field. Saving with a secret field omitted keeps the stored value; sending an
empty string clears it. Reading and writing configuration needs `configure_settings`;
starting a sync needs `configure_settings` too; the review queue needs `view_pricing` to
read and `manage_contracts` / `import_competitor_pricing` (by kind) to resolve.

## Sync jobs and idempotency

Every sync is an `IntegrationSyncJob` (integration, provider, sync type, trigger, status
QUEUED → RUNNING → SUCCEEDED | PARTIAL | FAILED | CANCELLED, counters, cursor before/after,
error summary) with `IntegrationSyncError` rows for row-level failures. Jobs run on the
existing pg-boss `integration.sync` queue, one at a time per integration (`singletonKey`),
on the integration's cron or on demand.

Idempotency is the existing `ExternalRef` mechanism: (system, entity type, external id) →
internal id, with a payload hash so unchanged records are skipped. `ExternalRef` now also
records the sync job, mapping version and the source's own timestamp. Outbound writes
(quote push) carry an idempotency key — the proposal id — as the Salesforce external id
field, so a retried request after a timeout updates rather than duplicates.

## Health

`NOT_CONFIGURED` (no row or required fields missing) → `CONFIGURED` (fields valid, never
tested) → `CONNECTED` (last test or sync succeeded) → `DEGRADED` (last sync partial, or
last test older than the schedule) → `ERROR` (last test or sync failed) → `DISABLED`
(switched off). Transitions are made by the test and sync paths only.

## Errors

`IntegrationError` carries a category, a user-facing message that names the thing to fix
("configured GPO field `GPO__c` does not exist on Account"), whether it is retryable, and
an optional `providerRef` (a request id) — never headers, bodies or credentials. The HTTP
wrapper maps status codes to categories; adapters raise mapping and validation errors
themselves.

## Review queue

Records the system refuses to guess about become `IntegrationReviewItem`s: an unmatched
GPO member, a membership that conflicts with an open one, a duplicate or overlapping
contract price, an extraction below the confidence threshold, an unknown competitor. Each
carries the canonical record, a suggestion where one exists, and resolves to an action
(link to account, accept, dismiss). Nothing on the queue has touched master data.

## Mocks

Every integration has a `mock` provider that is a real adapter behind the same
interface, with a `scenario` setting: `ok`, `auth-failure`, `timeout`, `partial`,
`malformed`, `duplicate`, `rate-limit`, `empty`. Mocks are labelled in the UI and
refused as a production provider unless `INTEGRATIONS_ALLOW_MOCK=true`.

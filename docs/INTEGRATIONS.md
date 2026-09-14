# Integrations — boundaries, ownership, and what is still needed

## Systems of record

| Field / entity | System of record | Crosswalk keeps |
| --- | --- | --- |
| Account, parent/IDN, territory, segment, strategic flag, contact, rep | **CRM** (Salesforce) | `Account`, `Opportunity`, `User.externalId`, `ExternalRef` |
| GPO affiliation, tier, effective dates | **GPO membership feed** (or CRM field) | `Gpo`, `GpoMembership` (effective-dated; changes open new rows) |
| SKU master, description, family, UOM, list price, discontinued | **ERP** (SAP) | `OwnProduct` |
| Standard cost by plant/region, currency | **ERP** | `StandardCost` |
| Purchase / billing history | **ERP** | `PurchaseRecord` |
| Crosswalk versions, competitor price observations, pricing policies, proposals, recommendations, approvals, outcomes, audit | **Crosswalk** | everything else |

## Adapters (`src/lib/integrations/`)

* `types.ts` — `CrmAdapter`, `ErpAdapter`, `GpoAdapter` interfaces and DTOs. The domain only ever sees these.
* `dev.ts` — **DEVELOPMENT** adapters backed by JSON fixtures under `data/fixtures/integrations/` (`crm-accounts.json`, `crm-opportunities.json`, `erp-skus.json`, `erp-costs.json`, `erp-purchases.json`, `gpo-memberships.json`); quote pushes are written to `pushed-quotes/`. Records are tagged `system = "dev"`. Nothing here is a network call.
* `salesforce.ts`, `sap.ts` — skeletons that throw `NotConfigured` naming the credentials they need. They are selected automatically when their env vars exist.
* `sync.ts` — idempotent upserts keyed by (`system`, `entityType`, `externalId`) with payload hashes (unchanged records are skipped), 3-attempt exponential backoff, per-record `SyncLog`, partial-failure tolerance (one bad row never stops a feed), and the outbound quote push (`pushQuote`) which is skipped when the payload hash is unchanged.

## Still required from the organisation

| Integration | Needed | Notes |
| --- | --- | --- |
| **SSO** (Entra ID / Okta) | `SSO_ISSUER`, `SSO_CLIENT_ID`, and an authenticating reverse proxy (or an OIDC middleware) that sets `x-sso-subject`; a mapping of subjects to `User.externalId` | `src/lib/auth/index.ts` reads the header when SSO is configured. Until then the development sign-in is active and labelled. |
| **Salesforce** | `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` (or JWT bearer: `SF_JWT_KEY` + `SF_USERNAME`), `SF_API_VERSION`; agreement with the SF admin on the quote objects (custom `Crosswalk_Quote__c` / `Crosswalk_Quote_Line__c` or CPQ Quote); the field holding GPO affiliation (`Account.GPO__c`?) and the strategic-account flag | Implement `SalesforceCrmAdapter` against the REST API (`/services/data/vXX/sobjects`, `/query`); webhooks via Platform Events or Change Data Capture hitting `/api/integrations/salesforce/webhook` (route to add). |
| **SAP** | `SAP_ODATA_BASE_URL`, `SAP_CLIENT`, credentials (basic or OAuth); exposed OData services for material master (MARA/MAKT), condition prices (A-tables / SD pricing API), standard cost by plant (MBEW), billing documents (VBRK/VBRP) | Implement `SapErpAdapter`; map plant codes to the `plant` used by `StandardCost` and region codes to `Account.region`. |
| **GPO membership feed** | File drops or API from Premier / Vizient / HealthTrust (member roster with tier and effective dates), or the CRM field if the organisation maintains it there | `GpoAdapter.pullMemberships` contract; the dev adapter shows the shape. |
| **Competitor catalog sizes / prices** | Product marketing's competitor size master (Catalog → Competitor sizes); GPO contract price files for competitor products (import under Competitor pricing with source type GPO_CONTRACT_FILE) | Both imports exist; they need data owners. |
| **Document extraction** | A decision on an OCR/extraction provider if invoices and bid files should be parsed automatically | Today the `Document` model records provenance and `extractionConfidence` separately from commercial confidence; extraction itself is manual/CSV. |
| **Exchange rates** | A rate feed (ECB / Treasury / SAP TCURR) if non-USD contracts appear | `ExchangeRate` rows are entered manually today. |

## Sync operations

Settings → Integrations shows adapter status and lets a contracting manager trigger `crm`, `erp`, `gpo` syncs; `/api/integrations` lists recent `SyncLog` rows. Schedule the same calls from a job runner (see PRODUCTION_READINESS.md §3.1) once real adapters exist.

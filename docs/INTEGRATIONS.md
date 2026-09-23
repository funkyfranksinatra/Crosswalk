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

> **Tier 2 (Sept 2026):** real connectors are configured under Settings → Integrations — see
> [INTEGRATION_SETUP.md](INTEGRATION_SETUP.md) (per-integration setup) and
> [INTEGRATION_ARCHITECTURE.md](INTEGRATION_ARCHITECTURE.md) (design). The routes below remain as
> fallbacks: an enabled integration takes precedence over the legacy environment / file / dev adapters
> for the same system, and the "Sync now" buttons on Settings route to it.

## How to connect a system

There are three adapters per system and the app picks one automatically, in this order:

1. **Vendor API adapter** — selected when its credentials are in `.env` (`SF_LOGIN_URL` + `SF_CLIENT_ID` for Salesforce, `SAP_ODATA_BASE_URL` for SAP). Today these are *skeletons*: they document the contract and throw `NotConfigured`; an engineer implements `pullAccounts` / `pullSkuMaster` / … against the vendor API once the organisation grants access. Settings → Integrations shows "not implemented" when credentials are present but the adapter is a skeleton.
2. **File feed adapter** (`file.ts`) — selected when `INTEGRATION_FEED_DIR` points to a folder. This is the route most organisations can use immediately: Salesforce reports, SAP extracts and GPO member rosters are all exportable as CSV, and an iPaaS or a scheduled job can drop them into a share. Files and columns:

   | File | Columns |
   | --- | --- |
   | `crm-accounts.csv` | externalId, name, accountNumber, parentExternalId, type, territory, segment, region, country, currency, isStrategic, ownerEmail, gpoName, gpoTier |
   | `crm-opportunities.csv` | externalId, accountExternalId, name, stage, ownerEmail, closeDate, amount, currency |
   | `erp-skus.csv` | sku, description, productFamily, uom, listPrice, currency, status, discontinued |
   | `erp-costs.csv` | sku, plant, region, currency, costType, cost, effectiveFrom, effectiveTo |
   | `erp-purchases.csv` | externalId, accountExternalId, accountNumber, sku, quantity, netPrice, currency, invoiceDate, contractNumber |
   | `gpo-memberships.csv` | gpoName, gpoCode, accountExternalId, accountNumber, tier, effectiveFrom, effectiveTo, source |

   Extra columns are ignored; booleans accept true/yes/1. Approved quotes pushed "to CRM" are written to `<dir>/outbound/quotes/<reference>.json` for the CRM team or the integration job to load. Records are tagged `system = "file"`.
3. **Development adapter** (`dev.ts`) — fixtures under `data/fixtures/integrations/`, used when neither of the above is configured. Clearly labelled in the UI; never a network call.

All three feed the same idempotent sync (`sync.ts`): records are keyed by external id, unchanged payloads are skipped by hash, each attempt is logged, and accounts that already exist (seeded, created from a request, or from a purchase feed) are **linked by account number** rather than duplicated — an account number already bound to a different CRM record fails loudly instead of being overwritten. Switching from the file feed to the API adapter later changes nothing downstream.

**Who does what.** A contracting manager or admin sets `INTEGRATION_FEED_DIR` (or the API credentials) in `.env` and restarts the app; anyone with `manage_contracts` can press **Sync now** in Settings → Integrations, and the same calls (`POST /api/integrations/sync` with `{ system: "crm" | "erp" | "gpo" }`) can be scheduled from a job runner. Data owners keep the exports current.

## Adapters (`src/lib/integrations/`)

* `types.ts` — `CrmAdapter`, `ErpAdapter`, `GpoAdapter` interfaces and DTOs. The domain only ever sees these.
* `dev.ts` — **DEVELOPMENT** adapters backed by JSON fixtures under `data/fixtures/integrations/` (`crm-accounts.json`, `crm-opportunities.json`, `erp-skus.json`, `erp-costs.json`, `erp-purchases.json`, `gpo-memberships.json`); quote pushes are written to `pushed-quotes/`. Records are tagged `system = "dev"`. Nothing here is a network call.
* `file.ts` — CSV feed adapters for all three systems (see above).
* `salesforce.ts`, `sap.ts` — skeletons that throw `NotConfigured` naming the credentials they need. They are selected automatically when their env vars exist.
* `sync.ts` — idempotent upserts keyed by (`system`, `entityType`, `externalId`) with payload hashes (unchanged records are skipped), 3-attempt exponential backoff, per-record `SyncLog`, partial-failure tolerance (one bad row never stops a feed), and the outbound quote push (`pushQuote`) which is skipped when the payload hash is unchanged.

## Still required from the organisation

| Integration | Needed | Notes |
| --- | --- | --- |
| **SSO** (Entra ID / Okta / any OIDC provider) | An app registration with redirect URI `<APP_BASE_URL>/api/auth/oidc/callback`; `SSO_ISSUER`, `SSO_CLIENT_ID`, optionally `SSO_CLIENT_SECRET`, `SSO_ROLE_CLAIM` + `SSO_ROLE_MAP` for roles (`docs/DEPLOYMENT.md` § Identity) | Built in (`src/lib/auth/oidc.ts`): authorization code + PKCE, ID-token validation, user provisioning and role sync. `SSO_MODE=proxy` keeps the older contract where an authenticating proxy sets `x-sso-subject`. Until SSO is configured the development sign-in is active and labelled. |
| **Salesforce** | `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` (or JWT bearer: `SF_JWT_KEY` + `SF_USERNAME`), `SF_API_VERSION`; agreement with the SF admin on the quote objects (custom `Crosswalk_Quote__c` / `Crosswalk_Quote_Line__c` or CPQ Quote); the field holding GPO affiliation (`Account.GPO__c`?) and the strategic-account flag | Implement `SalesforceCrmAdapter` against the REST API (`/services/data/vXX/sobjects`, `/query`); webhooks via Platform Events or Change Data Capture hitting `/api/integrations/salesforce/webhook` (route to add). |
| **SAP** | `SAP_ODATA_BASE_URL`, `SAP_CLIENT`, credentials (basic or OAuth); exposed OData services for material master (MARA/MAKT), condition prices (A-tables / SD pricing API), standard cost by plant (MBEW), billing documents (VBRK/VBRP) | Implement `SapErpAdapter`; map plant codes to the `plant` used by `StandardCost` and region codes to `Account.region`. |
| **GPO membership feed** | File drops or API from Premier / Vizient / HealthTrust (member roster with tier and effective dates), or the CRM field if the organisation maintains it there | `GpoAdapter.pullMemberships` contract; the dev adapter shows the shape. |
| **GUDID (openFDA)** | Nothing — public; an `OPENFDA_API_KEY` (free) raises the rate limit from 240 to 1,000 requests/min and makes whole-labeler imports ~3× faster | Catalog → GUDID library imports one labeler at a time (Ethicon ≈ 6k records, Covidien ≈ 10k, Medtronic ≈ 88k across all businesses — narrow by product code). |
| **Competitor catalog sizes / prices** | Product marketing's competitor size master (Catalog → Competitor sizes); GPO contract price files for competitor products (import under Competitor pricing with source type GPO_CONTRACT_FILE) | Both imports exist; they need data owners. |
| **Document extraction** | A decision on an OCR/extraction provider if invoices and bid files should be parsed automatically | Today the `Document` model records provenance and `extractionConfidence` separately from commercial confidence; extraction itself is manual/CSV. |
| **Exchange rates** | A rate feed (ECB / Treasury / SAP TCURR) if non-USD contracts appear | `ExchangeRate` rows are entered manually today. |

## Sync operations

Settings → Integrations shows adapter status and lets a contracting manager trigger `crm`, `erp`, `gpo` syncs; `/api/integrations` lists recent `SyncLog` rows. Schedule the same calls from a job runner (see PRODUCTION_READINESS.md §3.1) once real adapters exist.

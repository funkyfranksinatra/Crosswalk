/**
 * The integration registry: one definition per integration key — its providers, the
 * configuration fields each provider needs (secrets flagged), the canonical mapping specs and
 * defaults, the sync types it offers, and the factory that turns a resolved configuration
 * into an adapter. The admin UI, the API and the sync runner are all driven from here; adding
 * a provider means adding an entry, not editing the UI.
 *
 * Nothing in this file is company-specific: field *names* of a company's Salesforce org, its
 * SAP services, the GPO's column headers and the OCR vendor's response shape all come from
 * IntegrationConfig rows.
 */
import type { FieldSpec } from "./fields";
import type { MappingBundle, MappingSpec } from "./mapping";
import { mergeMapping } from "./mapping";
import type { IntegrationKey, ResolvedConfig } from "./config";
import { ConfigurationError } from "./errors";
import { MOCK_SCENARIOS, mockAllowed, parseScenario } from "./mock";
import type { FileSource } from "./tabular";
import type { CRMAdapter, ERPAdapter, GpoRosterAdapter, DocumentExtractionProvider, FxRateProvider, CompetitorContractPriceAdapter, ConnectionTester } from "./contracts";

export type Family = "crm" | "erp" | "gpo" | "documents" | "fx" | "contracts";
export type ProviderDefinition = { id: string; label: string; description: string; mock?: boolean; fields: FieldSpec[] };
export type SyncTypeDefinition = { id: string; label: string; description: string; /** accepts an uploaded file instead of the configured source */ acceptsUpload?: boolean };

export type IntegrationDefinition = {
  key: IntegrationKey;
  family: Family;
  label: string;
  description: string;
  providers: ProviderDefinition[];
  /** fields shown for every provider */
  commonFields: FieldSpec[];
  mappingSpecs: Record<string, MappingSpec>;
  defaultMapping: MappingBundle;
  syncTypes: SyncTypeDefinition[];
  /** the integration can receive events (webhook route exists) */
  webhook?: { path: string; secretField: string };
  /** what the company must supply before this works (for the onboarding checklist) */
  requiredFromCustomer: string[];
};

// ---- shared field fragments ----------------------------------------------------------------------

const scenarioField: FieldSpec = { name: "scenario", label: "Mock scenario", type: "select", default: "ok", options: MOCK_SCENARIOS.map((s) => ({ value: s, label: s })), help: "MOCK PROVIDER — for demos and tests only. Never connects to a real system." };
const fileSourceFields = (prefix = ""): FieldSpec[] => [
  { name: `${prefix}sourceKind`, label: "File location", type: "select", required: true, default: "directory", options: [{ value: "directory", label: "Directory on the server (mounted share / drop folder)" }, { value: "sftp", label: "SFTP server" }], group: "Source" },
  { name: `${prefix}directory`, label: "Directory", type: "text", required: true, placeholder: "/data/feeds/premier", group: "Source" },
  { name: `${prefix}pattern`, label: "File name pattern", type: "text", required: true, default: "*.csv", help: "Newest file matching the pattern is used. *.csv, *.xlsx, roster-*.csv", group: "Source" },
  { name: `${prefix}sftpHost`, label: "SFTP host", type: "text", group: "SFTP (only when the location is SFTP)" },
  { name: `${prefix}sftpPort`, label: "SFTP port", type: "number", default: 22, group: "SFTP (only when the location is SFTP)" },
  { name: `${prefix}sftpUsername`, label: "SFTP username", type: "text", group: "SFTP (only when the location is SFTP)" },
  { name: `${prefix}sftpPassword`, label: "SFTP password", type: "secret", secret: true, group: "SFTP (only when the location is SFTP)" },
  { name: `${prefix}sftpPrivateKey`, label: "SFTP private key (PEM)", type: "multiline-secret", secret: true, group: "SFTP (only when the location is SFTP)" },
  { name: `${prefix}sheet`, label: "Worksheet name (xlsx)", type: "text", help: "Blank = first sheet", group: "Layout" },
  { name: `${prefix}headerRow`, label: "Header row", type: "number", default: 1, group: "Layout" },
];
const apiAuthFields = (modes: { value: string; label: string }[]): FieldSpec[] => [
  { name: "authMode", label: "Authentication", type: "select", required: true, default: modes[0].value, options: modes, group: "Authentication" },
  { name: "token", label: "Bearer token", type: "secret", secret: true, group: "Authentication", help: "For bearer auth. May be env:NAME to read from the environment / secrets provider." },
  { name: "apiKeyHeader", label: "API-key header name", type: "text", default: "X-API-Key", group: "Authentication" },
  { name: "apiKey", label: "API key", type: "secret", secret: true, group: "Authentication" },
  { name: "username", label: "Username", type: "text", group: "Authentication" },
  { name: "password", label: "Password", type: "secret", secret: true, group: "Authentication" },
];

// ---- 2.1 Salesforce -----------------------------------------------------------------------------

const SALESFORCE: IntegrationDefinition = {
  key: "salesforce", family: "crm", label: "Salesforce (CRM)",
  description: "Accounts, hierarchy, opportunities, contacts, territories and GPO affiliation in; approved proposals out as quotes.",
  providers: [
    { id: "salesforce", label: "Salesforce REST API", description: "Connected App with the client-credentials or JWT bearer flow.", fields: [
      { name: "loginUrl", label: "Login URL", type: "url", required: true, default: "https://login.salesforce.com", help: "https://test.salesforce.com for a sandbox, or the My Domain URL", group: "Connection" },
      { name: "apiVersion", label: "API version", type: "text", required: true, default: "v60.0", group: "Connection" },
      { name: "authFlow", label: "OAuth flow", type: "select", required: true, default: "client-credentials", options: [{ value: "client-credentials", label: "Client credentials (Connected App, run-as user)" }, { value: "jwt-bearer", label: "JWT bearer (certificate)" }], group: "Connection" },
      { name: "clientId", label: "Consumer key (client id)", type: "text", required: true, group: "Connection" },
      { name: "clientSecret", label: "Consumer secret", type: "secret", secret: true, help: "Client-credentials flow only. May be env:SF_CLIENT_SECRET.", group: "Connection" },
      { name: "username", label: "Integration username", type: "text", help: "JWT bearer flow only", group: "Connection" },
      { name: "privateKeyPem", label: "Private key (PKCS8 PEM)", type: "multiline-secret", secret: true, help: "JWT bearer flow only", group: "Connection" },
      { name: "accountFilter", label: "Account filter (SOQL WHERE)", type: "text", placeholder: "RecordType.DeveloperName = 'Healthcare_Facility'", group: "Scope" },
      { name: "pageSize", label: "Page size", type: "number", default: 500, group: "Scope" },
      { name: "quoteObject", label: "Quote object", type: "text", required: true, default: "Crosswalk_Quote__c", help: "The custom object (or CPQ object) approved proposals are written to", group: "Quote write-back" },
      { name: "quoteLineObject", label: "Quote line object", type: "text", required: true, default: "Crosswalk_Quote_Line__c", group: "Quote write-back" },
      { name: "pushMargin", label: "Include margin in the quote", type: "boolean", default: false, help: "Off by default: margin never leaves Crosswalk unless the company decides it should", group: "Quote write-back" },
      { name: "gpoAffiliationObject", label: "GPO affiliation object", type: "text", help: "Only when affiliation is a related object rather than a field on Account (e.g. GPO_Affiliation__c)", group: "GPO affiliation" },
      { name: "gpoAffiliationAccountField", label: "  → account lookup field", type: "text", default: "Account__c", group: "GPO affiliation" },
      { name: "gpoAffiliationGpoField", label: "  → GPO name field", type: "text", default: "GPO_Name__c", group: "GPO affiliation" },
      { name: "gpoAffiliationTierField", label: "  → tier field", type: "text", group: "GPO affiliation" },
      { name: "gpoAffiliationFromField", label: "  → effective-from field", type: "text", group: "GPO affiliation" },
      { name: "gpoAffiliationToField", label: "  → effective-to field", type: "text", group: "GPO affiliation" },
    ] },
    { id: "mock", label: "Mock Salesforce (demo / test)", description: "Fixture accounts and opportunities; records quote write-backs in memory.", mock: true, fields: [scenarioField] },
  ],
  commonFields: [
    { name: "webhookSecret", label: "Webhook shared secret", type: "secret", secret: true, help: "Sent by the org's outbound message / platform-event relay as X-Crosswalk-Signature (HMAC-SHA256 of the body). Leave empty to disable the webhook.", group: "Webhook" },
  ],
  mappingSpecs: {}, defaultMapping: {}, // filled below (lazy import avoids a cycle)
  syncTypes: [
    { id: "accounts", label: "Accounts + hierarchy + GPO affiliation", description: "Incremental by LastModifiedDate" },
    { id: "opportunities", label: "Opportunities", description: "Incremental by LastModifiedDate" },
    { id: "contacts", label: "Contacts", description: "Optional; incremental" },
  ],
  webhook: { path: "/api/webhooks/salesforce", secretField: "webhookSecret" },
  requiredFromCustomer: ["Connected App consumer key + secret (or certificate) with API scope", "Run-as integration user with read on Account/Opportunity/Contact and create/edit on the quote objects", "Which field holds GPO affiliation and tier (no default exists)", "Territory / segment / strategic-flag field names if they differ from the defaults", "Quote + quote-line object and field names (or CPQ objects)", "Sandbox org for the first test"],
};

// ---- 2.2 SAP -----------------------------------------------------------------------------------

const svc = (p: string, label: string, required: boolean, def: { service: string; entitySet: string; change?: string }): FieldSpec[] => [
  { name: `${p}Service`, label: `${label} service path`, type: "text", required, default: def.service, group: label, help: "Relative to the base URL" },
  { name: `${p}EntitySet`, label: `${label} entity set`, type: "text", required, default: def.entitySet, group: label },
  { name: `${p}ChangeDateField`, label: `${label} change-date field`, type: "text", default: def.change ?? "", group: label, help: "Enables incremental pulls; blank = full pull" },
  { name: `${p}Filter`, label: `${label} extra $filter`, type: "text", group: label },
];
const SAP: IntegrationDefinition = {
  key: "sap", family: "erp", label: "SAP ERP (OData)",
  description: "Material master, standard costs by plant, list-price conditions and billing documents.",
  providers: [
    { id: "odata", label: "SAP OData (S/4HANA / ECC Gateway)", description: "Basic or OAuth client-credentials against the Gateway.", fields: [
      { name: "baseUrl", label: "Gateway base URL", type: "url", required: true, placeholder: "https://sap.example.com:44300/sap/opu/odata/sap", group: "Connection" },
      { name: "odataVersion", label: "OData version", type: "select", required: true, default: "v2", options: [{ value: "v2", label: "v2 (ECC / most S/4 APIs)" }, { value: "v4", label: "v4" }], group: "Connection" },
      { name: "client", label: "SAP client (sap-client)", type: "text", placeholder: "100", group: "Connection" },
      { name: "authMode", label: "Authentication", type: "select", required: true, default: "basic", options: [{ value: "basic", label: "Basic (technical user)" }, { value: "oauth", label: "OAuth 2 client credentials" }], group: "Connection" },
      { name: "username", label: "Technical user", type: "text", group: "Connection" },
      { name: "password", label: "Password", type: "secret", secret: true, group: "Connection" },
      { name: "tokenUrl", label: "OAuth token URL", type: "url", group: "Connection" },
      { name: "clientId", label: "OAuth client id", type: "text", group: "Connection" },
      { name: "clientSecret", label: "OAuth client secret", type: "secret", secret: true, group: "Connection" },
      { name: "timeoutMs", label: "Request timeout (ms)", type: "number", default: 30000, group: "Connection" },
      { name: "companyCode", label: "Company code", type: "text", group: "Scope" },
      { name: "pageSize", label: "Page size ($top)", type: "number", default: 500, group: "Scope" },
      { name: "plantRegions", label: "Plant → region", type: "json", default: "{}", help: '{"1000":"US","2000":"EU"} — cost context by plant', group: "Scope" },
      { name: "listConditionTypes", label: "List-price condition types", type: "text", default: "PR00", help: "Comma-separated; blank accepts every condition type", group: "Scope" },
      ...svc("materials", "Materials", true, { service: "API_PRODUCT_SRV", entitySet: "A_Product", change: "LastChangeDateTime" }),
      ...svc("costs", "Standard costs", false, { service: "API_PRODUCT_SRV", entitySet: "A_ProductValuation" }),
      ...svc("prices", "List prices", false, { service: "API_SLSPRICINGCONDITIONRECORD_SRV", entitySet: "A_SlsPrcgConditionRecord" }),
      ...svc("billing", "Billing documents", false, { service: "API_BILLING_DOCUMENT_SRV", entitySet: "A_BillingDocumentItem", change: "CreationDate" }),
    ] },
    { id: "mock", label: "Mock SAP (demo / test)", description: "Fixture materials, costs, price conditions and billing items.", mock: true, fields: [scenarioField] },
  ],
  commonFields: [],
  mappingSpecs: {}, defaultMapping: {},
  syncTypes: [
    { id: "materials", label: "Material master", description: "Products, descriptions, families, UOM, status" },
    { id: "costs", label: "Standard costs", description: "By plant / valuation area" },
    { id: "prices", label: "List prices", description: "Price condition records" },
    { id: "billing", label: "Billing documents", description: "Invoiced sales as purchase records" },
  ],
  requiredFromCustomer: ["Gateway URL, client and a technical user (or OAuth client) with read on the product, valuation, pricing-condition and billing services", "Service + entity-set names when the company uses custom (Z*) services", "Plant → region mapping", "Which condition types are list prices", "Field names when the company's views differ from the standard S/4 APIs"],
};

// ---- 2.3 GPO rosters ----------------------------------------------------------------------------

function gpoDefinition(profileKey: "premier" | "vizient" | "healthtrust", label: string): IntegrationDefinition {
  return {
    key: `gpo:${profileKey}` as IntegrationKey, family: "gpo", label: `${label} roster`,
    description: `${label} membership roster: member facilities, tiers and effective dates → GpoMembership with history.`,
    providers: [
      { id: "file", label: "Roster file (CSV / XLSX)", description: "Portal export dropped in a directory or fetched over SFTP.", fields: fileSourceFields() },
      { id: "api", label: "Member API (REST / JSON)", description: "A JSON endpoint listing members, with bearer / API-key / basic auth.", fields: [
        { name: "endpoint", label: "Roster endpoint URL", type: "url", required: true, group: "Connection" },
        ...apiAuthFields([{ value: "bearer", label: "Bearer token" }, { value: "api-key", label: "API key header" }, { value: "basic", label: "Basic" }, { value: "none", label: "None (IP-allow-listed)" }]),
        { name: "recordsPath", label: "Records path in the response", type: "text", placeholder: "data.members", help: "Blank when the body is the array", group: "Response" },
        { name: "pagingMode", label: "Paging", type: "select", default: "none", options: [{ value: "none", label: "None" }, { value: "next-link", label: "Next link in the body" }, { value: "page", label: "Page number parameter" }], group: "Response" },
        { name: "pagingPath", label: "Next-link path / page parameter", type: "text", placeholder: "links.next  or  page", group: "Response" },
        { name: "pagingSizeParam", label: "Page-size parameter", type: "text", placeholder: "per_page", group: "Response" },
        { name: "pageSize", label: "Page size", type: "number", default: 200, group: "Response" },
        { name: "sinceParam", label: "Incremental parameter", type: "text", placeholder: "updated_since", help: "Query parameter that takes an ISO timestamp; blank = full pull", group: "Response" },
        { name: "extraQuery", label: "Extra query parameters", type: "json", default: "{}", group: "Response" },
      ] },
      { id: "mock", label: `Mock ${label} roster (demo / test)`, description: "Fixture members incl. one unmatched and one expired.", mock: true, fields: [scenarioField] },
    ],
    commonFields: [
      { name: "closeMissing", label: "Close memberships missing from a complete roster", type: "boolean", default: false, help: "Only applies to full-roster pulls. Off by default: a member missing from one file is not evidence they left.", group: "Reconciliation" },
    ],
    mappingSpecs: {}, defaultMapping: {},
    syncTypes: [{ id: "memberships", label: "Memberships", description: "Full roster (file) or incremental (API)", acceptsUpload: true }],
    requiredFromCustomer: [`${label} roster access (portal export schedule, SFTP credentials or API credentials)`, "The roster's column names → mapping", "Which column carries our account number (the match key)", "Whether a full roster should close memberships that are missing"],
  };
}

// ---- 2.4 Documents --------------------------------------------------------------------------------

const DOCUMENTS: IntegrationDefinition = {
  key: "documents", family: "documents", label: "Document extraction (OCR)",
  description: "Turns uploaded invoices, POs, bid lists and contract tables into reviewable line items. Manual extraction always works; a provider adds automation.",
  providers: [
    { id: "manual", label: "Manual (spreadsheet paste / column mapping)", description: "No external service: the user pastes or uploads a table and maps the columns.", fields: [] },
    { id: "http", label: "HTTP extraction service (any OCR / IDP vendor)", description: "POST the document to an endpoint and map the JSON response.", fields: [
      { name: "endpoint", label: "Extraction endpoint URL", type: "url", required: true, group: "Connection" },
      ...apiAuthFields([{ value: "bearer", label: "Bearer token" }, { value: "api-key", label: "API key header" }, { value: "none", label: "None" }]).filter((f) => !["username", "password"].includes(f.name)),
      { name: "encoding", label: "Request encoding", type: "select", required: true, default: "multipart", options: [{ value: "multipart", label: "multipart/form-data" }, { value: "base64-json", label: "JSON with base64 content" }], group: "Request" },
      { name: "fileField", label: "File field name", type: "text", default: "file", group: "Request" },
      { name: "model", label: "Model / processor id", type: "text", group: "Request" },
      { name: "extraBody", label: "Extra body fields", type: "json", default: "{}", group: "Request" },
      { name: "timeoutMs", label: "Timeout (ms)", type: "number", default: 120000, group: "Request" },
      { name: "responseLinesPath", label: "Lines array path", type: "text", required: true, placeholder: "result.line_items", group: "Response mapping" },
      { name: "responseLineFields", label: "Line field paths", type: "json", required: true, default: '{"competitorSku":"sku","description":"description","quantity":"quantity","uom":"unit","unitPrice":"unit_price","lineTotal":"total"}', group: "Response mapping" },
      { name: "responseLineConfidencePath", label: "Line confidence path", type: "text", placeholder: "confidence", group: "Response mapping" },
      { name: "responseFieldConfidenceSuffix", label: "Per-field confidence suffix", type: "text", placeholder: "_confidence", group: "Response mapping" },
      { name: "responseHeaderFields", label: "Header field paths", type: "json", default: '{"vendorName":"result.vendor.name","documentNumber":"result.invoice_number","documentDate":"result.invoice_date","accountNumber":"result.customer.account_number"}', group: "Response mapping" },
      { name: "responseOverallPath", label: "Overall confidence path", type: "text", placeholder: "result.confidence", group: "Response mapping" },
      { name: "responsePagePath", label: "Page number path (per line)", type: "text", placeholder: "page", group: "Response mapping" },
    ] },
    { id: "mock", label: "Mock extraction (demo / test)", description: "Deterministic fields; scenario controls failures; low-confidence toggle exercises the review queue.", mock: true, fields: [scenarioField, { name: "lowConfidence", label: "Produce low-confidence lines", type: "boolean", default: false }] },
  ],
  commonFields: [
    { name: "threshold", label: "Review threshold (0–1)", type: "number", default: 0.85, help: "Lines below this extraction confidence go to review. Extraction confidence is not commercial confidence — verified lines still enter the intelligence model at the source-type confidence.", group: "Review" },
    { name: "alwaysReview", label: "Always route to review", type: "boolean", default: true, help: "Recommended until the provider has earned trust", group: "Review" },
  ],
  mappingSpecs: {}, defaultMapping: {},
  syncTypes: [],
  requiredFromCustomer: ["Whether to use an OCR/IDP vendor at all (manual works without one)", "Vendor endpoint, credentials and response shape", "Review threshold policy"],
};

// ---- 2.5 FX ---------------------------------------------------------------------------------------

const FX: IntegrationDefinition = {
  key: "fx", family: "fx", label: "Exchange rates",
  description: "Daily reference rates into ExchangeRate. Manual entry always works; conversions are explicit, dated and reference the stored rate.",
  providers: [
    { id: "manual", label: "Manual entry only", description: "Rates are entered under Settings → Exchange rates.", fields: [] },
    { id: "ecb", label: "European Central Bank (free, EUR-based, no key)", description: "Daily reference rates; USD/GBP/... crosses are derived through EUR and labelled ecb-cross.", fields: [{ name: "baseUrl", label: "ECB data API base URL", type: "url", default: "https://data-api.ecb.europa.eu/service/data/EXR", group: "Connection" }] },
    { id: "http", label: "HTTP rate service (any vendor)", description: "GET an endpoint with {base}/{quote}/{date} placeholders and read the rate from a JSON path.", fields: [
      { name: "endpoint", label: "Endpoint URL template", type: "url", required: true, placeholder: "https://api.example.com/{date}?base={base}&symbols={quote}", group: "Connection" },
      { name: "ratePath", label: "Rate path", type: "text", required: true, placeholder: "rates.{quote}", group: "Response" },
      { name: "datePath", label: "Date path", type: "text", placeholder: "date", help: "When present, a response dated differently from the request is refused", group: "Response" },
      { name: "authMode", label: "Authentication", type: "select", default: "none", options: [{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "api-key", label: "API key header" }, { value: "query", label: "API key query parameter" }], group: "Authentication" },
      { name: "token", label: "Bearer token", type: "secret", secret: true, group: "Authentication" },
      { name: "apiKeyHeader", label: "API-key header / query parameter name", type: "text", default: "X-API-Key", group: "Authentication" },
      { name: "apiKey", label: "API key", type: "secret", secret: true, group: "Authentication" },
    ] },
    { id: "mock", label: "Mock rates (demo / test)", description: "Fixed table, no weekend rates (exercises the missing-rate path).", mock: true, fields: [scenarioField] },
  ],
  commonFields: [
    { name: "baseCurrencies", label: "Base currencies", type: "text", default: "USD", help: "Comma-separated", group: "Scope" },
    { name: "quoteCurrencies", label: "Quote currencies", type: "text", default: "EUR,GBP,CAD", help: "Comma-separated", group: "Scope" },
    { name: "fallback", label: "When no rate exists for the date", type: "select", default: "fail", options: [{ value: "fail", label: "Fail the conversion (recommended)" }, { value: "previous-business-day", label: "Use the previous business day's rate (labelled)" }], group: "Policy" },
    // Default shared with src/lib/integrations/fx/service.ts (FX_MAX_LOOKBACK_DEFAULT): one canonical policy.
    { name: "maxLookbackDays", label: "Max look-back days", type: "number", default: 5, help: "Only with the previous-business-day fallback; 5 covers a weekend plus a holiday on either side (0–30)", group: "Policy", validate: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 30 ? null : "Max look-back days must be a whole number between 0 and 30"; } },
  ],
  mappingSpecs: {}, defaultMapping: {},
  syncTypes: [{ id: "rates", label: "Daily rates", description: "Pull today's rates for every base × quote pair" }],
  requiredFromCustomer: ["Which currencies the company prices in", "Whether a paid rate vendor is required (ECB is free) and its credentials", "Fallback policy for missing dates"],
};

// ---- 2.6 Competitor contract prices -----------------------------------------------------------------

const CONTRACTS: IntegrationDefinition = {
  key: "competitor-contracts", family: "contracts", label: "Competitor GPO contract prices",
  description: "Contract-price files from marketing / contracting → CompetitorPriceObservation (GPO_CONTRACT_FILE) with validation and an exception queue.",
  providers: [
    { id: "file", label: "Contract price file (CSV / XLSX)", description: "Dropped in a directory, fetched over SFTP, or uploaded from the review screen.", fields: [
      ...fileSourceFields(),
      { name: "sourceOwner", label: "Source owner", type: "text", placeholder: "Contracting team", help: "Who supplies the file — recorded on every observation", group: "Provenance" },
      { name: "defaultGpo", label: "Default GPO", type: "text", help: "Used when the file has no GPO column", group: "Provenance" },
    ] },
    { id: "mock", label: "Mock contract file (demo / test)", description: "Fixture rows incl. an ambiguous UOM and a duplicate.", mock: true, fields: [scenarioField] },
  ],
  commonFields: [
    { name: "uomAliases", label: "Extra UOM aliases", type: "json", default: "{}", help: '{"bndl":"BX","each10":"PK"} — unknown units go to review', group: "Validation" },
    { name: "currencies", label: "Accepted currencies", type: "text", default: "USD,CAD,EUR,GBP", group: "Validation" },
    { name: "unknownCompetitor", label: "Unknown manufacturer", type: "select", default: "review", options: [{ value: "review", label: "Queue for review (recommended)" }, { value: "create", label: "Create the competitor automatically" }], group: "Validation" },
    { name: "keepExpired", label: "Keep already-expired prices as history", type: "boolean", default: false, group: "Validation" },
  ],
  mappingSpecs: {}, defaultMapping: {},
  syncTypes: [{ id: "prices", label: "Contract prices", description: "Validate and record the newest file (or an upload)", acceptsUpload: true }],
  requiredFromCustomer: ["Who owns the contract-price files and where they land", "The file's column names → mapping", "Competitor names as they appear in the files (aliases)", "UOM conventions"],
};

export const INTEGRATIONS: Record<IntegrationKey, IntegrationDefinition> = {
  salesforce: SALESFORCE, sap: SAP,
  "gpo:premier": gpoDefinition("premier", "Premier"), "gpo:vizient": gpoDefinition("vizient", "Vizient"), "gpo:healthtrust": gpoDefinition("healthtrust", "HealthTrust"),
  documents: DOCUMENTS, fx: FX, "competitor-contracts": CONTRACTS,
};

/** Mapping specs and defaults are attached lazily (they import the provider modules). */
export async function definition(k: IntegrationKey): Promise<IntegrationDefinition> {
  const d = INTEGRATIONS[k];
  if (Object.keys(d.mappingSpecs).length) return d;
  if (k === "salesforce") { const m = await import("../salesforce/mapping"); d.mappingSpecs = m.SALESFORCE_SPECS; d.defaultMapping = m.SALESFORCE_DEFAULT_MAPPING; }
  else if (k === "sap") { const m = await import("../sap/mapping"); d.mappingSpecs = m.SAP_SPECS; d.defaultMapping = m.SAP_DEFAULT_MAPPING; }
  else if (k.startsWith("gpo:")) { const m = await import("../gpo/profiles"); const p = m.GPO_PROFILES[k.slice(4) as "premier"]; d.mappingSpecs = { GpoMembership: m.MEMBERSHIP_SPEC }; d.defaultMapping = { GpoMembership: p.fileMapping }; }
  else if (k === "documents") { const m = await import("../documents/manual"); d.mappingSpecs = { Line: m.LINE_SPEC }; d.defaultMapping = { Line: m.MANUAL_DEFAULT_MAPPING }; }
  else if (k === "competitor-contracts") { const m = await import("../competitor-contracts/mapping"); d.mappingSpecs = { CompetitorContractPrice: m.CONTRACT_PRICE_SPEC }; d.defaultMapping = { CompetitorContractPrice: m.CONTRACT_PRICE_DEFAULT_MAPPING }; }
  else { d.mappingSpecs = { _: { entity: "none", fields: [] } }; }
  return d;
}

export function providerOf(d: IntegrationDefinition, id: string): ProviderDefinition {
  const p = d.providers.find((p) => p.id === id);
  if (!p) throw new ConfigurationError(`${d.label}: unknown provider "${id}" (choose one of ${d.providers.map((p) => p.id).join(", ")})`);
  return p;
}
/** All field specs (provider + common) for a provider choice. */
export function fieldsFor(d: IntegrationDefinition, providerId: string): FieldSpec[] { return [...providerOf(d, providerId).fields, ...d.commonFields]; }

/** The effective mapping: defaults overlaid with the company's overrides, per entity. */
export function effectiveMapping(d: IntegrationDefinition, overrides: MappingBundle): MappingBundle {
  const out: MappingBundle = {};
  for (const entity of new Set([...Object.keys(d.defaultMapping), ...Object.keys(overrides)])) out[entity] = mergeMapping(d.defaultMapping[entity] ?? {}, overrides[entity]);
  return out;
}

// ---- helpers for factories ---------------------------------------------------------------------------

const str = (c: Record<string, unknown>, k: string, def = ""): string => { const v = c[k]; return v === undefined || v === null ? def : String(v); };
const num = (c: Record<string, unknown>, k: string, def: number): number => { const v = Number(c[k]); return Number.isFinite(v) && c[k] !== "" && c[k] !== undefined ? v : def; };
const bool = (c: Record<string, unknown>, k: string, def = false): boolean => (c[k] === undefined || c[k] === "" ? def : c[k] === true || c[k] === "true");
const json = <T>(c: Record<string, unknown>, k: string, def: T): T => { const v = c[k]; if (v === undefined || v === null || v === "") return def; if (typeof v === "object") return v as T; try { return JSON.parse(String(v)) as T; } catch { throw new ConfigurationError(`${k} is not valid JSON`); } };
const csv = (c: Record<string, unknown>, k: string, def: string[]): string[] => { const s = str(c, k); return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : def; };
const need = (secrets: Record<string, string>, k: string, label: string): string => { const v = secrets[k]; if (!v) throw new ConfigurationError(`${label} is required — enter it under the integration's settings (secrets are never shown after saving)`); return v; };

function fileSource(c: Record<string, unknown>, s: Record<string, string>, prefix = ""): FileSource {
  const kind = str(c, `${prefix}sourceKind`, "directory");
  const directory = str(c, `${prefix}directory`); const pattern = str(c, `${prefix}pattern`, "*.csv");
  if (!directory) throw new ConfigurationError("a directory is required");
  if (kind === "sftp") return { kind: "sftp", host: str(c, `${prefix}sftpHost`), port: num(c, `${prefix}sftpPort`, 22), username: str(c, `${prefix}sftpUsername`), password: s[`${prefix}sftpPassword`] ?? null, privateKey: s[`${prefix}sftpPrivateKey`] ?? null, directory, pattern };
  return { kind: "directory", directory, pattern };
}

function assertMock(cfg: ResolvedConfig) {
  if (!mockAllowed()) throw new ConfigurationError(`${cfg.key}: the mock provider is not allowed in production (set INTEGRATIONS_ALLOW_MOCK=true only for a demo deployment)`);
}

// ---- factories ----------------------------------------------------------------------------------------

export type BuildOptions = { /** an uploaded file replaces the configured file source for one run */ upload?: { filename: string; buffer: Buffer } | null; fetchImpl?: typeof fetch };

export async function buildCrm(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<CRMAdapter> {
  const d = await definition("salesforce"); const c = cfg.config; const s = cfg.secrets;
  if (cfg.provider === "mock") { assertMock(cfg); const { MockSalesforceAdapter } = await import("../salesforce/mock"); return new MockSalesforceAdapter(parseScenario(c.scenario)); }
  const { SalesforceAdapter } = await import("../salesforce/adapter");
  const flow = str(c, "authFlow", "client-credentials");
  const auth = flow === "jwt-bearer"
    ? { flow: "jwt-bearer" as const, loginUrl: str(c, "loginUrl", "https://login.salesforce.com"), clientId: str(c, "clientId"), username: str(c, "username"), privateKeyPem: need(s, "privateKeyPem", "the private key"), audience: null }
    : { flow: "client-credentials" as const, loginUrl: str(c, "loginUrl", "https://login.salesforce.com"), clientId: str(c, "clientId"), clientSecret: need(s, "clientSecret", "the consumer secret") };
  const gpoObj = str(c, "gpoAffiliationObject");
  return new SalesforceAdapter({
    auth, apiVersion: str(c, "apiVersion", "v60.0"), mapping: effectiveMapping(d, cfg.mapping), quoteObject: str(c, "quoteObject", "Crosswalk_Quote__c"), quoteLineObject: str(c, "quoteLineObject", "Crosswalk_Quote_Line__c"),
    gpoAffiliation: gpoObj ? { object: gpoObj, accountField: str(c, "gpoAffiliationAccountField", "Account__c"), gpoField: str(c, "gpoAffiliationGpoField", "GPO_Name__c"), tierField: str(c, "gpoAffiliationTierField") || null, fromField: str(c, "gpoAffiliationFromField") || null, toField: str(c, "gpoAffiliationToField") || null } : null,
    accountFilter: str(c, "accountFilter") || null, pageSize: num(c, "pageSize", 500), fetchImpl: o.fetchImpl,
  });
}

export async function buildErp(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<ERPAdapter> {
  const d = await definition("sap"); const c = cfg.config; const s = cfg.secrets;
  if (cfg.provider === "mock") { assertMock(cfg); const { MockSapAdapter } = await import("../sap/mock"); return new MockSapAdapter(parseScenario(c.scenario)); }
  const { SapAdapter } = await import("../sap/adapter");
  const auth = str(c, "authMode", "basic") === "oauth"
    ? { mode: "oauth" as const, tokenUrl: str(c, "tokenUrl"), clientId: str(c, "clientId"), clientSecret: need(s, "clientSecret", "the OAuth client secret"), scope: null }
    : { mode: "basic" as const, username: str(c, "username"), password: need(s, "password", "the technical user's password") };
  const service = (p: string, required: boolean) => { const service = str(c, `${p}Service`); const entitySet = str(c, `${p}EntitySet`); if (!service || !entitySet) { if (required) throw new ConfigurationError(`${p} service and entity set are required`); return null; } return { service, entitySet, changeDateField: str(c, `${p}ChangeDateField`) || null, filter: str(c, `${p}Filter`) || null, pageSize: num(c, "pageSize", 500) }; };
  return new SapAdapter({
    odata: { baseUrl: str(c, "baseUrl"), version: str(c, "odataVersion", "v2") as "v2" | "v4", client: str(c, "client") || null, auth, timeoutMs: num(c, "timeoutMs", 30000), fetchImpl: o.fetchImpl },
    companyCode: str(c, "companyCode") || null, services: { materials: service("materials", true)!, costs: service("costs", false), prices: service("prices", false), billing: service("billing", false) },
    plantRegions: json<Record<string, string>>(c, "plantRegions", {}), listConditionTypes: csv(c, "listConditionTypes", []), mapping: effectiveMapping(d, cfg.mapping),
  });
}

export async function buildGpoRoster(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<GpoRosterAdapter> {
  const d = await definition(cfg.key); const c = cfg.config; const s = cfg.secrets;
  const { GPO_PROFILES } = await import("../gpo/profiles");
  const profile = GPO_PROFILES[cfg.key.slice(4) as "premier"];
  if (!profile) throw new ConfigurationError(`${cfg.key} is not a GPO roster integration`);
  const mapping = effectiveMapping(d, cfg.mapping).GpoMembership ?? profile.fileMapping;
  if (cfg.provider === "mock") { assertMock(cfg); const { MockGpoRosterAdapter } = await import("../gpo/mock"); return new MockGpoRosterAdapter(profile, parseScenario(c.scenario)); }
  if (cfg.provider === "api") {
    const { ApiRosterAdapter } = await import("../gpo/api");
    const mode = str(c, "authMode", "bearer");
    const auth = mode === "bearer" ? { mode: "bearer" as const, token: need(s, "token", "the bearer token") } : mode === "api-key" ? { mode: "api-key" as const, header: str(c, "apiKeyHeader", "X-API-Key"), key: need(s, "apiKey", "the API key") } : mode === "basic" ? { mode: "basic" as const, username: str(c, "username"), password: need(s, "password", "the password") } : { mode: "none" as const };
    const pm = str(c, "pagingMode", "none");
    const paging = pm === "next-link" ? { mode: "next-link" as const, path: str(c, "pagingPath", "next") } : pm === "page" ? { mode: "page" as const, param: str(c, "pagingPath", "page"), sizeParam: str(c, "pagingSizeParam") || null, size: num(c, "pageSize", 200) } : { mode: "none" as const };
    return new ApiRosterAdapter({ profile, endpoint: str(c, "endpoint"), auth, recordsPath: str(c, "recordsPath") || null, paging, sinceParam: str(c, "sinceParam") || null, mapping, extraQuery: json<Record<string, string>>(c, "extraQuery", {}), fetchImpl: o.fetchImpl });
  }
  const { FileRosterAdapter } = await import("../gpo/file");
  const source: FileSource = o.upload ? { kind: "upload", filename: o.upload.filename, buffer: o.upload.buffer } : fileSource(c, s);
  return new FileRosterAdapter({ profile, source, sheet: str(c, "sheet") || null, headerRow: num(c, "headerRow", 1), mapping });
}

export async function buildExtraction(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<DocumentExtractionProvider> {
  const d = await definition("documents"); const c = cfg.config; const s = cfg.secrets;
  if (cfg.provider === "mock") { assertMock(cfg); const { MockDocumentExtractionProvider } = await import("../documents/mock"); return new MockDocumentExtractionProvider(parseScenario(c.scenario), bool(c, "lowConfidence")); }
  if (cfg.provider === "http") {
    const { HttpExtractionProvider } = await import("../documents/http");
    const mode = str(c, "authMode", "bearer");
    const auth = mode === "bearer" ? { mode: "bearer" as const, token: need(s, "token", "the bearer token") } : mode === "api-key" ? { mode: "api-key" as const, header: str(c, "apiKeyHeader", "X-API-Key"), key: need(s, "apiKey", "the API key") } : { mode: "none" as const };
    return new HttpExtractionProvider({
      endpoint: str(c, "endpoint"), auth, encoding: str(c, "encoding", "multipart") as "multipart" | "base64-json", extraBody: json<Record<string, string>>(c, "extraBody", {}), fileField: str(c, "fileField", "file"), model: str(c, "model") || null, timeoutMs: num(c, "timeoutMs", 120000), fetchImpl: o.fetchImpl,
      response: { linesPath: str(c, "responseLinesPath"), lineFields: json(c, "responseLineFields", {}), lineConfidencePath: str(c, "responseLineConfidencePath") || null, fieldConfidenceSuffix: str(c, "responseFieldConfidenceSuffix") || null, headerFields: json(c, "responseHeaderFields", {}), overallPath: str(c, "responseOverallPath") || null, pagePath: str(c, "responsePagePath") || null },
    });
  }
  const { ManualExtractionProvider } = await import("../documents/manual");
  return new ManualExtractionProvider(effectiveMapping(d, cfg.mapping).Line);
}

export async function buildFx(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<FxRateProvider> {
  const c = cfg.config; const s = cfg.secrets;
  const p = await import("../fx/providers");
  if (cfg.provider === "mock") { assertMock(cfg); return new p.MockFxProvider(parseScenario(c.scenario)); }
  if (cfg.provider === "ecb") return new p.EcbFxProvider({ baseUrl: str(c, "baseUrl") || undefined, fetchImpl: o.fetchImpl });
  if (cfg.provider === "http") {
    const mode = str(c, "authMode", "none");
    const auth = mode === "bearer" ? { mode: "bearer" as const, token: need(s, "token", "the bearer token") } : mode === "api-key" ? { mode: "api-key" as const, header: str(c, "apiKeyHeader", "X-API-Key"), key: need(s, "apiKey", "the API key") } : mode === "query" ? { mode: "query" as const, param: str(c, "apiKeyHeader", "apikey"), key: need(s, "apiKey", "the API key") } : { mode: "none" as const };
    return new p.HttpFxProvider({ endpoint: str(c, "endpoint"), ratePath: str(c, "ratePath"), datePath: str(c, "datePath") || null, auth, fetchImpl: o.fetchImpl });
  }
  return new p.ManualFxProvider();
}

export async function buildContractPrices(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<CompetitorContractPriceAdapter> {
  const d = await definition("competitor-contracts"); const c = cfg.config; const s = cfg.secrets;
  if (cfg.provider === "mock") { assertMock(cfg); const { MockCompetitorContractAdapter } = await import("../competitor-contracts/mock"); return new MockCompetitorContractAdapter(parseScenario(c.scenario)); }
  const { FileContractPriceAdapter } = await import("../competitor-contracts/file");
  const source: FileSource = o.upload ? { kind: "upload", filename: o.upload.filename, buffer: o.upload.buffer } : fileSource(c, s);
  return new FileContractPriceAdapter({ source, sheet: str(c, "sheet") || null, headerRow: num(c, "headerRow", 1), mapping: effectiveMapping(d, cfg.mapping).CompetitorContractPrice, sourceOwner: str(c, "sourceOwner") || null, defaultGpo: str(c, "defaultGpo") || null });
}

/** Any adapter, for connection tests. */
export async function buildAny(cfg: ResolvedConfig, o: BuildOptions = {}): Promise<ConnectionTester> {
  switch (INTEGRATIONS[cfg.key].family) {
    case "crm": return buildCrm(cfg, o);
    case "erp": return buildErp(cfg, o);
    case "gpo": return buildGpoRoster(cfg, o);
    case "documents": return buildExtraction(cfg, o);
    case "fx": return buildFx(cfg, o);
    case "contracts": return buildContractPrices(cfg, o);
  }
}

/** Typed config readers the handlers share. */
export const cfgRead = { str, num, bool, json, csv };

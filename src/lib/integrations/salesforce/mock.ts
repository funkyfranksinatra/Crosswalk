/**
 * MockSalesforceAdapter — a stand-in Salesforce org for demos and tests. Same interface,
 * same canonical output, and a scenario switch for every failure mode the runner handles.
 * Labelled MOCK in the UI; never a production provider by default.
 */
import type { CRMAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { AccountImportRecord, OpportunityImportRecord, ContactImportRecord, GpoAffiliationRecord, QuoteWriteback, QuoteWritebackResult } from "../types";
import { scenarioGate, malformed, type MockScenario } from "../core/mock";
import { ValidationError } from "../core/errors";

const prov = (id: string, object: string) => ({ provider: "mock", sourceSystem: "salesforce-mock", sourceRecordId: id, sourceUpdatedAt: "2026-09-01T12:00:00.000Z", meta: { object } });

export const MOCK_ACCOUNTS: AccountImportRecord[] = [
  { externalId: "001MOCK0000000001", name: "Lakeshore Health System", accountNumber: "MOCK-IDN-1", type: "IDN", territory: "Northeast", region: "NY", country: "US", currency: "USD", isStrategic: true, ownerEmail: "alex.rep@crosswalk.dev", gpoName: "Vizient", gpoTier: "Tier 2", provenance: prov("001MOCK0000000001", "Account") },
  { externalId: "001MOCK0000000002", name: "Lakeshore Regional Hospital", accountNumber: "MOCK-0002", parentExternalId: "001MOCK0000000001", type: "SOLD_TO", territory: "Northeast", region: "NY", country: "US", currency: "USD", isStrategic: false, ownerEmail: "alex.rep@crosswalk.dev", gpoName: "Vizient", gpoTier: "Tier 2", provenance: prov("001MOCK0000000002", "Account") },
  { externalId: "001MOCK0000000003", name: "Desert Valley Medical Center", accountNumber: "MOCK-0003", type: "SOLD_TO", territory: "Southwest", region: "AZ", country: "US", currency: "USD", isStrategic: false, ownerEmail: "maria.manager@crosswalk.dev", gpoName: "Premier", gpoTier: "Tier 1", provenance: prov("001MOCK0000000003", "Account") },
];
export const MOCK_OPPORTUNITIES: OpportunityImportRecord[] = [
  { externalId: "006MOCK0000000001", accountExternalId: "001MOCK0000000002", name: "Endomechanical conversion FY27", stage: "Proposal/Price Quote", ownerEmail: "alex.rep@crosswalk.dev", closeDate: "2026-12-15", amount: "185000", currency: "USD", provenance: prov("006MOCK0000000001", "Opportunity") },
  { externalId: "006MOCK0000000002", accountExternalId: "001MOCK0000000003", name: "Hernia mesh standardisation", stage: "Qualification", ownerEmail: "maria.manager@crosswalk.dev", closeDate: "2027-02-01", amount: "62000", currency: "USD", provenance: prov("006MOCK0000000002", "Opportunity") },
];

export class MockSalesforceAdapter implements CRMAdapter {
  readonly provider = "mock";
  /** quotes "written" so far — idempotency is observable in tests */
  readonly quotes = new Map<string, { externalId: string; writes: number; lastPayload: QuoteWriteback }>();
  constructor(private scenario: MockScenario = "ok", private options: { failEveryNth?: number } = {}) {}

  async testConnection(): Promise<ConnectionTestResult> {
    scenarioGate(this.scenario, "Salesforce");
    return { ok: true, message: "MOCK Salesforce: connected (no real org)", details: { scenario: this.scenario, accounts: MOCK_ACCOUNTS.length } };
  }
  async describeFields(entity: string): Promise<string[] | null> {
    if (entity === "Account") return ["Id", "Name", "AccountNumber", "ParentId", "Type", "Industry", "BillingState", "BillingCountryCode", "CurrencyIsoCode", "Owner", "LastModifiedDate", "GPO__c", "GPO_Tier__c", "Strategic__c"];
    if (entity === "Opportunity") return ["Id", "AccountId", "Name", "StageName", "Owner", "CloseDate", "Amount", "CurrencyIsoCode", "LastModifiedDate"];
    return null;
  }
  private async paged<T extends object>(rows: T[], opts?: PullOptions): Promise<Page<T>> { return this.page(rows as never, opts) as Page<T>; }
  private page<T extends { externalId: string }>(rows: T[], opts?: PullOptions): Page<T> {
    scenarioGate(this.scenario, "Salesforce");
    if (this.scenario === "malformed") malformed("Salesforce");
    if (this.scenario === "empty") return { records: [], nextCursor: null };
    let records = rows.map((r) => ({ ...r }));
    if (this.scenario === "duplicate") records = [...records, { ...records[0] }];
    if (this.scenario === "partial") records = records.map((r, i) => (i === records.length - 1 ? { ...r, name: "" } : r));
    // two-page behaviour for cursor tests
    const size = opts?.limit ?? 2;
    const start = opts?.cursor ? Number(opts.cursor.replace("mock:", "")) : 0;
    const slice = records.slice(start, start + size);
    return { records: slice, nextCursor: start + size < records.length ? `mock:${start + size}` : null };
  }
  fetchAccounts(opts?: PullOptions) { return this.paged(MOCK_ACCOUNTS, opts); }
  fetchOpportunities(opts?: PullOptions) { return this.paged(MOCK_OPPORTUNITIES, opts); }
  fetchContacts(opts?: PullOptions) { return this.paged([{ externalId: "003MOCK0000000001", accountExternalId: "001MOCK0000000002", name: "Dana Ortiz", email: "dortiz@lakeshore.example", title: "Director, Supply Chain", provenance: prov("003MOCK0000000001", "Contact") }], opts); }
  fetchGpoAffiliations(): Promise<Page<GpoAffiliationRecord>> { return Promise.resolve({ records: [], nextCursor: null }); }
  async fetchAccountsByIds(ids: string[]): Promise<AccountImportRecord[]> { scenarioGate(this.scenario, "Salesforce"); return MOCK_ACCOUNTS.filter((a) => ids.includes(a.externalId)).map((a) => ({ ...a })); }

  async createOrUpdateQuote(q: QuoteWriteback): Promise<QuoteWritebackResult> {
    scenarioGate(this.scenario, "Salesforce");
    if (this.scenario === "malformed") malformed("Salesforce");
    if (!q.idempotencyKey) throw new ValidationError("mock: quote has no idempotency key");
    const existing = this.quotes.get(q.idempotencyKey);
    const externalId = existing?.externalId ?? `a0QMOCK${q.idempotencyKey.slice(-9).toUpperCase().padStart(9, "0")}`;
    this.quotes.set(q.idempotencyKey, { externalId, writes: (existing?.writes ?? 0) + 1, lastPayload: q });
    return { externalId, created: !existing, lineExternalIds: q.lines.map((_, i) => `${externalId}-L${i + 1}`), providerRef: `mock-${Date.now()}` };
  }
}

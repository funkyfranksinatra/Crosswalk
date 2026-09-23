/** MockSapAdapter — a stand-in ERP with the same interface and scenario switch. Labelled MOCK. */
import type { ERPAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { ProductImportRecord, StandardCostImportRecord, PriceEntryImportRecord, BillingImportRecord } from "../types";
import { scenarioGate, malformed, type MockScenario } from "../core/mock";

const prov = (id: string, set: string) => ({ provider: "mock", sourceSystem: "sap-mock", sourceRecordId: id, sourceUpdatedAt: "2026-09-01T00:00:00.000Z", meta: { entitySet: set } });

export const MOCK_MATERIALS: ProductImportRecord[] = [
  { sku: "MOCK-STAPLER-45", description: "MOCK Endoscopic linear cutter 45 mm", productFamily: "Endomechanical", uom: "EA", status: "ACTIVE", discontinued: false, listPrice: "412.00", currency: "USD", provenance: prov("MOCK-STAPLER-45", "A_Product") },
  { sku: "MOCK-RELOAD-45B", description: "MOCK Reload 45 mm blue", productFamily: "Endomechanical", uom: "EA", status: "ACTIVE", discontinued: false, listPrice: "138.50", currency: "USD", provenance: prov("MOCK-RELOAD-45B", "A_Product") },
  { sku: "MOCK-MESH-10X15", description: "MOCK Polypropylene mesh 10 x 15 cm", productFamily: "Hernia Mesh", uom: "EA", status: "DISCONTINUED", discontinued: true, listPrice: "295.00", currency: "USD", provenance: prov("MOCK-MESH-10X15", "A_Product") },
];
export const MOCK_COSTS: StandardCostImportRecord[] = [
  { sku: "MOCK-STAPLER-45", plant: "1000", region: "US", currency: "USD", costType: "STANDARD", cost: "146.250000", effectiveFrom: "2026-01-01", effectiveTo: null, provenance: prov("MOCK-STAPLER-45|1000|2026-01-01", "ZC_StdCost") },
  { sku: "MOCK-RELOAD-45B", plant: "1000", region: "US", currency: "USD", costType: "STANDARD", cost: "41.900000", effectiveFrom: "2026-01-01", effectiveTo: null, provenance: prov("MOCK-RELOAD-45B|1000|2026-01-01", "ZC_StdCost") },
  { sku: "MOCK-RELOAD-45B", plant: "2000", region: "EU", currency: "EUR", costType: "STANDARD", cost: "39.100000", effectiveFrom: "2026-01-01", effectiveTo: null, provenance: prov("MOCK-RELOAD-45B|2000|2026-01-01", "ZC_StdCost") },
];
export const MOCK_PRICES: PriceEntryImportRecord[] = [
  { sku: "MOCK-STAPLER-45", price: "412.00", currency: "USD", pricebook: "US-LIST", conditionType: "PR00", effectiveFrom: "2026-01-01", effectiveTo: null, uom: "EA", minQty: null, provenance: prov("MOCK-STAPLER-45|PR00|US-LIST|2026-01-01", "A_SlsPrcgCndnRecdValidity") },
  { sku: "MOCK-RELOAD-45B", price: "138.50", currency: "USD", pricebook: "US-LIST", conditionType: "PR00", effectiveFrom: "2026-01-01", effectiveTo: null, uom: "EA", minQty: null, provenance: prov("MOCK-RELOAD-45B|PR00|US-LIST|2026-01-01", "A_SlsPrcgCndnRecdValidity") },
];
export const MOCK_BILLING: BillingImportRecord[] = [
  { externalId: "90001234-10", accountNumber: "MOCK-0002", accountExternalId: null, sku: "MOCK-RELOAD-45B", quantity: "48", netPrice: "121.500000", currency: "USD", invoiceDate: "2026-08-14", contractNumber: null, provenance: prov("90001234-10", "A_BillingDocumentItem") },
];

export class MockSapAdapter implements ERPAdapter {
  readonly provider = "mock";
  constructor(private scenario: MockScenario = "ok") {}
  async testConnection(): Promise<ConnectionTestResult> { scenarioGate(this.scenario, "SAP"); return { ok: true, message: "MOCK SAP: connected (no real system)", details: { scenario: this.scenario, materials: MOCK_MATERIALS.length } }; }
  private async paged<T extends object>(rows: T[], opts?: PullOptions): Promise<Page<T>> { return this.page(rows as never, opts) as Page<T>; }
  private page<T extends { sku?: string; externalId?: string }>(rows: T[], opts?: PullOptions): Page<T> {
    scenarioGate(this.scenario, "SAP");
    if (this.scenario === "malformed") malformed("SAP");
    if (this.scenario === "empty") return { records: [], nextCursor: null };
    let records = rows.map((r) => ({ ...r }));
    if (this.scenario === "duplicate") records = [...records, { ...records[0] }];
    if (this.scenario === "partial") records = records.map((r, i) => (i === records.length - 1 ? { ...r, sku: "" } : r));
    const size = opts?.limit ?? 2; const start = opts?.cursor ? Number(opts.cursor.replace("mock:", "")) : 0;
    return { records: records.slice(start, start + size), nextCursor: start + size < records.length ? `mock:${start + size}` : null };
  }
  fetchMaterials(opts?: PullOptions) { return this.paged(MOCK_MATERIALS, opts); }
  fetchStandardCosts(opts?: PullOptions) { return this.paged(MOCK_COSTS, opts); }
  fetchListPrices(opts?: PullOptions) { return this.paged(MOCK_PRICES, opts); }
  fetchBillingDocuments(opts?: PullOptions) { return this.paged(MOCK_BILLING, opts); }
}

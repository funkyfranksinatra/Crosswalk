/** MockCompetitorContractAdapter — a stand-in contract-price feed. Labelled MOCK. */
import type { CompetitorContractPriceAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { CompetitorPriceImportRecord } from "../types";
import { scenarioGate, malformed, type MockScenario } from "../core/mock";

const prov = (i: number) => ({ provider: "mock", sourceSystem: "mock-contract-prices.xlsx", sourceRecordId: `mock#${i}`, meta: { row: i + 2 } });
export const MOCK_CONTRACT_PRICES: CompetitorPriceImportRecord[] = [
  { gpoName: "Vizient", competitorName: "Covidien", competitorSku: "1DLMC05", description: "Parietex composite mesh 15x10", price: "398.00", currency: "USD", uom: "EA", tier: "Tier 2", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", contractRef: "VZ-2026-SURG-118", sourceOwner: "Contracting", provenance: prov(0) },
  { gpoName: "Vizient", competitorName: "Ethicon", competitorSku: "SPMII", description: "Proceed mesh", price: "1085.00", currency: "USD", uom: "EA", tier: "Tier 2", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", contractRef: "VZ-2026-SURG-118", sourceOwner: "Contracting", provenance: prov(1) },
  { gpoName: "Premier", competitorName: "Covidien", competitorSku: "1DLMC05", description: "Parietex composite mesh 15x10", price: "405.00", currency: "USD", uom: "EA", tier: "Tier 1", effectiveFrom: "2026-03-01", effectiveTo: null, contractRef: "PP-SU-2201", sourceOwner: "Marketing", provenance: prov(2) },
];

export class MockCompetitorContractAdapter implements CompetitorContractPriceAdapter {
  readonly provider = "mock";
  constructor(private scenario: MockScenario = "ok") {}
  async testConnection(): Promise<ConnectionTestResult> { scenarioGate(this.scenario, "Contract prices"); return { ok: true, message: `MOCK contract prices: ${MOCK_CONTRACT_PRICES.length} rows (no real file)` }; }
  async fetchContractPrices(opts?: PullOptions): Promise<Page<CompetitorPriceImportRecord>> {
    scenarioGate(this.scenario, "Contract prices");
    if (this.scenario === "malformed") malformed("Contract prices");
    if (this.scenario === "empty") return { records: [], nextCursor: null };
    let records = MOCK_CONTRACT_PRICES.map((r) => ({ ...r }));
    if (this.scenario === "duplicate") records = [...records, { ...records[0], provenance: prov(9) }];
    if (this.scenario === "partial") records = [...records, { ...records[1], price: "", uom: "bundle", provenance: prov(8) }];
    const size = opts?.limit ?? 100; const start = opts?.cursor ? Number(opts.cursor.replace("mock:", "")) : 0;
    return { records: records.slice(start, start + size), nextCursor: start + size < records.length ? `mock:${start + size}` : null };
  }
}

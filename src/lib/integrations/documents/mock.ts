/** MockDocumentExtractionProvider — a stand-in document-AI service. Labelled MOCK. */
import type { DocumentExtractionProvider, ConnectionTestResult, ExtractionRequest } from "../core/contracts";
import type { ExtractedDocument, ExtractedFieldRecord } from "../types";
import { scenarioGate, malformed, type MockScenario } from "../core/mock";

export class MockDocumentExtractionProvider implements DocumentExtractionProvider {
  readonly provider = "mock";
  constructor(private scenario: MockScenario = "ok", private lowConfidence = false) {}
  async testConnection(): Promise<ConnectionTestResult> { scenarioGate(this.scenario, "Document extraction"); return { ok: true, message: "MOCK document extraction: ready (no real provider)", details: { scenario: this.scenario } }; }
  async extract(req: ExtractionRequest): Promise<ExtractedDocument> {
    scenarioGate(this.scenario, "Document extraction");
    if (this.scenario === "malformed") malformed("Document extraction");
    const conf = (c: number) => (this.lowConfidence ? c * 0.5 : c);
    const fields: ExtractedFieldRecord[] = [
      { scope: "HEADER", field: "accountName", rawValue: "Lakeshore Regional Hospital", normalizedValue: "Lakeshore Regional Hospital", confidence: conf(0.97) },
      { scope: "HEADER", field: "documentNumber", rawValue: "INV-88213", normalizedValue: "INV-88213", confidence: conf(0.99) },
      { scope: "HEADER", field: "documentDate", rawValue: "08/14/2026", normalizedValue: "2026-08-14", confidence: conf(0.95) },
      { scope: "HEADER", field: "vendorName", rawValue: "Covidien", normalizedValue: "Covidien", confidence: conf(0.93) },
      { scope: "LINE", lineNo: 1, field: "competitorSku", rawValue: "1DLMC05", normalizedValue: "1DLMC05", confidence: conf(0.98), page: 1 },
      { scope: "LINE", lineNo: 1, field: "description", rawValue: "PARIETEX COMPOSITE MESH 15X10", normalizedValue: "PARIETEX COMPOSITE MESH 15X10", confidence: conf(0.96), page: 1 },
      { scope: "LINE", lineNo: 1, field: "quantity", rawValue: "12", normalizedValue: "12", confidence: conf(0.99), page: 1 },
      { scope: "LINE", lineNo: 1, field: "uom", rawValue: "EA", normalizedValue: "EA", confidence: conf(0.9), page: 1 },
      { scope: "LINE", lineNo: 1, field: "unitPrice", rawValue: "$412.50", normalizedValue: "412.5", confidence: conf(0.97), page: 1 },
      { scope: "LINE", lineNo: 2, field: "competitorSku", rawValue: "SPMII", normalizedValue: "SPMII", confidence: this.scenario === "partial" ? 0.41 : conf(0.94), page: 1 },
      { scope: "LINE", lineNo: 2, field: "quantity", rawValue: "6", normalizedValue: "6", confidence: conf(0.98), page: 1 },
      { scope: "LINE", lineNo: 2, field: "unitPrice", rawValue: "1,120.00", normalizedValue: "1120", confidence: this.scenario === "partial" ? 0.55 : conf(0.96), page: 1 },
    ];
    if (this.scenario === "empty") return { provider: "mock", model: "mock-docai-1", documentType: req.documentType, overallConfidence: 0, fields: [] };
    const confs = fields.map((f) => f.confidence!);
    return { provider: "mock", model: "mock-docai-1", documentType: req.documentType, overallConfidence: confs.reduce((a, b) => a + b, 0) / confs.length, fields, raw: null };
  }
}

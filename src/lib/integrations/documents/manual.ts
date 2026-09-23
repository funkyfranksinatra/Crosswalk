/**
 * The manual / CSV provider — the workflow the application always had, expressed as a
 * DocumentExtractionProvider: a person exports or types the table, and the columns are
 * mapped onto the canonical line fields. Confidence is 1.0 (a human produced it), and the
 * result still goes through the same verification state as any other extraction.
 */
import type { DocumentExtractionProvider, ConnectionTestResult, ExtractionRequest } from "../core/contracts";
import type { ExtractedDocument, ExtractedFieldRecord } from "../types";
import { gridFromBuffer, rowsFromGrid } from "../core/tabular";
import { applyMapping, type FieldMap, type MappingSpec } from "../core/mapping";
import { ValidationError } from "../core/errors";
import { LINE_FIELDS, HEADER_FIELDS } from "./fields";

export const LINE_SPEC: MappingSpec = { entity: "ExtractedLine", fields: LINE_FIELDS.map((f) => ({ name: f, type: f === "quantity" ? "number" : f === "unitPrice" || f === "extendedPrice" ? "money" : f === "lineDate" ? "date" : "string", description: f })) };

/** Loose defaults: common header spellings. A company overrides per document type. */
export const MANUAL_DEFAULT_MAPPING: FieldMap = {
  competitorSku: { source: "Competitor Code" }, description: { source: "Description" }, manufacturer: { source: "Manufacturer" }, quantity: { source: "Quantity", transform: "number" }, uom: { source: "UOM" }, unitPrice: { source: "Unit Price", transform: "money" }, extendedPrice: { source: "Extended Price", transform: "money" }, lineDate: { source: "Date", transform: "date" }, tier: { source: "Tier" },
};

export class ManualExtractionProvider implements DocumentExtractionProvider {
  readonly provider = "manual";
  constructor(private mapping: FieldMap = MANUAL_DEFAULT_MAPPING, private header: Partial<Record<(typeof HEADER_FIELDS)[number], string>> = {}) {}
  async testConnection(): Promise<ConnectionTestResult> { return { ok: true, message: "Manual / CSV extraction: nothing to connect to" }; }
  async extract(req: ExtractionRequest): Promise<ExtractedDocument> {
    const grid = req.grid ?? (req.bytes ? await gridFromBuffer(req.bytes, req.filename) : null);
    if (!grid) throw new ValidationError("Manual extraction needs a CSV/XLSX table (or pasted cells)", { retryable: false });
    const { headers, rows } = rowsFromGrid(grid, 1);
    const map = looseMap(this.mapping, headers);
    const fields: ExtractedFieldRecord[] = [];
    for (const [k, v] of Object.entries(this.header)) if (v) fields.push({ scope: "HEADER", field: k, rawValue: v, normalizedValue: v, confidence: 1 });
    rows.forEach((row, i) => {
      const m = applyMapping<Record<string, unknown>>(row, map, LINE_SPEC);
      for (const f of LINE_FIELDS) {
        const raw = map[f]?.source ? row[map[f].source!] : undefined;
        if (raw === undefined || raw === null || raw === "") continue;
        const issue = m.issues.find((x) => x.field === f);
        fields.push({ scope: "LINE", lineNo: i + 1, field: f, rawValue: String(raw), normalizedValue: issue ? null : m.record[f] === undefined ? null : String(m.record[f]), confidence: issue ? 0 : 1, section: `row ${row.__row}` });
      }
    });
    return { provider: "manual", model: null, documentType: req.documentType, overallConfidence: 1, fields };
  }
}

/** Match mapping sources to the headers actually present, case-insensitively and by a few synonyms. */
export function looseMap(map: FieldMap, headers: string[]): FieldMap {
  const lower = headers.map((h) => h.toLowerCase());
  const syn: Record<string, RegExp> = { competitorSku: /code|cfn|sku|catalog|part|item ?(no|number)/, description: /desc/, manufacturer: /manufacturer|vendor|mfg|brand/, quantity: /^qty|quantity/, uom: /uom|unit of measure|^unit$/, unitPrice: /unit price|^price|each/, extendedPrice: /extended|ext\.? ?price|total/, lineDate: /date/, tier: /tier/ };
  const out: FieldMap = {};
  for (const [k, rule] of Object.entries(map)) {
    if (rule.source && lower.includes(rule.source.toLowerCase())) { out[k] = { ...rule, source: headers[lower.indexOf(rule.source.toLowerCase())] }; continue; }
    const re = syn[k]; const i = re ? lower.findIndex((h) => re.test(h)) : -1;
    if (i >= 0) out[k] = { ...rule, source: headers[i] };
  }
  return out;
}

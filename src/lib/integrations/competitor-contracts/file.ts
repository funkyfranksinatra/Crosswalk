/** File-based competitor contract-price adapter (CSV / XLSX from a directory, SFTP or upload). */
import type { CompetitorContractPriceAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { CompetitorPriceImportRecord } from "../types";
import { applyMapping, mergeMapping, type FieldMap } from "../core/mapping";
import { gridFromBuffer, locateFile, rowsFromGrid, type FileSource } from "../core/tabular";
import { CONTRACT_PRICE_SPEC, CONTRACT_PRICE_DEFAULT_MAPPING } from "./mapping";

export class FileContractPriceAdapter implements CompetitorContractPriceAdapter {
  readonly provider = "file";
  constructor(private cfg: { source: FileSource; sheet?: string | null; headerRow?: number; mapping?: FieldMap | null; sourceOwner?: string | null; defaultGpo?: string | null }) {}
  async testConnection(): Promise<ConnectionTestResult> {
    const f = await locateFile(this.cfg.source);
    if (!f) return { ok: false, message: "No contract-price file found at the configured location" };
    const { headers, rows } = rowsFromGrid(await gridFromBuffer(f.buffer, f.name, this.cfg.sheet), this.cfg.headerRow ?? 1);
    const map = mergeMapping(CONTRACT_PRICE_DEFAULT_MAPPING, this.cfg.mapping);
    const required = CONTRACT_PRICE_SPEC.fields.filter((x) => x.required).map((x) => x.name).filter((n) => { const r = map[n]; return !r?.source || !headers.some((h) => h.toLowerCase() === r.source!.toLowerCase()); });
    if (required.length) return { ok: false, message: `${f.name}: required columns not found for ${required.join(", ")}; headers: ${headers.slice(0, 12).join(" | ")}`, details: { headers } };
    return { ok: true, message: `${f.name}: ${rows.length} rows`, details: { file: f.name, rows: rows.length, headers } };
  }
  async fetchContractPrices(opts?: PullOptions): Promise<Page<CompetitorPriceImportRecord>> {
    const f = await locateFile(this.cfg.source);
    if (!f) return { records: [], nextCursor: null };
    if (opts?.cursor === `file:${f.hash}`) return { records: [], nextCursor: null };
    const { rows } = rowsFromGrid(await gridFromBuffer(f.buffer, f.name, this.cfg.sheet), this.cfg.headerRow ?? 1);
    const map = mergeMapping(CONTRACT_PRICE_DEFAULT_MAPPING, this.cfg.mapping);
    const records: CompetitorPriceImportRecord[] = [];
    const rejected: { externalId: string | null; message: string }[] = [];
    for (const row of rows) {
      const m = applyMapping<Record<string, unknown>>(row, map, CONTRACT_PRICE_SPEC);
      const rowNo = Number(row.__row);
      const errors = m.issues.filter((i) => i.level === "error");
      // reported as a row error; the rest of the file still loads
      if (errors.length) { rejected.push({ externalId: `${f.name}#${rowNo}`, message: `${f.name} row ${rowNo}: ${errors.map((e) => e.message).join("; ")}` }); continue; }
      const r = m.record;
      records.push({ gpoName: (r.gpoName as string) ?? this.cfg.defaultGpo ?? null, competitorName: String(r.competitorName), competitorSku: String(r.competitorSku), description: (r.description as string) ?? null, price: String(r.price), currency: (r.currency as string) ?? "USD", uom: (r.uom as string) ?? "EA", tier: (r.tier as string) ?? null, effectiveFrom: (r.effectiveFrom as string) ?? null, effectiveTo: (r.effectiveTo as string) ?? null, contractRef: (r.contractRef as string) ?? null, sourceOwner: (r.sourceOwner as string) ?? this.cfg.sourceOwner ?? null, provenance: { provider: "file", sourceSystem: f.name, sourceRecordId: `${f.name}#${rowNo}`, sourceUpdatedAt: f.modifiedAt?.toISOString() ?? null, meta: { row: rowNo, packSize: r.packSize ?? null, fileHash: f.hash } } });
    }
    return { records, nextCursor: null, rejected };
  }
}

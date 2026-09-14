/**
 * Bulk import of competitor price observations from a sheet / csv / Sheets link.
 * Columns (loose): Competitor, Competitor Code, Price, Currency, UOM, Account Number,
 * GPO, Region, Observed Date, Source Type, Source Reference, Notes.
 * Every row keeps its provenance (source type + reference + optional document).
 */
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { recordObservation, SOURCE_TYPES } from "./index";

export type ImportResult = { recorded: number; rows: number; skipped: { row: number; reason: string }[] };

function readGrid(ws: ExcelJS.Worksheet): (string | number | null)[][] {
  const grid: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => { const cells: (string | number | null)[] = []; row.eachCell({ includeEmpty: true }, (cell, c) => { const v = cell.value; cells[c - 1] = typeof v === "number" ? v : v == null ? null : v instanceof Date ? v.toISOString() : typeof v === "object" && "result" in v ? (v.result as string | number) : String(v); }); grid[r - 1] = cells; });
  return grid;
}
export async function importObservationsXlsx(actorUserId: string, buffer: Buffer, documentId?: string | null) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0]; if (!ws) throw new Error("Workbook has no sheets");
  return importObservationRows(actorUserId, readGrid(ws), documentId);
}
export async function importObservationRows(actorUserId: string, grid: (string | number | null | undefined)[][], documentId?: string | null): Promise<ImportResult> {
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const col = (re: RegExp) => { const i = header.findIndex((h) => re.test(h)); return i < 0 ? null : i; };
  const cComp = col(/^(competitor|manufacturer|vendor)( name)?$/), cCode = col(/code|cfn|sku|catalog|part/), cPrice = col(/^(price|unit price|observed price)/), cCcy = col(/currency/), cUom = col(/uom|unit of measure/), cAcc = col(/account/), cGpo = col(/gpo/), cRegion = col(/region/), cDate = col(/date|observed/), cSource = col(/source type|source$/), cRef = col(/reference|invoice|po number|document/), cNotes = col(/note/);
  if (cCode === null || cPrice === null || cComp === null) throw new Error("Need Competitor, Competitor Code and Price columns");
  const res: ImportResult = { recorded: 0, rows: 0, skipped: [] };
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? []; const at = (i: number | null) => (i === null ? null : row[i] ?? null);
    if (!at(cCode)) continue; res.rows++;
    try {
      const accNum = at(cAcc) ? String(at(cAcc)) : null;
      const acc = accNum ? await prisma.account.findFirst({ where: { OR: [{ accountNumber: accNum }, { name: accNum }] } }) : null;
      const gpoName = at(cGpo) ? String(at(cGpo)) : null;
      const gpo = gpoName ? await prisma.gpo.findFirst({ where: { name: { equals: gpoName, mode: "insensitive" } } }) : null;
      const st = String(at(cSource) ?? "REP_OBSERVED").toUpperCase().replace(/[^A-Z]+/g, "_");
      await recordObservation(actorUserId, { competitorName: String(at(cComp)), competitorSku: String(at(cCode)), price: at(cPrice), currency: at(cCcy) ? String(at(cCcy)) : "USD", uom: at(cUom) ? String(at(cUom)) : "EA", accountId: acc?.id ?? null, gpoId: gpo?.id ?? null, region: at(cRegion) ? String(at(cRegion)) : acc?.region ?? null, observedAt: at(cDate) ? new Date(String(at(cDate))) : new Date(), sourceType: SOURCE_TYPES.includes(st as never) ? st : "REP_OBSERVED", sourceRef: at(cRef) ? String(at(cRef)) : null, documentId: documentId ?? null, notes: at(cNotes) ? String(at(cNotes)) : null });
      res.recorded++;
    } catch (e) { res.skipped.push({ row: r + 1, reason: e instanceof Error ? e.message : String(e) }); }
  }
  return res;
}

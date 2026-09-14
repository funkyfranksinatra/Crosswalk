/**
 * Parse a sales-rep intake — from an .xlsx upload, a CSV, or a Google Sheet.
 * The canonical shape is two columns (ProductCode, Quantity) but reps send
 * what they have, so we find the header row by name, fall back to
 * "first column + next numeric column", aggregate repeated codes, and
 * report what we skipped. All sources reduce to a grid of cells first.
 */
import ExcelJS from "exceljs";
import { normalizeCfn, looksLikeCfn } from "@/lib/cfn";
import { parseCsv } from "@/lib/sheets/csv";
import { fetchSheetRows, parseSheetLink, SheetAccessError } from "@/lib/sheets/google";

export type IntakeLine = { rawCode: string; cfnNorm: string; quantity: number; estPrice: number | null; sourceRows: number[] };
export type IntakeResult = {
  lines: IntakeLine[];
  sheet: string;
  source: { kind: "xlsx" | "csv" | "google-sheet"; name: string; url?: string; via?: string };
  skipped: { row: number; reason: string; value: string }[];
  detectedColumns: { code: number; qty: number | null; price: number | null; headerRow: number | null };
  duplicatesMerged: number;
};

const CODE_HEADERS = /^(product\s*code|productcode|cfn|catalog(ue)?\s*(no|number|#)?|item\s*(no|number|#|code)?|sku|part\s*(no|number|#)?|competitor\s*product|code|material)$/i;
const QTY_HEADERS = /^(qty|quantity|annual\s*qty|annual\s*quantity|units|usage|volume|amount|count|qty\s*purchased)$/i;
const PRICE_HEADERS = /^(price|unit\s*price|est(imated)?\s*(competitor\s*)?price|current\s*price|cost|avg\s*price)$/i;

type Cell = string | number | null;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("richText" in o) return (o.richText as { text: string }[]).map((r) => r.text).join("");
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return String(o.text);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

function cellNumber(v: Cell): number | null {
  if (typeof v === "number") return v;
  const t = (v ?? "").replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Core parser over a plain grid (1-based rows/cols in the result for humans). */
export function parseIntakeGrid(grid: Cell[][], sheet: string, source: IntakeResult["source"]): IntakeResult {
  let headerRow: number | null = null;
  let codeCol = -1;
  let qtyCol: number | null = null;
  let priceCol: number | null = null;

  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const row = grid[r] ?? [];
    let c = -1, qc: number | null = null, pc: number | null = null;
    row.forEach((cell, i) => {
      const t = cellText(cell).trim();
      if (!t) return;
      if (c < 0 && CODE_HEADERS.test(t)) c = i;
      else if (qc == null && QTY_HEADERS.test(t)) qc = i;
      else if (pc == null && PRICE_HEADERS.test(t)) pc = i;
    });
    if (c >= 0) { headerRow = r; codeCol = c; qtyCol = qc; priceCol = pc; break; }
  }
  if (codeCol < 0) {
    codeCol = 0;
    qtyCol = 1;
    headerRow = null;
    const first = cellText(grid[0]?.[0]);
    if (first && !looksLikeCfn(normalizeCfn(first))) headerRow = 0;
  }

  const byCode = new Map<string, IntakeLine>();
  const skipped: IntakeResult["skipped"] = [];
  let duplicatesMerged = 0;
  for (let r = headerRow == null ? 0 : headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawVal = row[codeCol];
    const raw = cellText(rawVal).trim();
    if (!raw) continue;
    if (/^total$/i.test(raw)) continue;
    const norm = normalizeCfn(typeof rawVal === "number" ? rawVal : raw);
    if (!looksLikeCfn(norm)) { skipped.push({ row: r + 1, reason: "does not look like a catalog number", value: raw }); continue; }
    const qty = qtyCol != null ? cellNumber(row[qtyCol] ?? null) : null;
    const price = priceCol != null ? cellNumber(row[priceCol] ?? null) : null;
    const quantity = qty ?? 1;
    const existing = byCode.get(norm);
    if (existing) {
      existing.quantity += quantity;
      existing.sourceRows.push(r + 1);
      if (existing.estPrice == null && price != null) existing.estPrice = price;
      duplicatesMerged++;
    } else byCode.set(norm, { rawCode: raw, cfnNorm: norm, quantity, estPrice: price, sourceRows: [r + 1] });
  }
  return {
    lines: [...byCode.values()],
    sheet,
    source,
    skipped,
    detectedColumns: { code: codeCol + 1, qty: qtyCol == null ? null : qtyCol + 1, price: priceCol == null ? null : priceCol + 1, headerRow: headerRow == null ? null : headerRow + 1 },
    duplicatesMerged,
  };
}

/** .xlsx upload */
export async function parseIntake(buffer: ArrayBuffer | Buffer, fileName = "upload.xlsx"): Promise<IntakeResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets.find((w) => w.actualRowCount >= 2) ?? wb.worksheets[0];
  if (!ws) throw new Error("Workbook has no sheets");
  const grid: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    const cells: Cell[] = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const v = cell.value;
      cells[c - 1] = typeof v === "number" ? v : cellText(v);
    });
    grid[r - 1] = cells;
  });
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return parseIntakeGrid(grid, ws.name, { kind: "xlsx", name: fileName });
}

/** CSV text (a Google Sheets "Download → CSV", or anything else) */
export function parseIntakeCsv(text: string, name = "intake.csv"): IntakeResult {
  return parseIntakeGrid(parseCsv(text), name.replace(/\.csv$/i, ""), { kind: "csv", name });
}

/** Google Sheets link — public (anyone with the link) or shared with the service account */
export async function parseIntakeFromSheetLink(link: string): Promise<IntakeResult> {
  const ref = parseSheetLink(link);
  if (!ref) throw new SheetAccessError("That doesn't look like a Google Sheets link.", "Paste the URL from the browser address bar (docs.google.com/spreadsheets/d/…).");
  const { rows, title, via } = await fetchSheetRows(ref);
  return parseIntakeGrid(rows, title, { kind: "google-sheet", name: title, url: ref.url, via });
}

/** Any of the above, by sniffing what we were given. */
export async function parseIntakeAny(input: { file?: File | null; sheetUrl?: string | null; csvText?: string | null; csvName?: string | null }): Promise<IntakeResult> {
  if (input.sheetUrl?.trim()) return parseIntakeFromSheetLink(input.sheetUrl);
  if (input.csvText?.trim()) return parseIntakeCsv(input.csvText, input.csvName || "Pasted cells");
  if (input.file) {
    if (/\.csv$/i.test(input.file.name) || input.file.type === "text/csv") return parseIntakeCsv(await input.file.text(), input.file.name);
    return parseIntake(Buffer.from(await input.file.arrayBuffer()), input.file.name);
  }
  throw new Error("Provide an .xlsx/.csv file or a Google Sheets link");
}

/**
 * Excel exports.
 *  1. Cross-reference workbook — the rep's working file. Same column order as
 *     the legacy BAT "SSXrefReport" so existing habits (and downstream macros)
 *     keep working, plus next-best options, confidence and rationale.
 *  2. Contract offer — customer-facing. Only selected products, no internal
 *     cost, margin or reasoning.
 */
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { num, times, round, ZERO } from "@/lib/money";

const INK = "FF16181D";
const TEAL = "FF0E6B6B";
const TEAL_SOFT = "FFE3F1EF";
const LINE = "FFE4E2DC";
const MUTED = "FF6B7079";
const MATCH_FILL: Record<string, string> = { "Exact Match": "FFE2F3E8", "Close Match": "FFE3F1EF", "Alternative Match": "FFFBF0D6", "No Match": "FFFCE8E6", "Competitor Product Not Found": "FFF3F2EE" };

const money = '"$"#,##0.00';

async function loadRequest(requestId: string) {
  return prisma.request.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      company: true,
      pricebook: true,
      lines: { orderBy: { lineNo: "asc" }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } },
    },
  });
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 30;
}

function border(row: ExcelJS.Row, count: number) {
  for (let c = 1; c <= count; c++) row.getCell(c).border = { bottom: { style: "thin", color: { argb: LINE } } };
}

export type Hide = { cost?: boolean; margin?: boolean };

export async function buildCrossReferenceWorkbook(requestId: string, hide: Hide = {}): Promise<{ buffer: Buffer; filename: string }> {
  const r = await loadRequest(requestId);
  const us = r.company.name;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Crosswalk";
  wb.created = new Date();

  // ---- Sheet 1: Cross Reference -------------------------------------------
  const ws = wb.addWorksheet("Competitor Usage Xref", { views: [{ state: "frozen", ySplit: 3 }] });
  const headers = xrefHeaders(us);
  ws.mergeCells(1, 1, 1, headers.length);
  ws.getCell(1, 1).value = `Competitor Cross Reference to ${us} Products`;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: TEAL } };
  ws.mergeCells(2, 1, 2, headers.length);
  ws.getCell(2, 1).value = `Account: ${r.accountNumber ?? "—"} ${r.accountName ?? ""} · ${r.reference} · ${new Date().toLocaleDateString("en-US")} · Pricebook: ${r.pricebook?.name ?? "List price"}`;
  ws.getCell(2, 1).font = { color: { argb: MUTED } };
  styleHeader(ws.addRow(headers));

  const x = xrefRows(r);
  for (const { cells, matchType } of x.rows) {
    const row = ws.addRow(cells);
    row.getCell(15).fill = { type: "pattern", pattern: "solid", fgColor: { argb: MATCH_FILL[matchType] ?? "FFFFFFFF" } };
    row.getCell(16).numFmt = "0%";
    for (const c of [5, 6, 13, 14]) row.getCell(c).numFmt = money;
    border(row, headers.length);
  }
  const totalRow = ws.addRow(x.total);
  totalRow.font = { bold: true };
  totalRow.getCell(6).numFmt = money;
  totalRow.getCell(14).numFmt = money;
  ws.columns = headers.map((h, i) => ({ width: [3, 8, 18, 20, 23].includes(i + 1) ? 48 : [1, 7, 15, 19, 22].includes(i + 1) ? 22 : 14 }));
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: headers.length } };

  // ---- Sheet 2: All candidates ----------------------------------------------
  const wc = wb.addWorksheet("All Candidates", { views: [{ state: "frozen", ySplit: 1 }] });
  const ch = ["Competitor Product", "Competitor Description", "Rank", `${us} SKU`, `${us} Description`, "Match Type", "Source", "Composite", "Attribute Fit", "Price Fit", "COGS Fit", "Margin Fit", "Unit Price", "Extended", "Selected", "Rationale"];
  styleHeader(wc.addRow(ch));
  for (const line of r.lines) {
    for (const c of line.candidates) {
      const row = wc.addRow([
        line.rawCode, line.competitorProduct?.description ?? "", c.rank, c.ownProduct.sku, c.ownProduct.description, c.matchType, c.source,
        c.score, c.scoreBin, c.scorePrice, hide.cost ? null : c.scoreCogs, hide.margin ? null : c.scoreMargin, num(c.unitPrice), cents(times(c.unitPrice, line.quantity)),
        line.selectedCandidateId === c.id ? "Yes" : "", c.rationale ?? "",
      ]);
      for (const k of [8, 9, 10, 11, 12]) row.getCell(k).numFmt = "0%";
      row.getCell(13).numFmt = money;
      row.getCell(14).numFmt = money;
      row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: MATCH_FILL[c.matchType] ?? "FFFFFFFF" } };
    }
  }
  wc.columns = ch.map((h, i) => ({ width: [2, 5, 16].includes(i + 1) ? 50 : 14 }));
  wc.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ch.length } };

  // ---- Sheet 3: Unresolved --------------------------------------------------
  const wu = wb.addWorksheet("Unresolved");
  styleHeader(wu.addRow(["Competitor Product", "Quantity", "Status", "Note", "Suggested manufacturer"]));
  for (const line of r.lines) {
    if (line.resolutionStatus === "resolved" && line.matchStatus === "matched") continue;
    wu.addRow([line.rawCode, line.quantity, line.resolutionStatus === "resolved" ? "Resolved, no match" : "Not found in GUDID", line.resolutionNote ?? "", line.competitorProduct?.manufacturer ?? ""]);
  }
  wu.columns = [{ width: 22 }, { width: 10 }, { width: 22 }, { width: 70 }, { width: 24 }];

  // ---- Sheet 4: Run info -----------------------------------------------------
  const wi = wb.addWorksheet("Run Info");
  const info: [string, string][] = [
    ["Request", r.reference], ["Account", `${r.accountNumber ?? ""} ${r.accountName ?? ""}`.trim()], ["Report type", r.reportType],
    ["Pricebook", r.pricebook?.name ?? "List price"], ["Source file", r.sourceFileName ?? ""], ["Generated", new Date().toISOString()],
    ["Lines", String(r.lines.length)], ["Resolved", String(r.lines.filter((l) => l.resolutionStatus === "resolved").length)], ["Matched", String(r.lines.filter((l) => l.matchStatus === "matched").length)],
    ["Data sources", "openFDA Device UDI (AccessGUDID mirror), curated cross-reference sheet, Crosswalk attribute matcher"],
  ];
  for (const [k, v] of info) { const row = wi.addRow([k, v]); row.getCell(1).font = { bold: true }; }
  wi.columns = [{ width: 18 }, { width: 90 }];

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `Crosswalk_XrefReport_${r.reference}_${stamp()}.xlsx` };
}

export async function buildContractOfferWorkbook(requestId: string): Promise<{ buffer: Buffer; filename: string }> {
  const r = await loadRequest(requestId);
  const us = r.company.name;
  const wb = new ExcelJS.Workbook();
  wb.creator = us;
  const ws = wb.addWorksheet("Proposal", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 4 }, { width: 22 }, { width: 46 }, { width: 22 }, { width: 46 }, { width: 10 }, { width: 16 }, { width: 18 }];

  ws.mergeCells("B2:H2");
  ws.getCell("B2").value = `${us} — Product Conversion Proposal`;
  ws.getCell("B2").font = { bold: true, size: 18, color: { argb: TEAL } };
  ws.mergeCells("B3:H3");
  ws.getCell("B3").value = `Prepared for ${r.accountName ?? "Customer"}${r.accountNumber ? ` (Account ${r.accountNumber})` : ""}`;
  ws.getCell("B3").font = { size: 12 };
  ws.mergeCells("B4:H4");
  ws.getCell("B4").value = `Reference ${r.reference} · Prepared ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })} · Pricing basis: ${r.pricebook?.name ?? "List price"} · Valid 90 days`;
  ws.getCell("B4").font = { color: { argb: MUTED } };

  const headerRow = ws.getRow(6);
  const heads = ["", "Current Product", "Current Product Description", `${us} Equivalent`, `${us} Product Description`, "Annual Qty", "Unit Price", "Extended"];
  heads.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  for (let c = 2; c <= 8; c++) headerRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } };
  headerRow.height = 24;

  const o = offerRows(r);
  let n = 0;
  for (const cells of o.rows) {
    const row = ws.addRow(["", ...cells]);
    row.getCell(7).numFmt = money;
    row.getCell(8).numFmt = money;
    row.alignment = { vertical: "top", wrapText: true };
    if (n % 2 === 1) for (let c = 2; c <= 8; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F6F3" } };
    for (let c = 2; c <= 8; c++) row.getCell(c).border = { bottom: { style: "hair", color: { argb: LINE } } };
    n++;
  }
  const total = o.total;
  const t = ws.addRow(["", "", "", "", "", "", "Total", total]);
  t.font = { bold: true };
  t.getCell(8).numFmt = money;
  t.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL_SOFT } };
  ws.addRow([]);
  const notes = ws.addRow(["", "Notes"]);
  notes.font = { bold: true };
  for (const s of o.notes) { ws.mergeCells(`B${ws.rowCount + 1}:H${ws.rowCount + 1}`); const row = ws.getRow(ws.rowCount); row.getCell(2).value = s; row.getCell(2).alignment = { wrapText: true }; row.height = 30; }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `${us}_Proposal_${(r.accountName ?? r.reference).replace(/[^A-Za-z0-9]+/g, "_")}_${stamp()}.xlsx` };
}

// ---------------------------------------------------------------------------
// Shared row builders (used by the .xlsx writers and the CSV / Google Sheets paths)
// ---------------------------------------------------------------------------

type Loaded = Awaited<ReturnType<typeof loadRequest>>;
type CellValue = string | number | null;

export function xrefHeaders(us: string): string[] {
  return [
    "Competitor Name", "Competitor Product", "Competitor Product Description", "Quantity", "Estimated Competitor Price", "Extended Dollars",
    `${us} Product Match`, `${us} Product Description`, "Additional Products Needed", "Item Product Category", `${us} Quantity`,
    `${us} Current PriceBook`, `${us} Current Price`, `${us} Extended Dollars`, "Match Type",
    "Confidence", "Match Source", "Rationale", "Next Best 1", "Next Best 1 Description", "Next Best 1 Type", "Next Best 2", "Next Best 2 Description", "Next Best 2 Type", "GUDID DI", "Resolution",
  ];
}

/** Cells are numbers for Excel; arithmetic happens in Decimal (src/lib/money) and is rounded to cents here. */
/** Money cell from a decimal product, rounded to cents with banker's rounding (never float×100). */
const cents = (v: import("decimal.js").default | null | undefined): number | null => (v == null ? null : num(round(v)));

function xrefRows(r: Loaded): { rows: { cells: CellValue[]; matchType: string }[]; total: CellValue[] } {
  let compTotal = ZERO;
  let ourTotal = ZERO;
  const rows: { cells: CellValue[]; matchType: string }[] = [];
  for (const line of r.lines) {
    const cp = line.competitorProduct;
    const sel = line.candidates.find((c) => c.id === line.selectedCandidateId) ?? line.candidates.find((c) => c.isSelected) ?? null;
    const others = line.candidates.filter((c) => c.id !== sel?.id && c.matchType !== "No Match").slice(0, 2);
    const notFound = !cp || cp.resolution === "not-found";
    const compExt = cents(times(line.estCompetitorPrice, line.quantity));
    const ourExt = cents(times(sel?.unitPrice, line.quantity));
    compTotal = compTotal.plus(compExt ?? 0);
    ourTotal = ourTotal.plus(ourExt ?? 0);
    const matchType = sel ? sel.matchType : notFound ? "Competitor Product Not Found" : "No Match";
    rows.push({
      matchType,
      cells: [
        cp?.manufacturer ?? "Unknown",
        line.rawCode,
        notFound && !cp?.description ? "Not Found" : cp?.description ?? "",
        line.quantity,
        num(line.estCompetitorPrice),
        compExt,
        sel?.ownProduct.sku ?? "NO MATCH",
        sel?.ownProduct.description ?? "",
        sel?.additionalProducts ?? "",
        sel?.ownProduct.category ?? cp?.category ?? (notFound ? "NO MATCH" : ""),
        line.quantity,
        sel ? (sel.unitPrice != null ? r.pricebook?.name ?? "LIST PRICE" : "No price on file") : "No Price Book found",
        num(sel?.unitPrice),
        ourExt,
        matchType,
        sel ? Math.round(sel.score * 100) / 100 : null,
        sel?.source ?? "",
        sel?.rationale ?? line.resolutionNote ?? "",
        others[0]?.ownProduct.sku ?? "",
        others[0]?.ownProduct.description ?? "",
        others[0]?.matchType ?? "",
        others[1]?.ownProduct.sku ?? "",
        others[1]?.ownProduct.description ?? "",
        others[1]?.matchType ?? "",
        cp?.gudidDi ?? "",
        cp?.resolutionNote ?? "",
      ],
    });
  }
  const total: CellValue[] = ["TOTAL", "", "", r.lines.reduce((a, l) => a + l.quantity, 0), "", compTotal.isZero() ? null : num(round(compTotal)), "", "", "", "", "", "", "", ourTotal.isZero() ? null : num(round(ourTotal)), ""];
  return { rows, total };
}

function offerRows(r: Loaded): { rows: CellValue[][]; total: number; notes: string[] } {
  let total = ZERO;
  const rows: CellValue[][] = [];
  for (const line of r.lines) {
    const sel = line.candidates.find((c) => c.id === line.selectedCandidateId) ?? line.candidates.find((c) => c.isSelected);
    if (!sel || sel.matchType === "No Match") continue;
    const ext = cents(times(sel.unitPrice, line.quantity));
    total = total.plus(ext ?? 0);
    rows.push([line.rawCode, line.competitorProduct?.description ?? "", sel.ownProduct.sku, sel.ownProduct.description + (sel.additionalProducts ? ` (requires ${sel.additionalProducts})` : ""), line.quantity, num(sel.unitPrice), ext]);
  }
  const unmatched = r.lines.filter((l) => !l.candidates.some((c) => c.id === l.selectedCandidateId && c.matchType !== "No Match"));
  const notes = [
    "Equivalents are proposed on the basis of intended use, size and construction; clinical evaluation by your staff is recommended before conversion.",
    unmatched.length ? `${unmatched.length} item(s) on your usage list were not included in this proposal (${unmatched.slice(0, 8).map((l) => l.rawCode).join(", ")}${unmatched.length > 8 ? ", …" : ""}). Your representative will follow up on these.` : "All items on your usage list are covered by this proposal.",
    "Prices are per unit in USD and exclude tax and freight unless otherwise agreed.",
  ];
  return { rows, total: num(round(total)) ?? 0, notes };
}

/** CSV-friendly rows for the rep workbook (main sheet only). */
export async function buildCrossReferenceRows(requestId: string, _hide: Hide = {}): Promise<{ rows: CellValue[][]; filename: string }> {
  // The main sheet carries no cost or margin columns; `_hide` is accepted for symmetry with the workbook.
  const r = await loadRequest(requestId);
  const x = xrefRows(r);
  return { rows: [xrefHeaders(r.company.name), ...x.rows.map((row) => row.cells), x.total], filename: `Crosswalk_XrefReport_${r.reference}_${stamp()}.xlsx` };
}

/** CSV-friendly rows for the customer proposal. */
export async function buildContractOfferRows(requestId: string): Promise<{ rows: CellValue[][]; filename: string }> {
  const r = await loadRequest(requestId);
  const us = r.company.name;
  const o = offerRows(r);
  const rows: CellValue[][] = [
    [`${us} — Product Conversion Proposal`],
    [`Prepared for ${r.accountName ?? "Customer"}${r.accountNumber ? ` (Account ${r.accountNumber})` : ""}`],
    [`Reference ${r.reference} · Prepared ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })} · Pricing basis: ${r.pricebook?.name ?? "List price"} · Valid 90 days`],
    [],
    ["Current Product", "Current Product Description", `${us} Equivalent`, `${us} Product Description`, "Annual Qty", "Unit Price", "Extended"],
    ...o.rows,
    ["", "", "", "", "", "Total", o.total],
    [],
    ["Notes"],
    ...o.notes.map((n) => [n]),
  ];
  return { rows, filename: `${us}_Proposal_${(r.accountName ?? r.reference).replace(/[^A-Za-z0-9]+/g, "_")}_${stamp()}.xlsx` };
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}

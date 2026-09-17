/**
 * Customer-facing quote from an approved proposal. Rendered from the proposal's own
 * snapshot lines (never live tables). Gated by the approval state; every export is audited.
 */
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, num, times, round, ZERO } from "@/lib/money";
import { finalizeCheck } from "@/lib/approvals/service";
import { toCsv } from "@/lib/sheets/csv";
import { quoteTotals } from "@/lib/tax";

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1_$2");

export async function quoteRows(proposalId: string) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true, lines: { orderBy: { lineNo: "asc" } } } });
  const rows: (string | number | null)[][] = [["Current Product", "Current Product Description", "Proposed Equivalent", "Description", "Equivalence", "Annual Qty", "Unit Price", "Extended", "Notes"]];
  // Contractual figures: decimal all the way, rounded to the currency's minor unit only for display.
  let total = ZERO;
  for (const l of p.lines) {
    if (!l.included || !money(l.proposedPrice)) continue;
    const ext = round(times(l.proposedPrice, l.quantity)!, p.currency);
    total = total.plus(ext);
    // The customer sees the customer note only; justification is the internal case made to approvers.
    rows.push([l.competitorCode, l.competitorDescription ?? "", l.sku ?? "", l.description ?? "", (l.equivalenceLevel ?? "").replace(/_/g, " ").toLowerCase(), num(l.quantity), num(round(money(l.proposedPrice)!, p.currency)), num(ext), l.customerNote ?? ""]);
  }
  // Quote-level freight and tax (Tier 3): the same figures the PDF prints, never part of a line.
  const t = await quoteTotals(proposalId);
  rows.push(["SUBTOTAL", "", "", "", "", null, null, num(round(total, p.currency)), ""]);
  if (t.freightMode !== "NONE") rows.push([t.freightMode === "PCT" ? `FREIGHT (${p.freightValue?.toString() ?? "0"}%)` : "FREIGHT", "", "", "", "", null, null, num(t.freight), ""]);
  if (t.taxMode !== "NONE") rows.push([t.taxMode === "EXEMPT" ? `TAX (exempt${p.taxExemptionNo ? ` · ${p.taxExemptionNo}` : ""})` : `TAX${t.taxNote ? ` (${t.taxNote})` : ""}`, "", "", "", "", null, null, num(t.tax ?? ZERO), ""]);
  rows.push(["TOTAL", "", "", "", "", null, null, num(t.total), t.taxMode === "NONE" ? "excludes tax" : ""]);
  return { proposal: p, rows, total: num(t.total)!, taxStale: t.taxStale };
}

export async function buildQuote(actor: Actor, proposalId: string, format: "xlsx" | "csv") {
  requirePermission(actor, "export_proposals");
  const f = await finalizeCheck(proposalId);
  if (!f.ok) throw new Error(`Quote is locked until approval is complete: ${f.reason}`);
  const { proposal: p, rows, taxStale } = await quoteRows(proposalId);
  if (taxStale) throw new Error("Tax was calculated before the latest price or freight change — recalculate it (Freight & tax) before exporting");
  const filename = `Crosswalk_Quote_${p.reference}_${p.account.name.replace(/[^A-Za-z0-9]+/g, "_")}_${stamp()}.${format}`;
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "EXPORTED", context: { format, filename, validThrough: p.validThrough?.toISOString() ?? null } });
  if (format === "csv") return { filename, buffer: Buffer.from(toCsv(rows), "utf8"), contentType: "text/csv; charset=utf-8" };
  const wb = new ExcelJS.Workbook();
  wb.creator = "Crosswalk";
  const ws = wb.addWorksheet("Proposal");
  ws.addRow([`Proposal ${p.reference} — ${p.account.name}`]).font = { bold: true, size: 14 };
  ws.addRow([`Prepared ${new Date().toISOString().slice(0, 10)} · valid through ${p.validThrough?.toISOString().slice(0, 10) ?? "—"} · currency ${p.currency}${p.gpoNameSnapshot ? ` · ${p.gpoNameSnapshot}` : ""}`]);
  ws.addRow([]);
  for (const r of rows) ws.addRow(r);
  ws.getRow(4).font = { bold: true };
  ws.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3F1EF" } };
  ws.columns = [{ width: 18 }, { width: 48 }, { width: 18 }, { width: 48 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 16 }, { width: 40 }];
  for (let i = 5; i <= ws.rowCount; i++) { ws.getRow(i).getCell(7).numFmt = '"$"#,##0.00'; ws.getRow(i).getCell(8).numFmt = '"$"#,##0.00'; }
  ws.getRow(ws.rowCount).font = { bold: true };
  ws.addRow([]);
  ws.addRow([`Equivalents are proposed on the basis of the published clinical cross-reference; clinical evaluation by your staff is recommended before conversion. Prices are per unit${p.taxMode === "NONE" ? "; tax is excluded" : ""}${p.freightMode === "NONE" ? "; freight is not included unless otherwise agreed" : ""}.`]);
  ws.views = [{ state: "frozen", ySplit: 4 }];
  return { filename, buffer: Buffer.from(await wb.xlsx.writeBuffer()), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

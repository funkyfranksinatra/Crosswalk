/**
 * Branded customer-facing PDFs (Tier 3.4): the quotation from an approved proposal and the
 * contract offer from a cross-reference run. One renderer (`renderDocument`) draws a
 * letterhead from the Branding settings (logo, legal name, address, colours), a line table
 * that paginates, the totals block (subtotal, freight, tax, total) and the terms. pdfkit,
 * server-side, no browser. Money arrives already rounded as strings; nothing is computed here.
 */
import PDFDocument from "pdfkit";
import type { Branding } from "@/lib/branding";

export type DocLine = { code: string; codeDescription: string; sku: string; description: string; equivalence?: string | null; qty: string; unit: string; extended: string; note?: string | null };
export type DocTotals = { subtotal: string; freight?: string | null; freightLabel?: string | null; tax?: string | null; taxLabel?: string | null; total: string; currency: string };
export type DocSpec = {
  kind: "quote" | "offer";
  title: string;
  reference: string;
  customer: { name: string; accountNumber?: string | null; address?: string[] | null };
  preparedBy?: { name: string; email?: string | null } | null;
  date: Date;
  validThrough?: Date | null;
  intro?: string | null;
  lines: DocLine[];
  totals: DocTotals;
  notes: string[];
  terms: string;
  branding: Branding;
};

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const fmtMoney = (v: string, ccy: string) => { const n = Number(v); if (!Number.isFinite(n)) return v; return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, minimumFractionDigits: 2 }).format(n); };
const fmtQty = (v: string) => { const n = Number(v); return Number.isFinite(n) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n) : v; };
const hex = (h: string) => h;

/** Number of pages in a rendered PDF (for tests and the audit context). */
export function pdfPageCount(buf: Buffer): number {
  const m = buf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

/** Render to a Buffer. Pure with respect to the database. */
export function renderDocument(spec: DocSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, bufferPages: true, info: { Title: `${spec.title} ${spec.reference}`, Author: spec.branding.legalName, Creator: "Crosswalk" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try { draw(doc, spec); doc.end(); } catch (e) { reject(e); }
  });
}

const PAGE_W = 612, MARGIN = 48, CONTENT_W = PAGE_W - MARGIN * 2;
// Widths sum to CONTENT_W (516). Money columns are wide enough for "$1,234,567.89" at 8 pt Helvetica;
// the code / SKU columns (Courier 8 pt = 4.8 pt per character) hold 15 characters — a 14-digit GUDID
// DI or "PROXIMATE-TX60B" — without wrapping mid-code.
const COLS = [
  { key: "code", label: "Current", w: 80 },
  { key: "codeDescription", label: "Description", w: 116 },
  { key: "sku", label: "Proposed", w: 80 },
  { key: "description", label: "Description", w: 116 },
  { key: "qty", label: "Qty", w: 30, align: "right" as const },
  { key: "unit", label: "Unit", w: 44, align: "right" as const },
  { key: "extended", label: "Extended", w: 50, align: "right" as const },
] as const;

function draw(doc: PDFKit.PDFDocument, spec: DocSpec) {
  const b = spec.branding;
  const primary = hex(b.primaryColor), accent = hex(b.accentColor);
  let y = letterhead(doc, spec);

  // Title block
  doc.fillColor(primary).font("Helvetica-Bold").fontSize(20).text(spec.title, MARGIN, y);
  y = doc.y + 2;
  doc.fillColor("#555").font("Helvetica").fontSize(9.5).text(`Reference ${spec.reference} · ${fmtDate(spec.date)}${spec.validThrough ? ` · Valid through ${fmtDate(spec.validThrough)}` : ""}`, MARGIN, y);
  y = doc.y + 10;

  // Customer / prepared-by
  const colW = CONTENT_W / 2;
  doc.fillColor("#888").font("Helvetica-Bold").fontSize(8).text("PREPARED FOR", MARGIN, y);
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(10.5).text(spec.customer.name, MARGIN, y + 11, { width: colW - 12 });
  let cy = doc.y;
  if (spec.customer.accountNumber) { doc.font("Helvetica").fontSize(9).fillColor("#444").text(`Account ${spec.customer.accountNumber}`, MARGIN, cy, { width: colW - 12 }); cy = doc.y; }
  for (const l of spec.customer.address ?? []) { doc.font("Helvetica").fontSize(9).fillColor("#444").text(l, MARGIN, cy, { width: colW - 12 }); cy = doc.y; }
  if (spec.preparedBy) {
    doc.fillColor("#888").font("Helvetica-Bold").fontSize(8).text("PREPARED BY", MARGIN + colW, y);
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(10.5).text(spec.preparedBy.name, MARGIN + colW, y + 11, { width: colW });
    if (spec.preparedBy.email) doc.font("Helvetica").fontSize(9).fillColor("#444").text(spec.preparedBy.email, MARGIN + colW, doc.y, { width: colW });
    cy = Math.max(cy, doc.y);
  }
  y = cy + 12;
  if (spec.intro) { doc.font("Helvetica").fontSize(9.5).fillColor("#333").text(spec.intro, MARGIN, y, { width: CONTENT_W, lineGap: 1 }); y = doc.y + 10; }

  // Line table
  const header = () => {
    doc.rect(MARGIN, y, CONTENT_W, 18).fill(primary);
    let x = MARGIN + 4;
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(8);
    for (const c of COLS) { doc.text(c.label, x, y + 5, { width: c.w - 6, align: "align" in c ? c.align : "left" }); x += c.w; }
    y += 18;
    doc.fillColor("#111");
  };
  header();
  let stripe = false;
  for (const l of spec.lines) {
    const eq = l.equivalence && !/^(none|no match|-)$/i.test(l.equivalence) ? `\n(${l.equivalence})` : "";
    const cells: Record<string, string> = { code: l.code, codeDescription: l.codeDescription, sku: l.sku, description: l.description + eq, qty: fmtQty(l.qty), unit: fmtMoney(l.unit, spec.totals.currency), extended: fmtMoney(l.extended, spec.totals.currency) };
    // Measure each cell in the font it is drawn in (codes are Courier, wider than Helvetica).
    const heights = COLS.map((c) => { doc.font(c.key === "sku" || c.key === "code" ? "Courier" : "Helvetica").fontSize(8); return doc.heightOfString(cells[c.key], { width: c.w - 6 }); });
    doc.font("Helvetica").fontSize(8);
    const noteH = l.note ? doc.heightOfString(`Note: ${l.note}`, { width: CONTENT_W - 12 }) + 2 : 0;
    const rowH = Math.max(...heights) + noteH + 8;
    if (y + rowH > 792 - MARGIN - 40) { doc.addPage(); y = MARGIN; header(); stripe = false; }
    if (stripe) doc.rect(MARGIN, y, CONTENT_W, rowH).fill("#f6f6f4");
    doc.fillColor("#111");
    let x = MARGIN + 4;
    for (const c of COLS) { doc.font(c.key === "sku" || c.key === "code" ? "Courier" : "Helvetica").fontSize(8).text(cells[c.key], x, y + 4, { width: c.w - 6, align: "align" in c ? c.align : "left" }); x += c.w; }
    if (l.note) doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#555").text(`Note: ${l.note}`, MARGIN + 6, y + Math.max(...heights) + 6, { width: CONTENT_W - 12 });
    doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).lineWidth(0.3).strokeColor("#ddd").stroke();
    y += rowH; stripe = !stripe;
  }

  // Totals
  const totals: [string, string][] = [["Subtotal", fmtMoney(spec.totals.subtotal, spec.totals.currency)]];
  if (spec.totals.freight != null) totals.push([spec.totals.freightLabel ?? "Freight", fmtMoney(spec.totals.freight, spec.totals.currency)]);
  if (spec.totals.tax != null) totals.push([spec.totals.taxLabel ?? "Tax", fmtMoney(spec.totals.tax, spec.totals.currency)]);
  totals.push(["Total", fmtMoney(spec.totals.total, spec.totals.currency)]);
  // Labels may wrap ("Tax (exempt · NY-EX-123)"): each row is as tall as its label.
  const LABEL_W = 170, VALUE_W = 96;
  const rowHeights = totals.map(([label]) => { const last = label === "Total"; doc.font(last ? "Helvetica-Bold" : "Helvetica").fontSize(last ? 10 : 9); return Math.max(15, doc.heightOfString(label, { width: LABEL_W }) + 4); });
  const blockH = rowHeights.reduce((a, b) => a + b, 0) + 8;
  if (y + blockH > 792 - MARGIN - 40) { doc.addPage(); y = MARGIN; }
  y += 6;
  totals.forEach(([label, val], i) => {
    const last = label === "Total";
    if (last) { doc.moveTo(MARGIN + CONTENT_W - LABEL_W - VALUE_W - 6, y - 2).lineTo(MARGIN + CONTENT_W, y - 2).lineWidth(0.6).strokeColor(accent).stroke(); }
    doc.font(last ? "Helvetica-Bold" : "Helvetica").fontSize(last ? 10 : 9).fillColor(last ? primary : "#333");
    doc.text(label, MARGIN + CONTENT_W - LABEL_W - VALUE_W - 6, y, { width: LABEL_W, align: "right" });
    doc.text(val, MARGIN + CONTENT_W - VALUE_W, y, { width: VALUE_W, align: "right" });
    y += rowHeights[i];
  });
  if (spec.totals.tax == null) { doc.font("Helvetica-Oblique").fontSize(8).fillColor("#666").text("Prices exclude applicable taxes.", MARGIN + CONTENT_W - 272, y, { width: 272, align: "right" }); y += 12; }
  y += 8;

  // Notes + terms
  const para = (title: string, lines: string[]) => {
    if (!lines.length) return;
    const h = 14 + lines.reduce((s, t) => s + doc.heightOfString(t, { width: CONTENT_W - 10 }) + 3, 0);
    if (y + Math.min(h, 120) > 792 - MARGIN - 40) { doc.addPage(); y = MARGIN; }
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(primary).text(title.toUpperCase(), MARGIN, y); y = doc.y + 3;
    for (const t of lines) { doc.font("Helvetica").fontSize(8.5).fillColor("#333").text(`• ${t}`, MARGIN + 4, y, { width: CONTENT_W - 10, lineGap: 1 }); y = doc.y + 3; if (y > 792 - MARGIN - 40) { doc.addPage(); y = MARGIN; } }
    y += 6;
  };
  para("Notes", spec.notes);
  para("Terms", spec.terms.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean));

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // pdfkit starts a new page whenever text is placed below page.maxY() (height − bottom margin), even with
    // lineBreak:false. The footer lives in the margin, so lift the margin for the duration of the stamp.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const foot = [b.footer, [b.legalName, b.website, b.phone].filter(Boolean).join(" · ")].filter(Boolean).join("  ·  ");
    doc.font("Helvetica").fontSize(7.5).fillColor("#888").text(foot, MARGIN, 792 - MARGIN + 6, { width: CONTENT_W - 60, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN + CONTENT_W - 60, 792 - MARGIN + 6, { width: 60, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

/** Logo (if any), legal name, address block. Returns the y where content starts. */
function letterhead(doc: PDFKit.PDFDocument, spec: DocSpec): number {
  const b = spec.branding;
  let y = MARGIN;
  let textX = MARGIN;
  if (b.logoDataUrl && /^data:image\/(png|jpeg|jpg);base64,/.test(b.logoDataUrl)) {
    try {
      const buf = Buffer.from(b.logoDataUrl.split(",")[1], "base64");
      doc.image(buf, MARGIN, y, { fit: [140, 44] });
      textX = MARGIN + 152;
    } catch { /* an unreadable logo never blocks a quote */ }
  }
  doc.fillColor(b.primaryColor).font("Helvetica-Bold").fontSize(13).text(b.legalName, textX, y, { width: CONTENT_W - (textX - MARGIN) - 180 });
  let ty = doc.y;
  if (b.tagline) { doc.fillColor("#666").font("Helvetica-Oblique").fontSize(8.5).text(b.tagline, textX, ty); ty = doc.y; }
  const addr = b.address ? [b.address.line1, b.address.line2, [b.address.city, b.address.region, b.address.postalCode].filter(Boolean).join(", "), b.address.country && b.address.country !== "US" ? b.address.country : null].filter(Boolean) as string[] : [];
  const contact = [b.phone, b.email, b.website].filter(Boolean) as string[];
  const rx = MARGIN + CONTENT_W - 180;
  let ry = y;
  doc.fillColor("#444").font("Helvetica").fontSize(8);
  for (const l of [...addr, ...contact]) { doc.text(l, rx, ry, { width: 180, align: "right" }); ry = doc.y; }
  y = Math.max(ty, ry, y + 46) + 8;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(1.2).strokeColor(b.accentColor).stroke();
  return y + 14;
}

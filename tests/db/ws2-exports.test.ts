/**
 * WS2 — export content. Builds the cross-reference workbook / CSV, the contract offer
 * xlsx / csv / pdf and the quote xlsx / csv / pdf for fixtures seeded with sentinel internal
 * figures, then parses every artefact (every XML part of the xlsx, the PDF text) and asserts the
 * rows, prices, totals, unresolved lines, notes, formula-injection neutralisation, visibly
 * unpriced lines, and that no customer-facing file carries cost / floor / margin / justification /
 * internal notes. Also pins the one validity contract (Settings → Branding `validityDays`).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { D, money } from "@/lib/money";
import { buildCrossReferenceWorkbook, buildCrossReferenceRows, buildContractOfferWorkbook, buildContractOfferRows, validityLine } from "@/lib/excel/export";
import { buildOfferPdf, buildQuotePdf } from "@/lib/pdf";
import { buildQuote } from "@/lib/proposals/export";
import { toCsv, parseCsv } from "@/lib/sheets/csv";
import { setProposedPrice } from "@/lib/proposals/service";
import { submitForApproval } from "@/lib/approvals/service";
import { getBranding } from "@/lib/branding";
import { RUN, mkUser, mkProduct, mkAccount, mkRequest, mkProposal, mkPolicy, linesOf, cleanupRun, pdfText } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const COST = "12345.6789", FLOOR = "23456.7891", MARGIN = "0.987654", JUST = "JUSTIFICATION-SENTINEL-7Q", NOTE = "INTERNAL-NOTE-SENTINEL-7Q", RATIONALE = "RATIONALE-SENTINEL-7Q";
const SENTINELS = [COST, "12,345.68", "12345.68", FLOOR, "23,456.79", "23456.79", MARGIN, "98.8%", JUST, NOTE];

/** Every XML part of an xlsx (sheets, shared strings, hidden sheets, cached values) as one string, plus the workbook's sheet visibility. */
async function xlsxParts(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const parts: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) parts[name] = await zip.files[name].async("string");
  const all = Object.values(parts).join("\n");
  const hidden = (parts["xl/workbook.xml"] ?? "").match(/state="(hidden|veryHidden)"/g) ?? [];
  const hiddenCols = Object.entries(parts).filter(([n]) => n.startsWith("xl/worksheets/")).flatMap(([, x]) => x.match(/<col [^>]*hidden="1"/g) ?? []);
  const formulas = all.match(/<f>[^<]*<\/f>/g) ?? [];
  return { parts, all, hidden, hiddenCols, formulas };
}
async function sheetRows(buf: Buffer, name: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet(name)!;
  const rows: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: true }, (r) => rows.push((r.values as (string | number | null)[]).slice(1)));
  return rows;
}

describe("WS2 exports — CSV formula injection (pure)", () => {
  test("cells starting with =, +, -, @, tab or CR are neutralised; numbers and negative numbers stay numbers; quotes and newlines are escaped", () => {
    const csv = toCsv([["=1+1", "+cmd", "-cmd", "@SUM(A1)", "\tx", "\rx", "-5", "-5.25", 7, "a,b", 'say "hi"', "line\nbreak", null, undefined, "plain"]]);
    const row = parseCsv(csv)[0];
    expect(row).toEqual(["'=1+1", "'+cmd", "'-cmd", "'@SUM(A1)", "'\tx", "'\rx", "-5", "-5.25", "7", "a,b", 'say "hi"', "line\nbreak", "", "", "plain"]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"a,b"');
    expect(csv).toContain("=1+1"); // present, but as text
    expect(csv.split("\r\n")[0].startsWith("﻿'=1+1")).toBe(true);
  });
});

describe.skipIf(!hasDb)("WS2 exports — content", () => {
  let rep: Awaited<ReturnType<typeof mkUser>>, dir: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let pA: Awaited<ReturnType<typeof mkProduct>>, pB: Awaited<ReturnType<typeof mkProduct>>, pNoPrice: Awaited<ReturnType<typeof mkProduct>>;
  let request: Awaited<ReturnType<typeof mkRequest>>;
  let fx: Awaited<ReturnType<typeof mkProposal>>;
  const CODES = { a: `${RUN}X1`, injected: "=HYPERLINK(\"http://evil\")", noMatch: `${RUN}X3`, notFound: `${RUN}X4`, noPrice: `${RUN}X5` };

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rep", ["SALES_REP"]); dir = await mkUser("dir", ["PRICING_DIRECTOR"]);
    await mkPolicy();
    acct = await mkAccount({ name: "export acct" });
    pA = await mkProduct({ sku: "XA", listPrice: "100", cogs: "40", description: "Trocar A 12mm" });
    pB = await mkProduct({ sku: "XB", listPrice: "50.5", cogs: "20", description: "Trocar B 5mm" });
    pNoPrice = await mkProduct({ sku: "XN", listPrice: null, cogs: null, description: "Unpriced C" });
    // Cross-reference request with a rich candidate set (built directly: no matcher run).
    request = await mkRequest({ accountId: acct.id, lines: [
      { code: CODES.a, qty: 10, productId: pA.id, estCompetitorPrice: "120", customerNote: "Case of 6" },
      { code: CODES.injected, qty: 3, productId: pB.id, estCompetitorPrice: "-55" },
      { code: CODES.noMatch, qty: 7, productId: null },
      { code: CODES.notFound, qty: 2, productId: null },
      { code: CODES.noPrice, qty: 4, productId: pNoPrice.id },
    ] });
    const lines = await prisma.requestLine.findMany({ where: { requestId: request.id }, orderBy: { lineNo: "asc" }, include: { candidates: true } });
    await prisma.matchCandidate.update({ where: { id: lines[0].candidates[0].id }, data: { unitPrice: "90", extended: "900", priceSource: "LIST · catalog list price", rationale: RATIONALE, scoreCogs: 0.9, scoreMargin: 0.8, confidence: 0.91, matchType: "Exact Match" } });
    await prisma.matchCandidate.create({ data: { lineId: lines[0].id, ownProductId: pB.id, rank: 2, matchType: "Close Match", source: "attribute", score: 0.6, unitPrice: "45", rationale: "next best" } });
    await prisma.matchCandidate.update({ where: { id: lines[1].candidates[0].id }, data: { unitPrice: "45.5", priceSource: `LOCAL · ${RUN} deal (100–999)` } });
    const nm = await prisma.matchCandidate.create({ data: { lineId: lines[2].id, ownProductId: pB.id, rank: 1, matchType: "No Match", source: "attribute", score: 0.1, isSelected: true } });
    await prisma.requestLine.update({ where: { id: lines[2].id }, data: { selectedCandidateId: nm.id, matchStatus: "no-match" } });
    await prisma.requestLine.update({ where: { id: lines[3].id }, data: { resolutionStatus: "not-found", resolutionNote: "not in GUDID" } });
    // The unpriced candidate keeps unitPrice null.
    // Proposal with sentinel internal figures written directly onto the lines.
    fx = await mkProposal(dir.actor, { accountId: acct.id, lines: [{ code: CODES.a, qty: 10, productId: pA.id, customerNote: "Case of 6" }, { code: CODES.injected, qty: 3, productId: pB.id }, { code: CODES.noPrice, qty: 4, productId: pNoPrice.id }] });
    await setProposedPrice(dir.actor, fx.lines[0].id, D("95"));
    await setProposedPrice(dir.actor, fx.lines[1].id, D("45.5"));
    await setProposedPrice(dir.actor, fx.lines[2].id, D("7"));
    await prisma.proposalLine.update({ where: { id: fx.lines[2].id }, data: { included: false } }); // an excluded line
    expect((await submitForApproval(dir.actor, fx.proposal.id)).status).toBe("APPROVED");
    // Sentinel internal figures land after approval (a sentinel floor above the price would otherwise route the line).
    await prisma.proposalLine.update({ where: { id: fx.lines[0].id }, data: { cost: COST, floorPrice: FLOOR, marginPct: MARGIN, justification: JUST, notes: NOTE } });
    fx.lines = await linesOf(fx.proposal.id);
  });
  afterAll(async () => { await cleanupRun(); });

  test("cross-reference workbook (rep-facing): rows, SKUs, quantities, prices, totals, confidence, price source, unresolved sheet, cost/margin hidden on request", async () => {
    const { buffer, filename } = await buildCrossReferenceWorkbook(request.id);
    expect(filename).toMatch(/^Crosswalk_XrefReport_.*\.xlsx$/);
    const rows = await sheetRows(buffer, "Competitor Usage Xref");
    const header = rows[2];
    expect(header[0]).toBe("Competitor Name");
    expect(header[14]).toBe("Match Type");
    expect(header[15]).toBe("Confidence");
    expect(header[26]).toBe("Pricing Source");
    const a = rows.find((r) => r[1] === CODES.a)!;
    expect(a[3]).toBe(10);
    expect(a[4]).toBe(120); // est. competitor price
    expect(a[5]).toBe(1200); // competitor extended
    expect(a[6]).toBe(pA.sku);
    expect(a[11]).toBe("LIST PRICE");
    expect(a[12]).toBe(90);
    expect(a[13]).toBe(900);
    expect(a[14]).toBe("Exact Match");
    expect(a[15]).toBe(0.91);
    expect(a[17]).toBe(RATIONALE); // the rep's working file carries the rationale
    expect(a[18]).toBe(pB.sku); // next best 1
    expect(a[26]).toBe("LIST · catalog list price");
    const inj = rows.find((r) => r[1] === CODES.injected)!;
    expect(inj[11]).toBe(`${RUN} deal`); // "LOCAL · <name> (band)" → contract name
    expect(inj[12]).toBe(45.5);
    expect(inj[13]).toBe(136.5);
    const nm = rows.find((r) => r[1] === CODES.noMatch)!;
    expect(nm[6]).toBe(pB.sku); // a selected "No Match" candidate is shown as the closest SKU, flagged No Match (legacy BAT convention: "NO MATCH" only when nothing was selected)
    expect(nm[14]).toBe("No Match");
    const nf = rows.find((r) => r[1] === CODES.notFound)!;
    expect(nf[14]).toBe("Competitor Product Not Found");
    const np = rows.find((r) => r[1] === CODES.noPrice)!;
    expect(np[6]).toBe(pNoPrice.sku);
    expect(np[11]).toBe("No price on file");
    expect(np[12] ?? null).toBeNull(); // visibly unpriced, never 0
    expect(np[13] ?? null).toBeNull();
    const total = rows.find((r) => r[0] === "TOTAL")!;
    expect(total[3]).toBe(26);
    expect(total[5]).toBe(1200 - 165); // −55 × 3: the rep's negative estimate is carried as entered (the intake rejects it; direct data)
    expect(total[13]).toBe(900 + 136.5);
    const unresolved = await sheetRows(buffer, "Unresolved");
    expect(unresolved.map((r) => r[0])).toEqual(["Competitor Product", CODES.noMatch, CODES.notFound]);
    expect(unresolved[2][2]).toBe("Not found in GUDID");
    const cands = await sheetRows(buffer, "All Candidates");
    expect(cands.find((r) => r[0] === CODES.a && r[2] === 1)![10]).toBe(0.9); // COGS fit shown by default
    const hidden = await sheetRows((await buildCrossReferenceWorkbook(request.id, { cost: true, margin: true })).buffer, "All Candidates");
    expect(hidden.find((r) => r[0] === CODES.a && r[2] === 1)![10] ?? null).toBeNull();
    expect(hidden.find((r) => r[0] === CODES.a && r[2] === 1)![11] ?? null).toBeNull();
    const csv = await buildCrossReferenceRows(request.id);
    expect(csv.rows[0]).toEqual(header);
    expect(csv.rows.find((r) => r[1] === CODES.a)![12]).toBe(90);
    const text = toCsv(csv.rows);
    expect(parseCsv(text).find((r) => r[1].includes("HYPERLINK"))![1]).toBe(`'${CODES.injected}`); // neutralised in the CSV
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  test("contract offer (xlsx, csv, pdf): only matched priced lines, unmatched listed in the notes, no internal figures, validity from Settings → Branding", async () => {
    const branding = await getBranding();
    const { buffer } = await buildContractOfferWorkbook(request.id);
    const rows = await sheetRows(buffer, "Proposal");
    const header = rows[5];
    expect(header.slice(1)).toEqual(["Current Product", "Current Product Description", `${branding.legalName} Equivalent`, `${branding.legalName} Product Description`, "Annual Qty", "Unit Price", "Extended"]);
    const data = rows.filter((r) => [CODES.a, CODES.injected, CODES.noPrice].includes(r[1] as string));
    expect(data.map((r) => r[1])).toEqual([CODES.a, CODES.injected]); // the unpriced match is not printed blank: it is listed for follow-up (same predicate as the PDF)
    expect(data[0].slice(3)).toEqual([pA.sku, "Trocar A 12mm", 10, 90, 900]);
    expect(data[1].slice(5)).toEqual([3, 45.5, 136.5]);
    expect(rows.some((r) => r[1] === CODES.noMatch)).toBe(false);
    const total = rows.find((r) => r[6] === "Total")!;
    expect(total[7]).toBe(1036.5);
    const notes = rows.map((r) => String(r[1] ?? "")).join("\n");
    expect(notes).toMatch(new RegExp(`3 item\\(s\\) on your usage list were not included in this proposal \\(${CODES.noMatch}, ${CODES.notFound}, ${CODES.noPrice}\\)`));
    expect(String(rows[3][1])).toContain(validityLine(branding.validityDays));
    expect(String(rows[3][1])).not.toContain("Valid 90 days");
    const parts = await xlsxParts(buffer);
    const textOnly = parts.all.replace(/<[^>]+>/g, " ");
    for (const s of [...SENTINELS, RATIONALE, "COGS", "Margin", "Rationale", "next best"]) expect(textOnly, s).not.toContain(s);
    expect(parts.hidden).toEqual([]);
    expect(parts.hiddenCols).toEqual([]);
    expect(parts.formulas).toEqual([]);
    const csv = await buildContractOfferRows(request.id);
    expect(csv.rows[2][0]).toContain(validityLine(branding.validityDays));
    const text = toCsv(csv.rows);
    for (const s of [...SENTINELS, RATIONALE]) expect(text).not.toContain(s);
    expect(parseCsv(text).find((r) => r[0].includes("HYPERLINK"))![0]).toBe(`'${CODES.injected}`);
    const pdf = await buildOfferPdf(rep.actor, request.id);
    const ptext = pdfText(pdf.buffer);
    const norm = (v: string) => v.replace(/[\s-]+/g, "");
    expect(norm(ptext)).toContain(norm(pA.sku));
    expect(ptext).toContain("$900.00");
    expect(ptext).toContain("$136.50");
    expect(ptext).toContain("$1,036.50");
    expect(ptext).toContain("Valid through " + new Date(Date.now() + branding.validityDays * 86_400_000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
    expect(norm(ptext)).not.toContain(norm(pNoPrice.sku)); // an unpriced line is not printed on an offer
    expect(ptext).toMatch(new RegExp(`3 item\\(s\\) on your usage list were not included in this offer \\(${CODES.noMatch}, ${CODES.notFound}, ${CODES.noPrice}\\)`));
    for (const s of [...SENTINELS, RATIONALE]) expect(ptext).not.toContain(s);
    expect(await prisma.auditEvent.count({ where: { entityType: "Request", entityId: request.id, action: "EXPORTED" } })).toBe(1);
  });

  test("quote (xlsx, csv, pdf): approved lines only, customer notes printed, justification / internal notes / cost / floor / margin never, unpriced-excluded lines absent, injection neutralised", async () => {
    const branding = await getBranding();
    const x = await buildQuote(dir.actor, fx.proposal.id, "xlsx");
    const rows = await sheetRows(x.buffer, "Proposal");
    const data = rows.filter((r) => [CODES.a, CODES.injected].includes(r[0] as string));
    expect(data.length).toBe(2);
    expect(data[0].slice(2, 9)).toEqual([pA.sku, "Trocar A 12mm", "none", 10, 95, 950, "Case of 6"]);
    expect(data[1].slice(5, 9)).toEqual([3, 45.5, 136.5, ""]);
    expect(rows.some((r) => r[0] === CODES.noPrice)).toBe(false);
    expect(rows.find((r) => r[0] === "TOTAL")![7]).toBe(1086.5);
    expect(String(rows[1][0])).toContain(`valid through ${(await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } })).validThrough!.toISOString().slice(0, 10)}`);
    const parts = await xlsxParts(x.buffer);
    for (const s of SENTINELS) expect(parts.all, s).not.toContain(s);
    expect(parts.all.replace(/<[^>]+>/g, " ")).not.toMatch(/floor|margin|cost|justif/i); // text content only (XML has pageMargins)
    expect(parts.hidden).toEqual([]);
    expect(parts.hiddenCols).toEqual([]);
    expect(parts.formulas).toEqual([]);
    const c = await buildQuote(dir.actor, fx.proposal.id, "csv");
    const text = c.buffer.toString("utf8");
    for (const s of SENTINELS) expect(text).not.toContain(s);
    expect(parseCsv(text).find((r) => r[0].includes("HYPERLINK"))![0]).toBe(`'${CODES.injected}`);
    expect(parseCsv(text).find((r) => r[0] === "TOTAL")![7]).toBe("1086.5");
    const pdf = await buildQuotePdf(dir.actor, fx.proposal.id);
    const ptext = pdfText(pdf.buffer);
    for (const s of SENTINELS) expect(ptext).not.toContain(s);
    expect(ptext).not.toMatch(/floor|margin|cost|justif/i);
    expect(ptext).toContain("Case of 6");
    expect(ptext).toContain("$1,086.50");
    expect(ptext).toContain(branding.quoteTitle);
    expect(ptext).toContain("1 item(s) on the usage list are not included in this quotation");
    // A proposal created without explicit validDays takes the branding validity, not a second hard-coded default.
    const created = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } });
    const days = Math.round((created.validThrough!.getTime() - created.createdAt.getTime()) / 86_400_000);
    expect(days).toBe(branding.validityDays);
    expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: fx.proposal.id, action: "EXPORTED" } })).toBe(3);
  });

  test("a stored price of 0 on a candidate is shown as 0 (a price), a missing one as empty (no price); the quote refuses an unpriced included line", async () => {
    const lines = await prisma.requestLine.findMany({ where: { requestId: request.id }, orderBy: { lineNo: "asc" }, include: { candidates: true } });
    const np = lines[4].candidates[0];
    await prisma.matchCandidate.update({ where: { id: np.id }, data: { unitPrice: "0" } });
    try {
      const rows = await sheetRows((await buildCrossReferenceWorkbook(request.id)).buffer, "Competitor Usage Xref");
      expect(rows.find((r) => r[1] === CODES.noPrice)![12]).toBe(0);
    } finally { await prisma.matchCandidate.update({ where: { id: np.id }, data: { unitPrice: null } }); }
    // Quote: an included line without a price blocks the export (canFinalize) rather than printing 0.
    await prisma.proposalLine.update({ where: { id: fx.lines[2].id }, data: { included: true, proposedPrice: null } });
    try { await expect(buildQuote(dir.actor, fx.proposal.id, "csv")).rejects.toThrow(/1 included line\(s\) have no proposed price/); } finally { await prisma.proposalLine.update({ where: { id: fx.lines[2].id }, data: { included: false, proposedPrice: "7" } }); }
    expect(money((await linesOf(fx.proposal.id))[2].proposedPrice)!.toString()).toBe("7");
  });
});

/**
 * WS1 intake accounting (docs/BUILD_NOTES.md §9.1): every fixture asserts the exact-once identity
 * dataRows == lines + merged + skipped + ignored, plus the specific behaviour the fixture is about.
 * Pure — no database. XLSX fixtures are built in memory with ExcelJS.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseIntakeGrid, parseIntakeCsv, parseIntake, type IntakeResult } from "@/lib/excel/intake";
import { normalizeCfn, looksLikeCfn, isPlaceholderSku } from "@/lib/cfn";

type Cell = string | number | null;
const grid = (rows: Cell[][]) => parseIntakeGrid(rows, "Sheet", { kind: "csv", name: "t.csv" });
/** The identity every fixture must satisfy: rows with something in the code column are accounted for exactly once. */
function assertAccounted(r: IntakeResult) {
  const { dataRows, lines, merged, skipped, ignored } = r.accounting;
  expect(dataRows, `accounting ${JSON.stringify(r.accounting)}`).toBe(lines + merged + skipped + ignored);
  expect(lines).toBe(r.lines.length);
  expect(skipped).toBe(r.skipped.length);
  expect(ignored).toBe(r.ignored.length);
  expect(merged).toBe(r.duplicatesMerged);
  // and every line's source rows are distinct data rows
  const rows = r.lines.flatMap((l) => l.sourceRows);
  expect(new Set(rows).size).toBe(rows.length);
  expect(rows.length).toBe(lines + merged);
  return r;
}

describe("ws1 intake: invisible characters, dashes and quoting", () => {
  it("BOM / NBSP / zero-width characters around codes are stripped (CSV path)", () => {
    const r = assertAccounted(parseIntakeCsv("﻿Product Code,Qty\n B12LT​,3\n⁠ONB5STF﻿,2\n"));
    expect(r.lines.map((l) => [l.cfnNorm, l.quantity])).toEqual([["B12LT", 3], ["ONB5STF", 2]]);
    expect(r.detectedColumns).toMatchObject({ code: 1, qty: 2, headerRow: 1 });
  });
  it("typographic dashes are one code: hyphen, non-breaking hyphen, en dash, em dash, minus", () => {
    const r = assertAccounted(grid([["code", "qty"], ["B12-LT", 1], ["B12‑LT", 2], ["B12–LT", 3], ["B12—LT", 4], ["B12−LT", 5]]));
    expect(r.accounting).toEqual({ dataRows: 5, lines: 1, merged: 4, skipped: 0, ignored: 0 });
    expect(r.lines[0]).toMatchObject({ cfnNorm: "B12-LT", quantity: 15, sourceRows: [2, 3, 4, 5, 6] });
  });
  it("quoted commas and embedded newlines stay inside one cell", () => {
    const r = assertAccounted(parseIntakeCsv('Item,Description,Quantity\n"B12LT","Bladeless, 12 mm\nline two",5\n"ONB5STF","plain",1\n'));
    expect(r.lines[0]).toMatchObject({ cfnNorm: "B12LT", quantity: 5, description: "Bladeless, 12 mm\nline two" });
    expect(r.lines).toHaveLength(2);
  });
  it("blank cells: a blank quantity defaults to 1, a blank code row is not a data row", () => {
    const r = assertAccounted(grid([["code", "qty", "price"], ["B12LT", null, null], [null, 5, 1], ["", "", ""], ["ONB5STF", "", ""]]));
    expect(r.accounting).toEqual({ dataRows: 2, lines: 2, merged: 0, skipped: 0, ignored: 0 });
    expect(r.lines.map((l) => l.quantity)).toEqual([1, 1]);
  });
});

describe("ws1 intake: files and headers", () => {
  it("an empty CSV and a header-only CSV yield zero lines and a zero identity", () => {
    expect(assertAccounted(parseIntakeCsv("")).accounting).toEqual({ dataRows: 0, lines: 0, merged: 0, skipped: 0, ignored: 0 });
    expect(assertAccounted(parseIntakeCsv("Product Code,Qty\n")).accounting.dataRows).toBe(0);
  });
  it("a corrupt or empty .xlsx fails with a rep-readable message, not a zip-library error", async () => {
    await expect(parseIntake(Buffer.from("not an xlsx file at all"), "bad.xlsx")).rejects.toThrow(/bad\.xlsx is not a readable \.xlsx workbook/);
    await expect(parseIntake(Buffer.alloc(0), "empty.xlsx")).rejects.toThrow(/not a readable \.xlsx workbook/);
  });
  it("xlsx: the first sheet with data is used; formulas read their result; rich text and numeric cells are codes", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Empty");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["Product Code", "Qty"]); ws.addRow(["B12LT", 3]);
    ws.getCell("A3").value = "ONB5STF"; ws.getCell("B3").value = { formula: "B2*2", result: 6 } as never;
    ws.getCell("A4").value = { richText: [{ text: "NB" }, { text: "12STF" }] } as never; ws.getCell("B4").value = 1;
    ws.getCell("A5").value = 174006; ws.getCell("B5").value = 2;
    const r = assertAccounted(await parseIntake((await wb.xlsx.writeBuffer()) as ArrayBuffer, "t.xlsx"));
    expect(r.sheet).toBe("Data");
    expect(r.lines.map((l) => [l.cfnNorm, l.quantity])).toEqual([["B12LT", 3], ["ONB5STF", 6], ["NB12STF", 1], ["174006", 2]]);
  });
  it("header found in the first 10 non-empty rows, even past 10 physical rows of title and blank lines", () => {
    const r8 = assertAccounted(grid([["Customer report"], [], [], [], [], [], [], ["Item", "Units"], ["B12LT", 2]]));
    expect(r8.detectedColumns.headerRow).toBe(8);
    expect(r8.lines.map((l) => l.cfnNorm)).toEqual(["B12LT"]);
    const r11 = assertAccounted(grid([[], [], [], [], [], [], [], [], [], [], ["Item", "Units"], ["B12LT", 2]]));
    expect(r11.detectedColumns.headerRow).toBe(11);
    expect(r11.lines.map((l) => l.cfnNorm)).toEqual(["B12LT"]); // "ITEM" is never ingested as a code
  });
  it("no-header fallback: column 1 = code, column 2 = quantity; a title row or a header-looking row is not a product", () => {
    const r = assertAccounted(grid([["B12LT", 3], ["ONB5STF", "4"]]));
    expect(r.detectedColumns).toMatchObject({ code: 1, qty: 2, headerRow: null });
    expect(r.lines.map((l) => [l.cfnNorm, l.quantity])).toEqual([["B12LT", 3], ["ONB5STF", 4]]);
    const t = assertAccounted(grid([["Hospital list"], ["B12LT", 3]]));
    expect(t.lines.map((l) => l.cfnNorm)).toEqual(["B12LT"]);
    const repeated = assertAccounted(grid([["Product Code", "Qty"], ["B12LT", 1], ["Product Code", "Qty"], ["ONB5STF", 2]]));
    expect(repeated.ignored).toEqual([{ row: 3, reason: "column header, not a product", value: "Product Code" }]);
    expect(repeated.lines).toHaveLength(2);
  });
  it("duplicate headers: the first of each kind wins; a quantity header before the code header still works", () => {
    const r = assertAccounted(grid([["Code", "Code", "Qty", "Qty"], ["B12LT", "ZZZ", 3, 9]]));
    expect(r.detectedColumns).toMatchObject({ code: 1, qty: 3 });
    expect(r.lines[0]).toMatchObject({ cfnNorm: "B12LT", quantity: 3 });
    const q = assertAccounted(grid([["Qty", "Product Code"], [3, "B12LT"]]));
    expect(q.detectedColumns).toMatchObject({ code: 2, qty: 1 });
    expect(q.lines[0]).toMatchObject({ cfnNorm: "B12LT", quantity: 3 });
  });
  it("price and description headers: 'Est. Competitor Price', 'Cost', 'Product Name'", () => {
    const r = assertAccounted(grid([["Competitor Product", "Est. Competitor Price", "Annual Qty", "Competitor Product Description"], ["B12LT", "12.5", "3", "desc"]]));
    expect(r.detectedColumns).toMatchObject({ code: 1, price: 2, qty: 3, description: 4 });
    expect(r.lines[0]).toMatchObject({ estPrice: 12.5, quantity: 3, description: "desc" });
    expect(assertAccounted(grid([["Item", "Cost"], ["B12LT", "9"]])).lines[0].estPrice).toBe(9);
    expect(assertAccounted(grid([["SKU", "Product Name", "Units"], ["B12LT", "Bladeless", 2]])).detectedColumns.description).toBe(2);
  });
});

describe("ws1 intake: codes, placeholders, quantities, limits", () => {
  it("hyphenated short segments, compact forms and leading zeroes are codes", () => {
    const r = assertAccounted(grid([["code"], ["IN-12-4"], ["IN-15-4"], ["IN124"], ["0001234"], [1234], ["00012"], ["in 12 4"]]));
    expect(r.lines.map((l) => l.cfnNorm)).toEqual(["IN-12-4", "IN-15-4", "IN124", "0001234", "1234", "00012", "IN124"].filter((_, i) => i !== 6));
    // "in 12 4" collapses to IN124 and merges with the compact form
    expect(r.accounting).toEqual({ dataRows: 7, lines: 6, merged: 1, skipped: 0, ignored: 0 });
    for (const c of ["IN-12-4", "IN124", "0001234", "123", "A/B/C", "A_B1", "1234567"]) expect(looksLikeCfn(normalizeCfn(c)), c).toBe(true);
    for (const c of ["AB", "A1", "12", "A-B", "X", ""]) expect(looksLikeCfn(normalizeCfn(c)), c).toBe(false);
  });
  it("placeholders are skipped with a reason; summary rows are ignored; look-alike real codes survive", () => {
    const r = assertAccounted(grid([["code", "qty"], ["NO MATCH", 1], ["N/A", 1], ["NOMATCH", 1], ["TOTAL", 1], ["DISC", 1], ["TBD", 1], ["NO MATCH FOUND", 1], ["Grand Total", 1], ["Subtotal", 1], ["DISC123", 1], ["NA1", 1], ["TBD2", 1]]));
    expect(r.skipped.map((s) => s.value)).toEqual(["NO MATCH", "N/A", "NOMATCH", "DISC", "TBD", "NO MATCH FOUND"]);
    expect(r.skipped.every((s) => s.reason === "placeholder, not a catalog number")).toBe(true);
    expect(r.ignored.map((s) => s.value)).toEqual(["TOTAL", "Grand Total", "Subtotal"]);
    expect(r.lines.map((l) => l.cfnNorm)).toEqual(["DISC123", "NA1", "TBD2"]);
    for (const p of ["NO MATCH", "N/A", "NOMATCH", "TOTAL", "DISC", "TBD", "NO MATCH FOUND", "SEE NOTES", "NOT AVAILABLE", "NONE", "-", "--", "PENDING", ""]) expect(isPlaceholderSku(p), p).toBe(true);
    for (const c of ["DISC123", "NA1", "TBD2", "N/A-1", "ABC", "174006"]) expect(isPlaceholderSku(c), c).toBe(false);
  });
  it("characters no catalog number uses are named in the reason", () => {
    const r = assertAccounted(grid([["code"], ["AB12&CD"], ["AB12 (old)"]]));
    expect(r.skipped[0].reason).toMatch(/characters no catalog number uses \(&\)/);
    expect(r.skipped[1].reason).toMatch(/characters no catalog number uses \(\( \)\)/);
  });
  it("quantity: 0, negative, ±Infinity and > 10,000,000 are skipped with reasons; fractions, '1,200', '$5', '12 EA', '1e3' are read; blanks and words default to 1 (§9.1, pinned by test-adversarial)", () => {
    const r = assertAccounted(grid([["code", "qty"], ["SKU1", 0], ["SKU2", -1], ["SKU3", 1.5], ["SKU4", "NaN"], ["SKU5", "Infinity"], ["SKU6", 10_000_001], ["SKU7", 10_000_000], ["SKU8", "1,200"], ["SKU9", "abc"], ["SKU10", "1e3"], ["SKU11", " 7 "], ["SKU12", "$5"], ["SKU13", "12 EA"], ["SKU14", ""], ["SKU15", "-Infinity"], ["SKU16", Number.NaN]]));
    expect(r.accounting).toEqual({ dataRows: 16, lines: 11, merged: 0, skipped: 5, ignored: 0 });
    expect(Object.fromEntries(r.lines.map((l) => [l.cfnNorm, l.quantity]))).toEqual({ SKU3: 1.5, SKU4: 1, SKU7: 10_000_000, SKU8: 1200, SKU9: 1, SKU10: 1000, SKU11: 7, SKU12: 5, SKU13: 12, SKU14: 1, SKU16: 1 });
    expect(Object.fromEntries(r.skipped.map((s) => [s.value, s.reason]))).toEqual({
      SKU1: "quantity 0 is not a positive number", SKU2: "quantity -1 is not a positive number", SKU5: "quantity Infinity is not a positive number",
      SKU6: "quantity 10000001 is implausible for one line", SKU15: "quantity -Infinity is not a positive number",
    });
  });
  it("code length: 42 characters is the longest catalog number; 43 is skipped with the length reason", () => {
    const r = assertAccounted(grid([["code"], ["A".repeat(42)], ["A".repeat(43)], ["A".repeat(41) + "-"]]));
    expect(r.lines.map((l) => l.cfnNorm.length)).toEqual([42, 42]);
    expect(r.skipped).toEqual([{ row: 3, reason: "longer than any catalog number (more than 42 characters)", value: "A".repeat(43) }]);
  });
  it("duplicate merge sums quantities and keeps the first price and description; a later price fills a missing one", () => {
    const r = assertAccounted(grid([["code", "qty", "price", "desc"], ["B12LT", 2, null, null], ["b12 lt", 3, 10, "first"], ["B12-LT", 4, 20, "second"], ["B12LT", 5, 30, "third"]]));
    expect(r.accounting).toEqual({ dataRows: 4, lines: 2, merged: 2, skipped: 0, ignored: 0 });
    expect(r.lines[0]).toMatchObject({ rawCode: "B12LT", cfnNorm: "B12LT", quantity: 10, estPrice: 10, description: "first", sourceRows: [2, 3, 5] });
    expect(r.lines[1]).toMatchObject({ cfnNorm: "B12-LT", quantity: 4, estPrice: 20, description: "second" });
  });
  it("negative or absurd prices are dropped, not stored", () => {
    const r = assertAccounted(grid([["code", "qty", "price"], ["B12LT", 1, -5], ["B12LTX", 1, 1e10], ["ONB5STF", 1, "12.50"]]));
    expect(r.lines.map((l) => l.estPrice)).toEqual([null, null, 12.5]);
  });
  it("1 and 5,000 lines parse with the identity intact (the 5,000 limit is enforced by POST /api/requests)", () => {
    const one = assertAccounted(grid([["code", "qty"], ["B12LT", 1]]));
    expect(one.lines).toHaveLength(1);
    const big = assertAccounted(grid([["code", "qty"], ...Array.from({ length: 5001 }, (_, i) => [`SKU${i}`, 1] as Cell[])]));
    expect(big.accounting).toEqual({ dataRows: 5001, lines: 5001, merged: 0, skipped: 0, ignored: 0 });
  });
});

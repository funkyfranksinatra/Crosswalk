import ExcelJS from "exceljs";
import { parseIntakeGrid, parseIntakeCsv, parseIntake } from "@/lib/excel/intake";
import { normalizeCfn, looksLikeCfn, isPlaceholderSku } from "@/lib/cfn";
const show = (label: string, r: ReturnType<typeof parseIntakeGrid>) => {
  const ok = r.accounting.dataRows === r.accounting.lines + r.accounting.merged + r.accounting.skipped + r.accounting.ignored;
  console.log(`${ok ? "OK " : "BAD"} ${label}: acc=${JSON.stringify(r.accounting)} cols=${JSON.stringify(r.detectedColumns)} lines=${r.lines.map((l) => `${l.cfnNorm}x${l.quantity}@${l.estPrice}`).join(",")} skipped=${r.skipped.map((s) => `${s.value}:${s.reason}`).join("|")} ignored=${r.ignored.map((s) => s.value).join("|")}`);
};
const g = (rows: (string | number | null)[][]) => parseIntakeGrid(rows, "S", { kind: "csv", name: "t.csv" });
show("bom/nbsp/zw", parseIntakeCsv("﻿Product Code,Qty\n B12LT​,3\n⁠ONB5STF﻿,2\n"));
show("smart dashes", g([["code", "qty"], ["B12‑LT", 1], ["B12–LT", 2], ["B12—LT", 3], ["B12−LT", 4]]));
show("quoted commas/newlines", parseIntakeCsv('Item,Description,Quantity\n"B12LT","Bladeless, 12 mm\nline two",5\n'));
show("blank cells", g([["code", "qty", "price"], ["B12LT", null, null], [null, 5, 1], ["", "", ""], ["ONB5STF", "", ""]]));
show("empty file", parseIntakeCsv(""));
show("only header", parseIntakeCsv("Product Code,Qty\n"));
show("shifted header row 8", g([["Customer report"], [], [], [], [], [], [], ["Item", "Units"], ["B12LT", 2]]));
show("shifted header row 11 (beyond 10)", g([[], [], [], [], [], [], [], [], [], [], ["Item", "Units"], ["B12LT", 2]]));
show("no header fallback", g([["B12LT", 3], ["ONB5STF", "4"]]));
show("no header first row junk", g([["Hospital list"], ["B12LT", 3]]));
show("duplicate headers", g([["Code", "Code", "Qty", "Qty"], ["B12LT", "ZZZ", 3, 9]]));
show("formulas", g([["code", "qty"], ["B12LT", "=SUM(A1)"]]));
show("codes", g([["code"], ["IN-12-4"], ["IN-15-4"], ["IN124"], ["0001234"], [1234], ["00012"]]));
show("placeholders", g([["code", "qty"], ["NO MATCH", 1], ["N/A", 1], ["NOMATCH", 1], ["TOTAL", 1], ["DISC", 1], ["TBD", 1], ["NO MATCH FOUND", 1], ["Grand Total", 1], ["DISC123", 1], ["NA1", 1], ["TOTAL-1", 1]]));
show("qty edge", g([["code", "qty"], ["SKU1", 0], ["SKU2", -1], ["SKU3", 1.5], ["SKU4", "NaN"], ["SKU5", "Infinity"], ["SKU6", 10_000_001], ["SKU7", 10_000_000], ["SKU8", "1,200"], ["SKU9", "abc"], ["SKU10", "1e3"], ["SKU11", " 7 "], ["SKU12", "$5"], ["SKU13", "12 EA"], ["SKU14", ""], ["SKU15", "-Infinity"]]));
show("repeated header in data", g([["Product Code", "Qty"], ["B12LT", 1], ["Product Code", "Qty"], ["ONB5STF", 2]]));
show("code len 42/43", g([["code"], ["A".repeat(42)], ["A".repeat(43)], ["A".repeat(41) + "-"]]));
show("dup merge", g([["code", "qty", "price", "desc"], ["B12LT", 2, null, null], ["b12 lt", 3, 10, "first"], ["B12-LT", 4, 20, "second"]]));
show("negative price / huge price", g([["code", "qty", "price"], ["B12LT", 1, -5], ["B12LTX", 1, 1e10]]));
show("price header variants", g([["Competitor Product", "Est. Competitor Price", "Annual Qty", "Competitor Product Description"], ["B12LT", "12.5", "3", "desc"]]));
show("desc col detection", g([["SKU", "Product Name", "Units"], ["B12LT", "Bladeless", 2]]));
show("qty header before code header", g([["Qty", "Product Code"], [3, "B12LT"]]));
show("cost header", g([["Item", "Cost"], ["B12LT", "9"]]));
console.log("looksLikeCfn:", ["IN-12-4", "IN124", "AB", "A1", "12", "123", "A-B", "A/B/C", "A_B1", "X", "1234567", "a".repeat(42)].map((c) => `${c}=${looksLikeCfn(normalizeCfn(c))}`).join(" "));
console.log("placeholder:", ["NO MATCH", "N/A", "NOMATCH", "TOTAL", "DISC", "TBD", "NO MATCH FOUND", "DISC123", "SEE NOTES", "NOT AVAILABLE", "NONE", "-", "--", "0", "00", "ABC", "AB", "N/A-1", "TBD2", "PENDING"].map((c) => `${c}=${isPlaceholderSku(c)}`).join(" "));
(async () => {
  const wb = new ExcelJS.Workbook();
  const empty = wb.addWorksheet("Empty"); void empty;
  const ws = wb.addWorksheet("Data"); ws.addRow(["Product Code", "Qty"]); ws.addRow(["B12LT", 3]); ws.getCell("B3").value = { formula: "B2*2", result: 6 } as never; ws.getCell("A3").value = "ONB5STF";
  ws.getCell("A4").value = { richText: [{ text: "NB" }, { text: "12STF" }] } as never; ws.getCell("B4").value = 1;
  ws.getCell("A5").value = 174006; ws.getCell("B5").value = 2;
  const buf = await wb.xlsx.writeBuffer();
  show("xlsx: multi-sheet, formula, richtext, numeric", await parseIntake(buf as ArrayBuffer, "t.xlsx"));
  try { await parseIntake(Buffer.from("not an xlsx file at all"), "bad.xlsx"); console.log("corrupt: no throw?!"); } catch (e) { console.log("corrupt xlsx throws:", (e as Error).message.slice(0, 80)); }
  try { const r = await parseIntake(Buffer.alloc(0), "empty.xlsx"); console.log("empty xlsx:", r.accounting); } catch (e) { console.log("empty xlsx throws:", (e as Error).message.slice(0, 80)); }
  const wb2 = new ExcelJS.Workbook(); wb2.addWorksheet("Only"); const b2 = await wb2.xlsx.writeBuffer(); show("xlsx: one empty sheet", await parseIntake(b2 as ArrayBuffer));
  const big = [["code", "qty"], ...Array.from({ length: 5001 }, (_, i) => [`SKU${i}`, 1])]; const r = g(big as never); console.log("5001 lines:", r.accounting);
})();

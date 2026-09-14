/**
 * Deterministic checks that need no database, model, or network.
 * Run: npx tsx scripts/check.ts   (CI runs this on every push)
 *
 * Each case pins a behaviour that a real run once got wrong, so a regression
 * shows up here before it shows up in a customer bid. Add a case whenever a
 * compare-and-debug pass fixes something deterministic.
 */
import assert from "node:assert/strict";
import { heuristicBin, binSimilarity, sizeFromSku, extractDimensions, normaliseDimensions, constructionSignature, matchTypeFromScore, type Dimension } from "../src/lib/match/bin";
import { siblingKey, groupSiblings } from "../src/lib/match/grading";
import { normalizeCfn, compactCfn } from "../src/lib/cfn";
import { variantsFor } from "../src/lib/pipeline/resolve";
import { toCsv, parseCsv } from "../src/lib/sheets/csv";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}\n    ${e instanceof Error ? e.message : String(e)}`); }
}

// ---- CFN handling -----------------------------------------------------------
test("normalizeCfn uppercases, trims and keeps punctuation; compactCfn strips it", () => {
  assert.equal(normalizeCfn(" sig45-amt "), "SIG45-AMT");
  assert.equal(compactCfn("SIG45-AMT"), "SIG45AMT");
  assert.equal(normalizeCfn(1190500), "1190500");
});
test("resolver variants zero-pad Excel-stripped Bard codes and strip list-wide prefixes", () => {
  const v = variantsFor("112660", undefined, true).map((x) => x.value);
  assert.ok(v.includes("0112660"), `expected 0112660 in ${v.join(",")}`);
  const w = variantsFor("3583174006", { manufacturers: new Map(), families: new Map(), commonPrefixes: ["3583"], ourName: "Medtronic", preferCompanies: [] }).map((x) => x.value);
  assert.ok(w.includes("174006"), `expected 174006 in ${w.join(",")}`);
});

// ---- Heuristic binner --------------------------------------------------------
test("'Soft Tissue Patch' is not tagged macroporous; 'Soft Mesh' is", () => {
  const gore = heuristicBin({ brand: "GORE-TEX Soft Tissue Patch", description: "GORE-TEX SOFT TISSUE PATCH 10.0cmX15.0cmX1.0mm" });
  assert.ok(!gore.features.includes("macroporous"), gore.features.join(","));
  assert.ok(gore.materials.includes("eptfe"));
  const prolene = heuristicBin({ brand: "PROLENE", description: "Soft Polypropylene Mesh, Nonabsorbable Synthetic Surgical Mesh" });
  assert.ok(prolene.features.includes("macroporous"));
  assert.ok(!prolene.features.includes("absorbable"), "nonabsorbable must not read as absorbable");
});
test("dual-unit labels collapse to one metric width/length", () => {
  const b = heuristicBin({ brand: "BARD", description: 'Bard Mesh, 10" x 14" (26 cm x 36 cm)' });
  const sizes = b.dimensions.filter((d) => ["width", "length"].includes(d.name));
  assert.deepEqual(sizes.map((d) => `${d.name} ${d.value} ${d.unit}`), ["width 26 cm", "length 36 cm"]);
});
test("'20 x 15 cm x 1' — trailing bare integer is a pack count, not a thickness", () => {
  const dims = extractDimensions("Mesh Parietene DS 20 x 15 cm x 1");
  assert.ok(dims.some((d) => d.name === "count" && d.value === 1));
  assert.ok(!dims.some((d) => d.name === "thickness"));
});
test("height 1 mm dedupes into thickness; plug height stays height", () => {
  const sheet: Dimension[] = [{ name: "height", value: 1, unit: "mm" }, { name: "thickness", value: 1, unit: "mm" }];
  assert.deepEqual(normaliseDimensions(sheet).map((d) => d.name), ["thickness"]);
  const plug: Dimension[] = [{ name: "height", value: 3.3, unit: "cm" }, { name: "diameter", value: 3.9, unit: "cm" }];
  assert.deepEqual(normaliseDimensions(plug).map((d) => d.name).sort(), ["diameter", "height"]);
});
test("own SKU convention fills mesh sizes", () => {
  assert.deepEqual(sizeFromSku("PCO2015X").map((d) => `${d.name} ${d.value}`), ["width 15", "length 20"]);
  assert.deepEqual(sizeFromSku("PPDS12").map((d) => `${d.name} ${d.value}`), ["diameter 12"]);
  assert.deepEqual(sizeFromSku("SIG60AMT"), []);
});
test("imported competitor sizes override GUDID/regex sizes", () => {
  const b = heuristicBin({ brand: "PROLENE", description: "Soft Polypropylene Mesh", importedSizes: [{ name: "width", value: 10, unit: "cm" }, { name: "length", value: 15, unit: "cm" }] });
  assert.deepEqual(b.dimensions.filter((d) => d.name !== "count").map((d) => `${d.name} ${d.value}`), ["width 10", "length 15"]);
  assert.match(b.summary, /competitor sizes import/);
});
test("ProTack lands in Fixation even though its GMDN term mentions mesh", () => {
  const b = heuristicBin({ brand: "ProTack", description: "ProTack — Fixation Device", gmdnName: "Surgical mesh fixation device" });
  assert.equal(b.family, "Fixation");
});

// ---- Similarity / caps -------------------------------------------------------
const phasix = heuristicBin({ brand: "Phasix", description: 'Phasix Mesh, 3" x 8" (8 cm x 20 cm), Rectangle' });
const ppm1510 = heuristicBin({ sku: "PPM1510X3", brand: "Parietene", description: "Parietene Macroporous Mesh 15 X 10 cm" });
test("fully-resorbable vs permanent caps at Alternative", () => {
  assert.equal(binSimilarity(phasix, ppm1510).cap, "Alternative Match");
});
test("barrier mismatch caps at Close; same construction stays Exact-capable", () => {
  const dual = heuristicBin({ brand: "GORE DUALMESH Biomaterial", description: "GORE DUALMESH BIOMATERIAL 10.0cmX15.0cmX1.0mm" });
  assert.equal(binSimilarity(dual, ppm1510).cap, "Close Match"); // barrier + material
  assert.equal(binSimilarity(ppm1510, ppm1510).cap, "Exact Match");
});
test("never Exact when the competitor size is unknown", () => {
  assert.equal(matchTypeFromScore(0.95, null), "Close Match");
  assert.equal(matchTypeFromScore(0.95, 1), "Exact Match");
});
test("round vs rectangular compares extents instead of giving up", () => {
  const round = heuristicBin({ sku: "PPDS12", brand: "Parietene", description: "Mesh Parietene DS Round 12 cm x 1" });
  const small = heuristicBin({ brand: "Phasix", description: "Phasix ST Mesh, 7 cm x 10 cm (3\" x 4\"), Rectangle" });
  const s = binSimilarity(small, round);
  assert.ok(s.dimensions !== null && s.dimensions > 0.3, `dims score ${s.dimensions}`);
  assert.ok(s.notes.some((n) => /extents/.test(n)));
});

// ---- Sibling grouping --------------------------------------------------------
test("construction signature separates Phasix from Phasix ST and DUALMESH from Soft Tissue Patch", () => {
  const st = heuristicBin({ brand: "Phasix", description: "Phasix ST Mesh, 15 cm x 20 cm, Rectangle" });
  assert.notEqual(constructionSignature(phasix), constructionSignature(st));
  const lines = [
    { manufacturer: "BD - Bard", brand: "Phasix", bin: phasix },
    { manufacturer: "BD - Bard", brand: "Phasix", bin: st },
    { manufacturer: "W.L. Gore", brand: "GORE DUALMESH Biomaterial", bin: heuristicBin({ brand: "GORE DUALMESH Biomaterial", description: "GORE DUALMESH BIOMATERIAL 7.5cmX10.0cmX1.0mm" }) },
    { manufacturer: "W.L. Gore", brand: "GORE-TEX Soft Tissue Patch", bin: heuristicBin({ brand: "GORE-TEX Soft Tissue Patch", description: "GORE-TEX SOFT TISSUE PATCH 5.0cmX10.0cmX1.0mm" }) },
  ];
  assert.equal(groupSiblings(lines).length, 4);
  assert.equal(new Set(lines.map(siblingKey)).size, 4);
});
test("same brand + construction + family groups together", () => {
  const a = { manufacturer: "BD - Bard", brand: "BARD", bin: heuristicBin({ brand: "BARD", description: "Bard Mesh, 2\" x 4\" (5 cm x 10 cm)" }) };
  const b = { manufacturer: "BD - Bard", brand: "BARD", bin: heuristicBin({ brand: "BARD", description: "Bard Mesh, 3\" x 6\" (7.6 cm x 15 cm)" }) };
  assert.equal(siblingKey(a), siblingKey(b));
});

// ---- CSV ---------------------------------------------------------------------
test("CSV round-trips quotes and commas", () => {
  const rows = [["a", 'he said "hi", ok', 1.5], ["b", null, 2]];
  const back = parseCsv(toCsv(rows).replace(/^﻿/, ""));
  assert.equal(back[0][1], 'he said "hi", ok');
  assert.equal(back[1][2], "2");
});

// ---- Report ------------------------------------------------------------------
console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
if (failures.length) process.exit(1);

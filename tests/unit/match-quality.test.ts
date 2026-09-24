/**
 * Match quality model (docs/MATCH_QUALITY_MODEL.md): size parsing, brand registry, component
 * classification, hard/soft constraints, score/confidence/classification separation, curated
 * evidence handling, SELF_MATCH, intake accounting. All pure — no database.
 */
import { describe, it, expect } from "vitest";
import { parseAccessSizes, buildAccessProfile, mergeProfiles, componentFromGmdn } from "@/lib/match/access";
import { brandAssertions, skuAssertion } from "@/lib/match/brands";
import { componentOf, componentsCompatible } from "@/lib/match/component";
import { compareAccess } from "@/lib/match/constraints";
import { heuristicBin, binSimilarity, matchTypeFromScore, withAccessProfile } from "@/lib/match/bin";
import { scoreCandidates, type CandidateInput } from "@/lib/match/score";
import { parseIntakeGrid } from "@/lib/excel/intake";
import { normalizeCfn, looksLikeCfn } from "@/lib/cfn";

// ---------------------------------------------------------------------------------------------
describe("access size parser (matrix)", () => {
  const cases: [string, { d?: number[]; r?: [number, number] | null; l?: number | null; lc?: string | null; fromRange?: boolean }][] = [
    ["5 mm", { d: [5] }], ["5mm", { d: [5] }], ["5 MM", { d: [5] }],
    ["5/10 mm", { d: [5, 10] }], ["2 mm/3 mm", { d: [2, 3] }], ["2mm/3mm", { d: [2, 3] }], ["2/3 mm", { d: [2, 3] }],
    ["5–12 mm", { d: [12], r: [5, 12], fromRange: true }], ["5-12mm", { d: [12], r: [5, 12], fromRange: true }], ["5 mm to 12 mm", { d: [12], r: [5, 12], fromRange: true }],
    ["12 × 100 mm", { d: [12], l: 100 }], ["12mm x 100mm", { d: [12], l: 100 }], ["12 mm diameter, 100 mm length", { d: [12], l: 100 }],
    ["100 mm x 11 mm", { d: [11], l: 100 }], ["5x95 Threaded Cannula", { d: [5], l: 95 }],
    ["Size: 12 mm; Length 110 mm; 5 mm - 11 mm instruments", { d: [12], r: [5, 11], l: 110 }],
    ["Versaport Plus RPF 5-10mm Trocar with 100mm Radiolucent Sleeve", { d: [10], r: [5, 10], l: 100, fromRange: true }],
    ["Mini Step Short 5 mm Cannula and Dilator with Radially Expandable Sleeve and 5 - 2/3 mm Reducer", { d: [5], r: null, lc: "short" }],
    ["Thoracoport 10.5 mm for instrument up to 11 mm", { d: [10.5], r: [1, 11] }],
    ["TROCAR BLADELESS 5/8MM X 100 MM DISPOSABLE 6 EA/BX", { d: [5, 8], l: 100 }],
    ["Versaport V2 RT 11 mm Obturator with 5 mm-11 mm VersaSeal Plus", { d: [11], r: [5, 11] }],
    ["Bladeless 12 mm Long length with fixation cannula", { d: [12], l: null, lc: "long" }],
    ["Extra long 5 mm trocar", { d: [5], lc: "long" }],
    ["Round 12 cm x 1", { d: [] }], ["Reload 60 mm 3.5 mm staples", { l: 60 }],
    ["B12‑LT bladeless trocars 12 mm, 100 mm length", { d: [12], l: 100 }],
  ];
  for (const [text, want] of cases) {
    it(text, () => {
      const r = parseAccessSizes(text);
      if (want.d) expect(r.diameters.sort()).toEqual([...want.d].sort());
      if (want.r !== undefined) expect(r.range ? [r.range.min, r.range.max] : null).toEqual(want.r);
      if (want.l !== undefined) expect(r.lengthMm).toBe(want.l);
      if (want.lc !== undefined) expect(r.lengthClass).toBe(want.lc);
      if (want.fromRange !== undefined) expect(r.diameterFromRange).toBe(want.fromRange);
    });
  }
  it("does not read every number as a diameter", () => {
    expect(parseAccessSizes("Endo Retract 10 mm Single Use Instrument; 31 cm Length").lengthMm).toBeNull(); // cm is not read as an access length
    expect(parseAccessSizes("Reload 60 mm 3.5 mm staples").diameters).toEqual([3.5]); // a staple height is ≤ 20 mm: the family gate (Trocar Products) keeps this parser away from staplers
    expect(parseAccessSizes("6 EA/BX").diameters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("brand → feature registry", () => {
  const has = (text: string, key: string) => brandAssertions(text).some((a) => a.key === key);
  it("OPTIVIEW, Kii Fios, Visiport and Optical Separator are optical", () => {
    for (const t of ["ENDOPATH XCEL with OPTIVIEW Technology Bladeless Trocars", "Kii Fios First Entry", "Visiport Plus RPF", "Optical Separator System", "Kii Optical Access System"]) {
      expect(brandAssertions(t).some((a) => a.assert.visualization === "optical"), t).toBe(true);
    }
  });
  it("carries provenance and a note", () => {
    const a = brandAssertions("ENDOPATH XCEL OPTIVIEW").find((x) => x.key === "ethicon.optiview")!;
    expect(a.provenance).toBe("manufacturer description");
    expect(a.note).toMatch(/optical/i);
  });
  it("a plain Xcel / BASX / bladed / dilating trocar is non-optical; OPTIVIEW wins when present", () => {
    expect(buildAccessProfile([{ text: "ENDOPATH XCEL Bladeless Trocars", source: "gudid:description" }]).visualization).toBe("non-optical");
    expect(buildAccessProfile([{ text: "ENDOPATH XCEL OPTIVIEW Bladeless Trocars", source: "gudid:description" }]).visualization).toBe("optical");
    expect(buildAccessProfile([{ text: "Kii Shielded Bladed Access System", source: "gudid:description" }]).visualization).toBe("non-optical");
  });
  it("sleeve rules do not fire on 'trocar with stability sleeve'", () => {
    expect(has("Bladeless Trocars with Stability Sleeves", "ethicon.sleeve")).toBe(false);
    expect(has("ENDOPATH XCEL Universal Sleeves 12 mm", "ethicon.sleeve")).toBe(true);
  });
  it("'non-threaded' is smooth, not fixation", () => {
    const p = buildAccessProfile([{ text: "12 mm x 100 mm Non-Threaded Optical Separator System", source: "gudid:description" }]);
    expect(p.fixation).toBe("smooth");
  });
  it("SKU conventions apply only to their manufacturer", () => {
    expect(skuAssertion("B12LT", "Ethicon")?.assert).toMatchObject({ diameterMm: [12], lengthMm: 100, tip: "bladeless" });
    expect(skuAssertion("B12LT", "Applied Medical")).toBeNull();
    expect(skuAssertion("2B5XT", "Ethicon - SterilMed")?.assert).toMatchObject({ visualization: "optical", lengthMm: 150 });
    expect(skuAssertion("UNVCA12STF", "Covidien LP")?.assert).toMatchObject({ component: "cannula", diameterMm: [12], lengthMm: 100, fixation: "fixation" });
    expect(skuAssertion("ONB12STFCS", "Medtronic")?.assert.extras).toEqual(["fascial closure system"]);
    expect(skuAssertion("B12LTH", "Ethicon")?.assert.extras).toEqual(["handle"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("component classification", () => {
  const cases: [string, string][] = [
    ["VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm", "trocar"],
    ["Endopath Xcel Bladeless Trocars with Stability Sleeves", "trocar"],
    ["ENDOPATH XCEL Universal Trocar Stablility Sleeves", "cannula"],
    ["VersaOne Universal Fixation Cannula; Size: 12 mm", "cannula"],
    ["Versaport Plus 5 mm - 12 mm Sleeve", "cannula"],
    ["11mm standard cannula only", "cannula"],
    ["Versaport V2 RT 5 mm Obturator with 5 mm Seal", "obturator"],
    ["VersaSeal Plus — Cannula Seal", "accessory"],
    ["5mm Single Use Duckbill Valve", "accessory"],
    ["10mm Hasson Adaptor Seals 5pk", "accessory"],
    ["Surgineedle 120 mm Veress needle", "insufflation-needle"],
    ["Mini Step 2/3 mm cannula and dilator with radially expandable sleeve", "dilating-system"],
    ["12 mm Blunt Tip Trocar with universal seal", "trocar"],
  ];
  for (const [t, want] of cases) it(`${t} → ${want}`, () => expect(componentOf(t)).toBe(want));
  it("compatibility: cannula ≠ trocar; dilating system ≈ trocar; unknown is not a mismatch", () => {
    expect(componentsCompatible("cannula", "trocar")).toBe(false);
    expect(componentsCompatible("dilating-system", "trocar")).toBe(true);
    expect(componentsCompatible("unknown", "cannula")).toBe(true);
    expect(componentsCompatible("accessory", "trocar")).toBe(false);
  });
  it("GMDN terms only name specific components", () => {
    expect(componentFromGmdn("Laparoscopic access cannula, single-use")).toBe("unknown");
    expect(componentFromGmdn("Laparoscopic access cannula seal reducer, single-use")).toBe("accessory");
  });
});

// ---------------------------------------------------------------------------------------------
describe("profile: provenance order and conflicts", () => {
  it("structured GUDID size > SKU convention > description text > intake text", () => {
    const p = buildAccessProfile([
      { text: null, source: "gudid:size", sizes: [{ type: "Lumen/Inner Diameter", value: "12", unit: "Millimeter" }, { type: "Length", value: "100", unit: "Millimeter" }] },
      { text: "B12XT", source: "sku", manufacturer: "Ethicon" },
      { text: "ENDOPATH XCEL Bladeless Trocars 12 mm, 150 mm length", source: "gudid:description" },
    ]);
    expect(p.diameters).toEqual([12]);
    expect(p.lengthMm).toBe(100);
    expect(p.evidence.find((e) => e.field === "length")?.source).toBe("gudid:size");
    expect(p.conflicts.some((c) => /length/.test(c))).toBe(true);
  });
  it("the SKU convention outranks a mis-typed description (B5XT is the 150 mm Xcel)", () => {
    const p = buildAccessProfile([{ text: "B5XT", source: "sku", manufacturer: "Ethicon" }, { text: "ENDOPATH XCEL Bladeless Trocars, 5 mm, 100 mm length", source: "intake:description" }]);
    expect(p.lengthMm).toBe(150);
    expect(p.conflicts.length).toBe(1);
  });
  it("the intake description fills gaps in a GUDID-only bin without overriding it", () => {
    const base = buildAccessProfile([{ text: "ENDOPATH XCEL OPTIVIEW Bladeless Trocars with Stability Sleeves", source: "gudid:description" }]);
    expect(base.diameters).toEqual([]);
    const merged = mergeProfiles(base, buildAccessProfile([{ text: "Bladeless Trocars with OPTIVIEW 12 mm, 100 mm length", source: "intake:description" }]));
    expect(merged.diameters).toEqual([12]);
    expect(merged.lengthMm).toBe(100);
    expect(merged.visualization).toBe("optical");
    expect(merged.evidence.find((e) => e.field === "diameters")?.source).toBe("intake:description");
  });
});

// ---------------------------------------------------------------------------------------------
const prof = (text: string, sku?: string) => buildAccessProfile([{ text: sku ?? null, source: "sku", manufacturer: "Medtronic" }, { text, source: "gudid:description" }]);
describe("hard constraints vs soft signals", () => {
  it("12 mm cannula-only is No Match for a 12 mm complete trocar (hard)", () => {
    const r = compareAccess(prof("ENDOPATH XCEL Bladeless Trocars 12 mm, 100 mm length"), prof("VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm", "UNVCA12STF"));
    expect(r.cap).toBe("No Match");
    expect(r.hard).toBe(1);
    expect(r.findings[0].text).toMatch(/cannula only/);
  });
  it("diameter sets that do not overlap cap at Alternative (hard)", () => {
    const r = compareAccess(prof("Kii Fios 12 x 100 mm optical access system"), prof("VersaOne Optical Trocar with Fixation Cannula; 5 mm x 100 mm", "ONB5STF"));
    expect(r.cap).toBe("Alternative Match");
    expect(r.findings.find((f) => f.field === "diameter")?.text).toBe("12 mm vs 5 mm");
  });
  it("2/3 mm accepts a 3 mm line; 5 mm does not", () => {
    const own = prof("Mini Step 2/3 mm cannula and dilator with radially expandable sleeve");
    expect(compareAccess(prof("3 mm mini trocar"), own).diameterConfirmed).toBe(true);
    expect(compareAccess(prof("5 mm trocar"), own).cap).toBe("Alternative Match");
  });
  it("optical vs non-optical, bladed vs bladeless, length class and fixation style cap at Close (soft)", () => {
    const opt = compareAccess(prof("ENDOPATH XCEL OPTIVIEW Bladeless Trocars 12 mm, 100 mm length"), prof("Versaport Plus Bladeless 12 mm Standard length with fixation cannula", "NB12STF"));
    expect(opt.cap).toBe("Close Match");
    expect(opt.findings.some((f) => f.field === "visualization" && f.kind === "soft")).toBe(true);
    const tip = compareAccess(prof("ENDOPATH XCEL Dilating Tip Trocars 11 mm, 100 mm length"), prof("VersaOne Bladed Trocar with Fixation Cannula; 11 mm x 100 mm", "B11STF"));
    expect(tip.cap).toBe("Close Match");
    expect(tip.findings.find((f) => f.field === "tip")?.text).toBe("dilating vs bladed");
    const len = compareAccess(prof("Kii Fios 12 x 100 mm optical"), prof("VersaOne Optical Trocar with Fixation Cannula; 12 mm x 150 mm", "ONB12LGF"));
    expect(len.cap).toBe("Close Match");
    const fix = compareAccess(prof("12 mm x 100 mm Non-Threaded Optical Separator System"), prof("VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm", "ONB12STF"));
    expect(fix.cap).toBe("Close Match");
  });
  it("dilating tip is a bladeless subtype", () => {
    const r = compareAccess(prof("ENDOPATH XCEL Dilating Tip Trocars 11 mm, 100 mm length"), prof("VersaOne Bladeless Trocar with Fixation Cannula; Size: 11 mm; Length: 100 mm", "NONB11STF"));
    expect(r.cap).toBe("Exact Match");
    expect(r.soft).toBe(0);
  });
  it("our variant add-on (fascial closure, low profile) is at most Close; a radially expanding system is Exact only on a curated cross", () => {
    const cs = compareAccess(prof("Kii Fios 12 x 100 mm optical access system Z-Threaded"), prof("VersaOne Fascial Closure System Optical Trocar 12 mm x 100 mm", "ONB12STFCS"));
    expect(cs.cap).toBe("Close Match");
    const lp = compareAccess(prof("ENDOPATH XCEL Bladeless Trocars 5 mm, 100 mm length"), prof("Versaport Bladeless 5 mm 100 mm Low Profile Trocar with Fixation Cannula", "NB5STFLP"));
    expect(lp.cap).toBe("Close Match");
    const step = compareAccess(prof("ENDOPATH XCEL Bladeless Trocars 11 mm, 100 mm length"), prof("VersaStep Plus 11 mm radially expandable sleeve 100 mm"));
    expect(step.cap).toBe("Exact Match");
    expect(step.attributeCap).toBe("Close Match");
  });
  it("Exact on attributes needs 4 of 5 decisive fields known", () => {
    const r = compareAccess(prof("12 mm trocar"), prof("Versaport Plus V2 5 - 12 mm Trocar"));
    expect(r.cap).toBe("Exact Match");
    expect(r.attributeCap).toBe("Close Match");
    expect(r.coverage).toBeLessThan(0.8);
  });
});

// ---------------------------------------------------------------------------------------------
const own = (sku: string, description: string, extra: Partial<CandidateInput> = {}): CandidateInput => ({ ownProductId: sku, sku, description, bin: heuristicBin({ sku, manufacturer: "Medtronic", description, category: "Trocar Products" }), unitPrice: null, cogs: null, provenance: "seed", ...extra });
const comp = (code: string, manufacturer: string, description: string, intake?: string) => {
  let bin = heuristicBin({ code, manufacturer, description, intakeDescription: intake ?? null });
  if (intake) bin = withAccessProfile(bin, mergeProfiles(bin.access!, buildAccessProfile([{ text: intake, source: "intake:description" }])));
  return { bin, description, estPrice: null };
};

describe("scoring: score / confidence / classification", () => {
  it("attribute Exact: all decisive fields agree; confidence below the curated level; explanation lists the evidence", () => {
    const [top] = scoreCandidates(comp("CFF01", "Applied Medical", "Kii Fios First Entry — Trocar", "5 mm x 150 mm Kii Fios First Entry (Advanced Fixation)"), [own("ONB5LGF", "VersaOne Optical Trocar with Fixation Cannula; 5 mm x 150 mm"), own("ONB5STF", "VersaOne Optical Trocar with Fixation Cannula; 5 mm x 100 mm")]);
    expect(top.sku).toBe("ONB5LGF");
    expect(top.matchType).toBe("Exact Match");
    expect(top.source).toBe("attribute");
    expect(top.confidence).toBeGreaterThanOrEqual(0.75);
    expect(top.confidence).toBeLessThan(0.9);
    expect(top.rationale).toMatch(/5 mm = 5 mm/);
    expect(top.rationale).toMatch(/optical/);
  });
  it("a curated Exact contradicted by a hard constraint is No Match, with the sheet named", () => {
    const res = scoreCandidates(comp("2B5XT", "Ethicon", "ENDOPATH XCEL OPTIVIEW Bladeless Trocars with Stability Sleeves"), [own("UNVCA5SHF", "VersaOne Universal Fixation Cannula; Size: 5 mm; Length: 70 mm", { knownCross: { matchType: "Exact Match", source: "Sheet1", approvalStatus: "APPROVED" } }), own("ONB5LGF", "VersaOne Optical Trocar with Fixation Cannula; 5 mm x 150 mm", { knownCross: { matchType: "Close Match", source: "Sheet1", approvalStatus: "APPROVED", preferred: true } })]);
    const sleeve = res.find((r) => r.sku === "UNVCA5SHF")!;
    expect(sleeve.matchType).toBe("No Match");
    expect(sleeve.rationale).toMatch(/curated cross \(Sheet1, Exact Match\) — contradicted/);
    expect(sleeve.factors.curated?.contradicted).toBe(true);
    expect(res[0].sku).toBe("ONB5LGF");
  });
  it("a curated Exact contradicted by a soft signal ranks as Close with lower confidence", () => {
    const [c] = scoreCandidates(comp("D11LT", "Ethicon", "ENDOPATH XCEL Dilating Tip Trocars with Stability Sleeves", "ENDOPATH XCEL Dilating Tip; 100 mm x 11 mm"), [own("B11STF", "VersaOne Bladed Trocar with Fixation Cannula; 11 mm x 100 mm", { knownCross: { matchType: "Exact Match", source: "Sheet1", approvalStatus: "APPROVED" } })]);
    expect(c.matchType).toBe("Close Match");
    expect(c.confidence).toBeLessThan(0.75);
  });
  it("the reviewer's preferred cross outranks other curated rows of the same grade; a curated grade is never raised by attributes", () => {
    const res = scoreCandidates(comp("CTF73", "Applied Medical", "Kii Fios First Entry — Trocar", "12 x 100 mm Kii Fios first entry access system Z-Threaded"), [
      own("NB12STF", "Versaport Plus Bladeless 12 mm Standard length with fixation cannula", { knownCross: { matchType: "Close Match", source: "Sheet1", approvalStatus: "APPROVED" } }),
      own("ONB12STF", "VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm", { knownCross: { matchType: "Close Match", source: "Access-Nikki-Mike", approvalStatus: "APPROVED", preferred: true } }),
      own("ONB12STFCS", "VersaOne Fascial Closure System Optical Trocar 12 mm x 100 mm"),
    ]);
    expect(res[0].sku).toBe("ONB12STF");
    expect(res[0].matchType).toBe("Close Match");
    expect(res.find((r) => r.sku === "ONB12STFCS")?.matchType).toBe("Close Match");
  });
  it("SELF_MATCH: identity is Exact with confidence 1; a successor carries the note", () => {
    const [s] = scoreCandidates(comp("NB12STF", "Medtronic", "Versaport Plus Bladeless 12 mm"), [own("NB12STF", "Versaport Plus Bladeless 12 mm Standard length with fixation cannula", { identity: true })]);
    expect(s).toMatchObject({ matchType: "Exact Match", source: "identity", confidence: 1 });
    const [succ] = scoreCandidates(comp("OLD12", "Medtronic", "Versaport Plus Bladeless 12 mm"), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { identity: true, successorOf: "OLD12" })]);
    expect(succ.rationale).toMatch(/successor to our discontinued SKU OLD12/);
  });
  it("unknown competitor size is never Exact and lowers confidence", () => {
    const [c] = scoreCandidates(comp("X1", "Ethicon", "ENDOPATH XCEL Bladeless Trocars"), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    expect(c.matchType).not.toBe("Exact Match");
    expect(c.confidence).toBeLessThan(0.75);
  });
  it("a near tie inside the top grade names the runner-up; the priced SKU wins an exact tie", () => {
    const res = scoreCandidates(comp("D11LT", "Ethicon", "ENDOPATH XCEL Dilating Tip Trocars with Stability Sleeves", "ENDOPATH XCEL Dilating Tip; 100 mm x 11 mm"), [own("NB11STF", "Versaport Plus Bladeless 11 mm 100 mm Trocar with Fixation Cannula"), own("NONB11STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 11 mm; Length: 100 mm", { unitPrice: 25 })]);
    expect(res[0].sku).toBe("NONB11STF");
    expect(res[0].rationale).toMatch(/NB11STF is an equivalent exact match/);
  });
  it("the constraint cap is recorded for the model grader", () => {
    const [c] = scoreCandidates(comp("CB12LT", "Ethicon", "ENDOPATH XCEL Universal Sleeves 12 mm, 100 mm length"), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    expect(c.factors.cap).toBe("No Match");
    expect(c.matchType).toBe("No Match");
  });
});

describe("binner / similarity integration", () => {
  it("a Trocar bin carries the profile and profile-derived dimensions (range is not two diameters)", () => {
    const b = heuristicBin({ sku: "179076P", manufacturer: "Medtronic", description: "Versaport Plus RPF 5-10mm Trocar with 100mm Radiolucent Sleeve", category: "Trocar Products" });
    expect(b.access?.diameters).toEqual([10]);
    expect(b.dimensions.filter((d) => d.name === "diameter").map((d) => d.value)).toEqual([10]);
    expect(b.dimensions.some((d) => d.name === "max instrument" && d.value === 10)).toBe(true);
    expect(b.productType).toBe("trocar");
  });
  it("matchTypeFromScore honours a No Match cap", () => {
    expect(matchTypeFromScore(0.95, 1, "No Match")).toBe("No Match");
    expect(matchTypeFromScore(0.95, 1, "Close Match")).toBe("Close Match");
    expect(matchTypeFromScore(0.5, 1, "Exact Match")).toBe("Alternative Match");
  });
  it("similarity notes lead with contradictions", () => {
    const a = heuristicBin({ code: "CB12LT", manufacturer: "Ethicon", description: "ENDOPATH XCEL Universal Sleeves 12 mm, 100 mm length" });
    const b = heuristicBin({ sku: "NONB12STF", manufacturer: "Medtronic", description: "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm" });
    const s = binSimilarity(a, b);
    expect(s.cap).toBe("No Match");
    expect(s.notes[0]).toMatch(/^✗ /);
  });
});

// ---------------------------------------------------------------------------------------------
describe("intake reliability", () => {
  const grid = (rows: (string | number | null)[][]) => parseIntakeGrid(rows, "Sheet", { kind: "csv", name: "t.csv" });
  it("every row is accounted for: lines + merged + skipped + ignored = data rows, with reasons", () => {
    const r = grid([["Competitor Product", "Competitor Product Description", "Quantity"], ["B12LT", "Bladeless 12 mm", 4], ["b12lt", "dup", 2], ["TOTAL", "", ""], ["N/A", "", 1], ["", "", 3], ["!!!", "", 1], ["IN-12-4", "Genicon", 1]]);
    expect(r.accounting).toEqual({ dataRows: 6, lines: 2, merged: 1, skipped: 2, ignored: 1 });
    expect(r.ignored[0]).toMatchObject({ row: 4, reason: "summary row, not a product" });
    expect(r.skipped.map((s) => s.reason)).toEqual(["placeholder, not a catalog number", "placeholder, not a catalog number"]);
    expect(grid([["code"], ["AB12&CD"]]).skipped[0].reason).toMatch(/characters no catalog number uses \(&\)/);
    expect(r.lines[0]).toMatchObject({ cfnNorm: "B12LT", quantity: 6, description: "Bladeless 12 mm" });
    expect(r.detectedColumns.description).toBe(2);
  });
  it("code families survive normalisation", () => {
    const codes = ["IN-12-4", "2CB12LT", "52203-10/11", "0001234", "179096PF", "C0R47", "900-844", "MS10-0703", "B12‑LT", "b12 lt", "SIG45-AMT"];
    for (const c of codes) expect(looksLikeCfn(normalizeCfn(c)), c).toBe(true);
    expect(normalizeCfn("B12‑LT")).toBe("B12-LT"); // non-breaking hyphen
    expect(normalizeCfn("﻿ 0001234 ")).toBe("0001234"); // BOM and leading zeros kept
    expect(normalizeCfn("b12 lt")).toBe("B12LT");
    expect(normalizeCfn("B12–LT")).toBe("B12-LT"); // en dash
  });
  it("numeric cells keep their digits; placeholders are rejected not silently dropped", () => {
    const r = grid([["code", "qty"], [174006, 2], ["NO MATCH", 1], ["TBD", 1], ["Subtotal", ""]]);
    expect(r.lines[0].cfnNorm).toBe("174006");
    expect(r.skipped.length).toBe(2);
    expect(r.ignored.length).toBe(1);
    expect(r.accounting.dataRows).toBe(4);
  });
});

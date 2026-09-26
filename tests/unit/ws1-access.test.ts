/**
 * WS1 access-profile matrix (docs/BUILD_NOTES.md §10.1–10.3, docs/MATCH_QUALITY_MODEL.md §2–4). Extends
 * tests/unit/match-quality.test.ts with the boundary and negation cases it does not cover: pack counts and
 * reducers as non-sizes, length-class boundaries, cm → mm, brand-rule negations, and the exact constraint
 * boundaries (± 0.5 mm, coverage 0.8, component cap, dilating-system Exact bar). Pure — no database.
 */
import { describe, it, expect } from "vitest";
import { parseAccessSizes, buildAccessProfile, lengthClassOf, toMm, emptyProfile, type AccessProfile } from "@/lib/match/access";
import { brandAssertions, skuAssertion } from "@/lib/match/brands";
import { componentOf } from "@/lib/match/component";
import { compareAccess } from "@/lib/match/constraints";
import { heuristicBin } from "@/lib/match/bin";

const sizes = (t: string) => { const r = parseAccessSizes(t); return { d: [...r.diameters].sort((a, b) => a - b), r: r.range ? [r.range.min, r.range.max] : null, l: r.lengthMm, lc: r.lengthClass, fr: r.diameterFromRange }; };

describe("ws1 access: size parser matrix", () => {
  it.each([
    ["12 × 100 mm", { d: [12], l: 100, lc: "standard" }],
    ["12mm x 100mm", { d: [12], l: 100 }],
    ["100 mm x 11 mm", { d: [11], l: 100 }],
    ["5x95 trocar", { d: [5], l: 95, lc: "standard" }],
    ["5x95", { d: [], l: null }], // no unit and no component word: too ambiguous to read
    ["5–12 mm", { d: [12], r: [5, 12], fr: true }],
    ["5-12mm", { d: [12], r: [5, 12], fr: true }],
    ["5 mm to 12 mm", { d: [12], r: [5, 12], fr: true }],
    ["instruments up to 11 mm", { d: [11], r: [1, 11], fr: true }],
    ["2/3 mm", { d: [2, 3], r: null }],
    ["2 mm/3 mm", { d: [2, 3] }],
    ["5/10 mm", { d: [5, 10] }],
  ] as [string, Partial<ReturnType<typeof sizes>>][])("%s", (text, want) => {
    expect(sizes(text)).toMatchObject(want);
  });
  it("pack counts are never port sizes: 'Box of 6', '6/bx', '6 EA/BX', 'x 1'", () => {
    for (const t of ["12 mm trocar, Box of 6", "12 mm trocar 6/bx", "6/bx 12 mm trocar", "Box of 6 12 mm trocars", "TROCAR 12 MM X 100 MM 6 EA/BX"]) expect(sizes(t).d, t).toEqual([12]);
    expect(sizes("Round 12 cm x 1").d).toEqual([]);
    expect(sizes("6 EA/BX").d).toEqual([]);
  });
  it("reducer / converter / cap dimensions are not port sizes", () => {
    expect(sizes("5 mm trocar with 5 - 2/3 mm reducer")).toMatchObject({ d: [5], r: null });
    expect(sizes("10 mm trocar and 5 - 10 mm reducer")).toMatchObject({ d: [10], r: null });
    expect(sizes("12 mm trocar; 5 mm reducer cap")).toMatchObject({ d: [12] });
    expect(sizes("Step 12 mm cannula and dilator with radially expandable sleeve and 12 - 15 mm reducer")).toMatchObject({ d: [12], r: null });
  });
  it("length classes change at exactly 80 and 120 mm", () => {
    expect([80, 80.5, 81, 120, 120.5, 121].map(lengthClassOf)).toEqual(["short", "standard", "standard", "standard", "long", "long"]);
    expect(sizes("trocar 80 mm").lc).toBe("short");
    expect(sizes("trocar 81 mm").lc).toBe("standard");
    expect(sizes("trocar 120 mm").lc).toBe("standard");
    expect(sizes("trocar 121 mm").lc).toBe("long");
    expect(lengthClassOf(null)).toBeNull();
    expect(lengthClassOf(Number.NaN)).toBeNull();
  });
  it("cm → mm: text lengths and structured sizes in cm / inches are read in mm; other units are not lengths", () => {
    expect(sizes("10 cm length trocar 12 mm")).toMatchObject({ d: [12], l: 100, lc: "standard" });
    expect(sizes("12 mm x 10 cm")).toMatchObject({ d: [12], l: 100 });
    expect(sizes("Endo Retract 10 mm Single Use Instrument; 31 cm Length").l).toBeNull(); // 31 cm is an instrument, not an access length
    expect(toMm(10, "cm")).toBe(100); expect(toMm(4, "in")).toBe(101.6); expect(toMm(100, "Millimeter")).toBe(100); expect(toMm(10, "Centimeter")).toBe(100);
    expect(toMm(100, "French")).toBeNull(); expect(toMm(Number.NaN, "mm")).toBeNull();
    const gudid = buildAccessProfile([{ text: null, source: "gudid:size", sizes: [{ type: "Length", value: "10", unit: "Centimeter" }, { type: "Outer Diameter", value: "1.2", unit: "Centimeter" }] }]);
    expect(gudid).toMatchObject({ diameters: [12], lengthMm: 100, lengthClass: "standard" });
    expect(gudid.evidence.map((e) => `${e.field}=${e.value}@${e.source}`)).toEqual(["diameters=12 mm@gudid:size", "length=100 mm@gudid:size"]);
    const curated = buildAccessProfile([{ text: null, source: "curated-spec", dims: [{ name: "diameter", value: 1.2, unit: "cm" }, { name: "length", value: 10, unit: "cm" }] }]);
    expect(curated).toMatchObject({ diameters: [12], lengthMm: 100 });
    expect(buildAccessProfile([{ text: null, source: "gudid:size", sizes: [{ type: "Length", value: "100", unit: "French" }] }]).lengthMm).toBeNull();
  });
});

describe("ws1 access: brand rules — negations and confusing substrings", () => {
  const vis = (t: string) => buildAccessProfile([{ text: t, source: "gudid:description" }]).visualization;
  const fix = (t: string) => buildAccessProfile([{ text: t, source: "gudid:description" }]).fixation;
  const tip = (t: string) => buildAccessProfile([{ text: t, source: "gudid:description" }]).tip;
  it("'non-optical' is non-optical; 'optical' is optical", () => {
    expect(vis("non-optical trocar 12 mm")).toBe("non-optical");
    expect(vis("Non Optical Bladeless Trocar")).toBe("non-optical");
    expect(vis("optical trocar 12 mm")).toBe("optical");
    expect(brandAssertions("non-optical trocar").some((a) => a.key === "generic.optical")).toBe(false);
  });
  it("'without fixation' / unthreaded is smooth; 'Non-Threaded' is smooth; 'threaded' is fixation", () => {
    expect(fix("12 mm trocar without fixation")).toBe("smooth");
    expect(fix("12 mm trocar without fixation cannula")).toBe("smooth");
    expect(fix("unthreaded 12 mm cannula")).toBe("smooth");
    expect(fix("12 mm x 100 mm Non-Threaded Optical Separator System")).toBe("smooth");
    expect(fix("Z-Threaded 12 mm cannula")).toBe("fixation");
    expect(fix("Threaded Cannula 12 mm")).toBe("fixation");
  });
  it("'non-bladed' is bladeless, never bladed", () => {
    expect(tip("non-bladed trocar 12 mm")).toBe("bladeless");
    expect(brandAssertions("non-bladed trocar").some((a) => a.key === "generic.bladed" || a.key === "generic.bladed-nonoptical")).toBe(false);
    expect(heuristicBin({ description: "non-bladed non-optical trocar 12 mm", category: "Trocar Products" }).features).not.toContain("bladed");
    expect(heuristicBin({ description: "non-bladed non-optical trocar 12 mm", category: "Trocar Products" }).features).not.toContain("optical");
  });
  it("OPTIVIEW is optical wherever the word appears; the '2' SKU prefix is optical only under Ethicon", () => {
    expect(vis("ENDOPATH XCEL with OPTIVIEW Technology Bladeless Trocars")).toBe("optical");
    expect(skuAssertion("2B12LT", "Ethicon Endo-Surgery")?.assert.visualization).toBe("optical");
    expect(skuAssertion("2B12LT", "Applied Medical")).toBeNull();
    expect(skuAssertion("2B12LT", null)).toBeNull();
    expect(skuAssertion("B12LT", "Ethicon")?.assert.visualization).toBe("non-optical");
  });
  it("VersaStep: a dilating system, unless the text is the needle; Step insufflation needle is a needle", () => {
    expect(buildAccessProfile([{ text: "VersaStep Plus 12 mm", source: "gudid:description" }]).component).toBe("dilating-system");
    expect(brandAssertions("VersaStep needle")).toEqual([]);
    expect(componentOf("Step Insufflation/Access Needle; 14-Gauge; Compatible with Step and VersaStep Plus Access Systems")).toBe("insufflation-needle");
    expect(buildAccessProfile([{ text: "VersaStep Short Insufflation/Access Needle; 14-Gauge", source: "gudid:description" }]).component).toBe("insufflation-needle");
  });
  it("Kii variants: Fios = optical bladeless trocar; Shielded Bladed = bladed non-optical; Balloon Blunt Tip = blunt balloon; Sleeve / Advanced Fixation Cannula = cannula", () => {
    const p = (t: string) => buildAccessProfile([{ text: t, source: "gudid:description" }]);
    expect(p("Kii Fios First Entry 12 x 100 mm")).toMatchObject({ visualization: "optical", tip: "bladeless", component: "trocar" });
    expect(p("Kii Shielded Bladed Access System 12 x 100 mm")).toMatchObject({ tip: "bladed", visualization: "non-optical", component: "trocar" });
    expect(p("Kii Balloon Blunt Tip 12 mm")).toMatchObject({ tip: "blunt", fixation: "balloon", component: "trocar" });
    expect(p("Kii Sleeve 12 x 100 mm")).toMatchObject({ component: "cannula", fixation: "fixation" });
    expect(p("Kii Advanced Fixation Cannula 12 x 100 mm")).toMatchObject({ component: "cannula", fixation: "fixation" });
    expect(p("Kii Access System 5 x 100 mm")).toMatchObject({ component: "trocar" });
  });
  it("Versaport: 'Bladeless … with fixation cannula' is a complete trocar; 'Fixation Cannula' / 'Sleeve' SKUs are cannulas; 'for use with … trocar' is a cannula", () => {
    const comp = (t: string) => buildAccessProfile([{ text: t, source: "gudid:description" }]).component;
    expect(comp("Versaport Plus Bladeless 12 mm Standard length with fixation cannula")).toBe("trocar");
    expect(comp("Versaport Plus Bladeless 12 mm Standard length with smooth cannula")).toBe("trocar");
    expect(comp("Versaport Plus 12 mm Fixation Cannula")).toBe("cannula");
    expect(comp("Versaport Plus 5 mm - 11 mm Sleeve")).toBe("cannula");
    expect(comp("11mm ST Fixation Sleeve Assembly for Versaport Bladeless")).toBe("cannula");
    expect(comp("Single use fixation cannula with 5 mm - 12 mm Versaseal Plus seal for use with Versaport Plus Bladeless trocar")).toBe("cannula");
    // the SKU convention agrees, and applies only to Medtronic / Covidien codes
    expect(skuAssertion("NB12STF", "Covidien LP")?.assert.component).toBe("trocar");
    expect(skuAssertion("NB12STF", "Ethicon")).toBeNull();
    expect(skuAssertion("NBFCA12ST", "Medtronic")).toBeNull();
  });
});

describe("ws1 access: constraint boundaries", () => {
  const mk = (o: Partial<AccessProfile>): AccessProfile => ({ ...emptyProfile(), ...o });
  const full = (o: Partial<AccessProfile>) => mk({ component: "trocar", diameters: [12], lengthMm: 100, lengthClass: "standard", visualization: "non-optical", tip: "bladeless", ...o });
  it("diameter overlap is ± 0.5 mm exactly: 12 vs 12.5 confirms, 12 vs 12.51 is a hard mismatch (Alternative cap, × 0.55)", () => {
    expect(compareAccess(full({}), full({ diameters: [12.5] }))).toMatchObject({ diameterConfirmed: true, hard: 0, cap: "Exact Match" });
    expect(compareAccess(full({}), full({ diameters: [11.5] })).diameterConfirmed).toBe(true);
    const r = compareAccess(full({}), full({ diameters: [12.51] }));
    expect(r).toMatchObject({ diameterConfirmed: false, hard: 1, cap: "Alternative Match", multiplier: 0.55, agreement: 0 });
    expect(r.findings.find((f) => f.field === "diameter")).toEqual({ kind: "hard", field: "diameter", text: "12 mm vs 12.51 mm" });
  });
  it("a set covering the line (2/3 mm for 3 mm) confirms but is not identical (× 0.97)", () => {
    const r = compareAccess(full({ diameters: [3] }), full({ diameters: [2, 3] }));
    expect(r).toMatchObject({ diameterConfirmed: true, hard: 0 });
    expect(r.multiplier).toBeCloseTo(0.97, 5);
  });
  it("component: cannula ↔ trocar caps at No Match (× 0.3) either way; unknown on one side is never a mismatch", () => {
    expect(compareAccess(full({ component: "cannula" }), full({}))).toMatchObject({ cap: "No Match", multiplier: 0.3, hard: 1 });
    expect(compareAccess(full({}), full({ component: "cannula" }))).toMatchObject({ cap: "No Match", hard: 1 });
    expect(compareAccess(full({ component: "unknown" }), full({})).hard).toBe(0);
    expect(compareAccess(full({ component: "obturator" }), full({}))).toMatchObject({ cap: "No Match" });
    expect(compareAccess(full({ component: "insufflation-needle" }), full({ component: "dilating-system" }))).toMatchObject({ cap: "No Match" });
  });
  it("a dilating system for a trocar can be curated Exact (cap) but never attribute-only Exact (attributeCap Close)", () => {
    const r = compareAccess(full({}), full({ component: "dilating-system" }));
    expect(r).toMatchObject({ cap: "Exact Match", attributeCap: "Close Match", techniqueDiffers: true, hard: 0, soft: 0 });
    expect(r.multiplier).toBeCloseTo(0.95, 5);
    expect(r.findings.some((f) => f.field === "coverage" && /different access technique/.test(f.text))).toBe(true);
  });
  it("coverage: Exact on attributes needs ≥ 0.8 (4 of 5 decisive fields on both sides); 3 of 5 caps at Close; nothing known is Close", () => {
    const three = compareAccess(mk({ component: "trocar", diameters: [12], lengthClass: "standard" }), mk({ component: "trocar", diameters: [12], lengthClass: "standard" }));
    expect(three).toMatchObject({ coverage: 0.6, cap: "Exact Match", attributeCap: "Close Match" });
    const four = compareAccess(mk({ component: "trocar", diameters: [12], lengthClass: "standard", tip: "bladeless" }), mk({ component: "trocar", diameters: [12], lengthClass: "standard", tip: "bladeless" }));
    expect(four).toMatchObject({ coverage: 0.8, attributeCap: "Exact Match" });
    expect(compareAccess(mk({}), mk({}))).toMatchObject({ coverage: 0, attributeCap: "Close Match", diameterConfirmed: false, hard: 0, soft: 0 });
    // an optical competitor against a silent SKU counts as half known: 4.5 / 5
    expect(compareAccess(full({ visualization: "optical" }), full({ visualization: null })).coverage).toBeCloseTo(0.9, 5);
  });
  it("unknown ≠ agreement: an unknown field neither agrees nor contradicts, and does not raise the agreement score", () => {
    const known = compareAccess(full({}), full({}));
    const unknown = compareAccess(full({ tip: null }), full({ tip: null }));
    expect(known.agreements).toBe(5);
    expect(unknown.agreements).toBe(4);
    expect(unknown.findings.find((f) => f.field === "tip")?.kind).toBe("unknown");
    expect(unknown.agreement).toBeLessThan(known.agreement);
    expect(unknown.coverage).toBe(0.8);
  });
  it("soft signals cap at Close with their multipliers and stack; a cap only ever lowers", () => {
    const opt = compareAccess(full({}), full({ visualization: "optical" }));
    expect(opt).toMatchObject({ cap: "Close Match", soft: 1 }); expect(opt.multiplier).toBeCloseTo(0.85, 5);
    const both = compareAccess(full({}), full({ visualization: "optical", lengthMm: 150, lengthClass: "long" }));
    expect(both).toMatchObject({ cap: "Close Match", soft: 2 }); expect(both.multiplier).toBeCloseTo(0.85 * 0.85, 5);
    const hardAndSoft = compareAccess(full({}), full({ visualization: "optical", diameters: [5] }));
    expect(hardAndSoft.cap).toBe("Alternative Match"); // the hard cap wins over the soft one
    const worst = compareAccess(full({ component: "cannula" }), full({ visualization: "optical", diameters: [5] }));
    expect(worst.cap).toBe("No Match");
  });
});

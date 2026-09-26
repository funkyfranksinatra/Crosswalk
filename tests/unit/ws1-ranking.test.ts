/**
 * WS1 ranking / classification / confidence separation (docs/MATCH_QUALITY_MODEL.md §1, §4–6;
 * BUILD_NOTES §10.4, §12.2). Pure — no database, no model: the grader is exercised through
 * applyGroupGrades with a fake verdict.
 */
import { describe, it, expect } from "vitest";
import { heuristicBin, matchTypeFromScore, binSimilarity } from "@/lib/match/bin";
import { scoreCandidates, DEFAULT_WEIGHTS, MATCH_ORDER, gradeRank, REP_PRIOR_BOOST, KNOWN_CROSS_FLOOR, type CandidateInput, type ScoredCandidate } from "@/lib/match/score";
import { curatedCandidates, betterCross, attributeShortlist, resolveSelfMatch, type SelfRow } from "@/lib/match/line";
import { applyGroupGrades, type GradeLineInput, type GroupGrade } from "@/lib/match/grading";

const own = (sku: string, description: string, extra: Partial<CandidateInput> = {}): CandidateInput => ({ ownProductId: sku, sku, description, bin: heuristicBin({ sku, manufacturer: "Medtronic", description, category: "Trocar Products" }), unitPrice: null, cogs: null, provenance: "seed", ...extra });
const comp = (code: string, manufacturer: string, description: string) => ({ bin: heuristicBin({ code, manufacturer, description }), description, estPrice: null as number | null });
const B12 = () => comp("B12LT", "Ethicon", "ENDOPATH XCEL Bladeless Trocars 12 mm, 100 mm length");

describe("ws1 ranking: thresholds and caps", () => {
  it("Exact ≥ 0.82 with dimension score ≥ 0.9; Close ≥ 0.6; Alternative ≥ 0.38; else No Match", () => {
    expect(matchTypeFromScore(0.82, 0.9)).toBe("Exact Match");
    expect(matchTypeFromScore(0.8199, 0.9)).toBe("Close Match");
    expect(matchTypeFromScore(0.82, 0.8999)).toBe("Close Match");
    expect(matchTypeFromScore(0.99, null)).toBe("Close Match"); // size unknown is never Exact
    expect(matchTypeFromScore(0.6, 1)).toBe("Close Match");
    expect(matchTypeFromScore(0.5999, 1)).toBe("Alternative Match");
    expect(matchTypeFromScore(0.38, 1)).toBe("Alternative Match");
    expect(matchTypeFromScore(0.3799, 1)).toBe("No Match");
  });
  it("a cap only ever lowers: it never raises a grade the score does not support", () => {
    expect(matchTypeFromScore(0.95, 1, "Close Match")).toBe("Close Match");
    expect(matchTypeFromScore(0.95, 1, "Alternative Match")).toBe("Alternative Match");
    expect(matchTypeFromScore(0.95, 1, "No Match")).toBe("No Match");
    expect(matchTypeFromScore(0.5, 1, "Exact Match")).toBe("Alternative Match");
    expect(matchTypeFromScore(0.2, 1, "Exact Match")).toBe("No Match");
    expect(matchTypeFromScore(0.65, 1, "Alternative Match")).toBe("Alternative Match");
  });
  it("one grade ordering everywhere: Exact > Close > Alternative > US Downsell > No Match", () => {
    expect(MATCH_ORDER).toEqual({ "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "US Downsell Match": 3, "No Match": 4 });
    expect(gradeRank("Alternative Match")).toBeLessThan(gradeRank("US Downsell Match"));
    expect(gradeRank("US Downsell Match")).toBeLessThan(gradeRank("No Match"));
    expect(gradeRank("garbage")).toBeGreaterThan(gradeRank("No Match"));
    expect(betterCross("Alternative Match", "US Downsell Match")).toBe(true);
    expect(betterCross("US Downsell Match", "Alternative Match")).toBe(false);
    expect(betterCross("US Downsell Match", "No Match")).toBe(true);
    expect(KNOWN_CROSS_FLOOR["US Downsell Match"]).toBeLessThan(KNOWN_CROSS_FLOOR["Alternative Match"]);
    // per SKU, a curated Alternative row beats a Downsell row of the same status
    const ids = new Map([["NB12STF", "id1"]]);
    const { crossById } = curatedCandidates([{ ownSku: "NB12STF", preferredOwnSku: null, matchType: "US Downsell Match", source: "S1", approvalStatus: "APPROVED" }, { ownSku: "NB12STF", preferredOwnSku: null, matchType: "Alternative Match", source: "S2", approvalStatus: "APPROVED" }], ids);
    expect(crossById.get("id1")?.matchType).toBe("Alternative Match");
    // and a curated Downsell is classified Alternative (four-value enum) with the lower floor
    const [c] = scoreCandidates(B12(), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { knownCross: { matchType: "US Downsell Match", source: "S1", approvalStatus: "APPROVED" } })]);
    expect(c.matchType).toBe("Alternative Match");
    expect(c.factors.curated?.grade).toBe("Alternative Match");
  });
});

describe("ws1 ranking: curated evidence handling", () => {
  it("a curated row contradicted by hard evidence is labelled, demoted to No Match and still present — never deleted", () => {
    const res = scoreCandidates(B12(), [
      own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm", { knownCross: { matchType: "Exact Match", source: "Sheet1", approvalStatus: "APPROVED" } }),
      own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm"),
    ]);
    expect(res.map((r) => r.sku)).toEqual(["NONB12STF", "UNVCA12STF"]);
    const sleeve = res[1];
    expect(sleeve).toMatchObject({ matchType: "No Match", source: "known-cross" });
    expect(sleeve.factors.curated).toMatchObject({ source: "Sheet1", grade: "Exact Match", effective: "No Match", contradicted: true, preferred: false, findings: ["cannula only — the competitor line is a trocar"] });
    expect(sleeve.rationale).toMatch(/curated cross \(Sheet1, Exact Match\) — contradicted by the product attributes; ranked as No Match/);
    expect(sleeve.confidence).toBeLessThanOrEqual(0.5);
    expect(sleeve.factors.cap).toBe("No Match");
  });
  it("a curated row contradicted by a soft signal keeps its row, ranks as Close with low confidence, below an attribute Exact", () => {
    const res = scoreCandidates(B12(), [
      own("ONB12STF", "VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm", { knownCross: { matchType: "Exact Match", source: "Access-PACR", approvalStatus: "APPROVED" } }),
      own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm"),
    ]);
    expect(res[0]).toMatchObject({ sku: "NONB12STF", matchType: "Exact Match", source: "attribute" });
    expect(res[1]).toMatchObject({ sku: "ONB12STF", matchType: "Close Match", source: "known-cross" });
    expect(res[1].factors.curated?.contradicted).toBe(true);
    expect(res[1].confidence).toBeLessThan(0.75);
    expect(res[0].confidence).toBeGreaterThanOrEqual(0.75);
  });
  it("preferred SKU redirection: the preferred column redirects a row and flags the SKU; a note in that column does not", () => {
    const ids = new Map([["ONB12STF", "a"], ["NB12STF", "b"], ["176674PF", "c"]]);
    const { ids: cand, crossById } = curatedCandidates([
      { ownSku: "ONB12STF", preferredOwnSku: "176674PF", matchType: "Close Match", source: "S", approvalStatus: "APPROVED" },
      { ownSku: "NB12STF", preferredOwnSku: "DUPLICATE", matchType: "Close Match", source: "S", approvalStatus: "APPROVED" },
      { ownSku: "ONB12STF", preferredOwnSku: "see notes", matchType: "Exact Match", source: "S2", approvalStatus: "APPROVED" },
    ], ids);
    expect([...cand].sort()).toEqual(["a", "b", "c"]);
    expect(crossById.get("c")).toMatchObject({ ownSku: "ONB12STF", preferred: true, matchType: "Close Match" }); // redirected row
    expect(crossById.get("b")).toMatchObject({ preferred: false }); // "DUPLICATE" is a note, not a SKU in the catalog
    expect(crossById.get("a")).toMatchObject({ matchType: "Exact Match", preferred: false });
    // preferred ranks first inside its grade
    const res = scoreCandidates(comp("CTF73", "Applied Medical", "12 x 100 mm Kii Fios first entry access system Z-Threaded"), [
      own("NB12STF", "Versaport Plus Bladeless 12 mm Standard length with fixation cannula", { knownCross: { matchType: "Close Match", source: "S", approvalStatus: "APPROVED" } }),
      own("ONB12STF", "VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm", { knownCross: { matchType: "Close Match", source: "S", approvalStatus: "APPROVED", preferred: true } }),
    ]);
    expect(res[0].sku).toBe("ONB12STF");
    expect(res[0].rationale).toMatch(/reviewer's preferred cross/);
  });
  it("duplicate candidates: several curated rows for one SKU collapse to one candidate; the better grade wins; approved beats draft whatever the grade", () => {
    const ids = new Map([["NB12STF", "b"]]);
    const rows = [
      { ownSku: "NB12STF", preferredOwnSku: null, matchType: "Exact Match", source: "rep", approvalStatus: "DRAFT" },
      { ownSku: "nb12stf", preferredOwnSku: null, matchType: "Alternative Match", source: "Sheet1", approvalStatus: "APPROVED" },
      { ownSku: "NB12STF", preferredOwnSku: null, matchType: "Close Match", source: "Sheet2", approvalStatus: "APPROVED" },
    ];
    const { ids: cand, crossById } = curatedCandidates(rows, ids);
    expect(cand.size).toBe(1);
    expect(crossById.get("b")).toMatchObject({ source: "Sheet2", matchType: "Close Match", approvalStatus: "APPROVED" });
    // reversed order gives the same answer (order-independent)
    expect(curatedCandidates([...rows].reverse(), ids).crossById.get("b")).toMatchObject({ source: "Sheet2", matchType: "Close Match" });
    // unknown SKUs are dropped, not candidates
    expect(curatedCandidates([{ ownSku: "NOPE", preferredOwnSku: null, matchType: "Exact Match", source: "S", approvalStatus: "APPROVED" }], ids).ids.size).toBe(0);
  });
  it("REP_PRIOR_BOOST is a soft prior: no floor, no tier change past a cap, never Exact on an unknown size", () => {
    expect(REP_PRIOR_BOOST).toBeLessThanOrEqual(0.12);
    const capped = scoreCandidates(B12(), [own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm", { knownCross: { matchType: "Exact Match", source: "rep", approvalStatus: "DRAFT", endorsements: 4 } })]);
    expect(capped[0]).toMatchObject({ matchType: "No Match", source: "attribute" });
    expect(capped[0].rationale).toMatch(/chosen by 4 reps before \(pending review\)/);
    const unsized = scoreCandidates(comp("X1", "Ethicon", "ENDOPATH XCEL Bladeless Trocars"), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { knownCross: { matchType: "Exact Match", source: "rep", approvalStatus: "DRAFT" } })]);
    expect(unsized[0].matchType).not.toBe("Exact Match");
    expect(unsized[0].confidence).toBeLessThan(0.75);
    // the lift is at most REP_PRIOR_BOOST over the plain attribute score, and the score never exceeds 1
    const plain = scoreCandidates(B12(), [own("NONB12SHF", "VersaOne Bladeless Trocar with Smooth Cannula; Size: 12 mm; Length: 70 mm")])[0];
    const boosted = scoreCandidates(B12(), [own("NONB12SHF", "VersaOne Bladeless Trocar with Smooth Cannula; Size: 12 mm; Length: 70 mm", { knownCross: { matchType: "Exact Match", source: "rep", approvalStatus: "IN_REVIEW" } })])[0];
    expect(boosted.scoreBin - plain.scoreBin).toBeCloseTo(Math.min(REP_PRIOR_BOOST, 1 - plain.scoreBin), 6);
    expect(boosted.factors.curated).toBeUndefined();
    expect(boosted.matchType).toBe("Close Match"); // length class differs: the cap holds
  });
});

describe("ws1 ranking: weights, identity and provenance precedence", () => {
  it("weights reorder inside a grade only; identity, grade order and caps are unaffected by extreme weights", () => {
    const line = comp("NB12STF", "Medtronic", "Versaport Plus Bladeless 12 mm Standard length with fixation cannula");
    line.estPrice = 100;
    const cands = [
      own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { unitPrice: 50 }),
      own("NB12STF", "Versaport Plus Bladeless 12 mm Standard length with fixation cannula", { identity: true, unitPrice: 500 }),
      own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm", { unitPrice: 1 }),
    ];
    for (const w of [DEFAULT_WEIGHTS, { bin: 0, price: 10, cogs: 0, margin: 0 }, { bin: 10, price: 0, cogs: 0, margin: 0 }]) {
      const res = scoreCandidates(line, cands, w);
      expect(res[0]).toMatchObject({ sku: "NB12STF", source: "identity", matchType: "Exact Match", confidence: 1 });
      expect(res[res.length - 1]).toMatchObject({ sku: "UNVCA12STF", matchType: "No Match" });
      expect(res.every((r) => r.factors.weights === w)).toBe(true);
    }
  });
  it("price-heavy weights change the order of two same-grade attribute matches; defaults keep the closer product first", () => {
    const line = comp("D11LT", "Ethicon", "ENDOPATH XCEL Dilating Tip Trocars 11 mm, 100 mm length");
    line.estPrice = 100;
    const cands = [
      own("NONB11STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 11 mm; Length: 100 mm", { unitPrice: 110 }), // 10 % dearer: price fit 0.8
      own("NB11STF", "Versaport Plus Bladeless 11 mm 100 mm Trocar with Fixation Cannula", { unitPrice: 60 }),
    ];
    const byDefault = scoreCandidates(line, cands);
    const byPrice = scoreCandidates(line, cands, { bin: 0.05, price: 0.95, cogs: 0, margin: 0 });
    expect(byDefault.map((r) => r.matchType)).toEqual(byPrice.map((r) => r.matchType)); // grades never move with weights
    expect(byPrice[0].sku).toBe("NB11STF");
    expect(byPrice[0].scorePrice).toBe(1);
    expect(byPrice.find((r) => r.sku === "NONB11STF")?.scorePrice).toBeCloseTo(0.8, 6);
  });
  it("ties are broken by SKU so the order never depends on input order", () => {
    const a = own("NONB11STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 11 mm; Length: 100 mm");
    const b = own("NB11STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 11 mm; Length: 100 mm");
    const line = comp("D11LT", "Ethicon", "ENDOPATH XCEL Dilating Tip Trocars 11 mm, 100 mm length");
    expect(scoreCandidates(line, [a, b]).map((r) => r.sku)).toEqual(scoreCandidates(line, [b, a]).map((r) => r.sku));
    expect(scoreCandidates(line, [b, a])[0].sku).toBe("NB11STF");
    const pool = [a, b].map((c) => ({ id: c.sku, sku: c.sku, bin: c.bin, description: c.description }));
    expect(attributeShortlist(line.bin, line.description, pool, 5).map((p) => p.sku)).toEqual(attributeShortlist(line.bin, line.description, [...pool].reverse(), 5).map((p) => p.sku));
  });
  it("gudid-import provenance loses ties to curated SKUs; source order is curated before attribute at equal grade and confidence", () => {
    const line = B12();
    const res = scoreCandidates(line, [
      own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { provenance: "gudid-import", ownProductId: "imp" }),
      own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { provenance: "seed", ownProductId: "seed" }),
    ]);
    expect(res.map((r) => r.ownProductId)).toEqual(["seed", "imp"]);
    expect(res[1].factors.notes.some((n) => /GUDID import/.test(n))).toBe(true);
  });
});

describe("ws1 ranking: SELF_MATCH successors", () => {
  const rows = (list: SelfRow[]) => new Map(list.map((r) => [r.sku.toUpperCase(), r]));
  const active = (sku: string, successorSku: string | null = null): SelfRow => ({ sku, isActive: true, status: "In Commercial Distribution", successorSku });
  const gone = (sku: string, successorSku: string | null = null): SelfRow => ({ sku, isActive: false, status: "Not in Commercial Distribution", successorSku });
  const pool = (...skus: string[]) => (s: string) => skus.includes(s);
  it("active → itself; not in the catalog → nothing", () => {
    expect(resolveSelfMatch("nb12stf", rows([active("NB12STF")]), pool("NB12STF"))).toEqual({ selfSku: "NB12STF", successorOf: null, note: null });
    expect(resolveSelfMatch("NB12STF", rows([]), pool("NB12STF"))).toEqual({ selfSku: null, successorOf: null, note: null });
    expect(resolveSelfMatch("NB12STF", rows([active("NB12STF")]), pool()).note).toMatch(/not in the candidate pool/);
  });
  it("discontinued with an active successor → the successor as identity; via a chain of discontinued successors too", () => {
    expect(resolveSelfMatch("OLD12", rows([gone("OLD12", "NEW12"), active("NEW12")]), pool("NEW12"))).toEqual({ selfSku: "NEW12", successorOf: "OLD12", note: null });
    expect(resolveSelfMatch("A1X", rows([gone("A1X", "B2X"), gone("B2X", "C3X"), active("C3X")]), pool("C3X"))).toMatchObject({ selfSku: "C3X", successorOf: "A1X", note: "successor reached through A1X → B2X → C3X" });
    // status alone (still isActive) counts as discontinued
    expect(resolveSelfMatch("A1X", rows([{ sku: "A1X", isActive: true, status: "Not in Commercial Distribution", successorSku: "B2X" }, active("B2X")]), pool("B2X")).selfSku).toBe("B2X");
  });
  it("missing, unknown, inactive or invalid successors fall through with an explanation", () => {
    expect(resolveSelfMatch("A1X", rows([gone("A1X")]), pool()).note).toMatch(/discontinued \(no successor on file\)/);
    expect(resolveSelfMatch("A1X", rows([gone("A1X", "B2X")]), pool()).note).toMatch(/successor B2X is not in our catalog/);
    expect(resolveSelfMatch("A1X", rows([gone("A1X", "B2X"), active("B2X")]), pool()).note).toMatch(/successor B2X is not an active catalog SKU/);
    expect(resolveSelfMatch("A1X", rows([gone("A1X", "see notes")]), pool()).note).toMatch(/is not a catalog number/);
    expect(resolveSelfMatch("A1X", rows([gone("A1X", "B2X"), gone("B2X")]), pool()).note).toMatch(/no successor on file after B2X/);
    for (const r of [resolveSelfMatch("A1X", rows([gone("A1X")]), pool()), resolveSelfMatch("A1X", rows([gone("A1X", "B2X")]), pool())]) expect(r).toMatchObject({ selfSku: null, successorOf: null });
  });
  it("a cyclic successor chain (A → B → A) terminates with an explanation, never a loop", () => {
    const r = resolveSelfMatch("A1X", rows([gone("A1X", "B2X"), gone("B2X", "A1X")]), pool("A1X", "B2X"));
    expect(r).toMatchObject({ selfSku: null, successorOf: null });
    expect(r.note).toMatch(/successor chain loops: A1X → B2X → A1X/);
    expect(resolveSelfMatch("A1X", rows([gone("A1X", "A1X")]), pool("A1X")).note).toMatch(/loops: A1X → A1X/);
    const long = resolveSelfMatch("A1X", rows([gone("A1X", "B2X"), gone("B2X", "C3X"), gone("C3X", "D4X"), gone("D4X", "E5X"), gone("E5X", "F6X"), gone("F6X", "G7X"), active("G7X")]), pool("G7X"));
    expect(long.selfSku).toBeNull();
    expect(long.note).toMatch(/chain longer than 5/);
  });
  it("scoreCandidates keeps identity and successor identity at Exact, confidence 1, with the note", () => {
    const [s] = scoreCandidates(comp("OLD12", "Medtronic", "Versaport Plus Bladeless 12 mm"), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm", { identity: true, successorOf: "OLD12" })]);
    expect(s).toMatchObject({ matchType: "Exact Match", source: "identity", confidence: 1, scoreBin: 1 });
    expect(s.rationale).toMatch(/successor to our discontinued SKU OLD12/);
    expect(s.factors.cap).toBe("Exact Match");
  });
});

describe("ws1 ranking: the model grader is bound by the cap", () => {
  const lineInput = (lineId: string, cfn: string, description: string, candidates: ScoredCandidate[]): GradeLineInput => ({ lineId, cfn, manufacturer: "Ethicon", brand: "ENDOPATH XCEL", description, bin: heuristicBin({ code: cfn, manufacturer: "Ethicon", description }), candidates });
  it("a fake verdict of Exact for a hard-capped pair persists as the cap (No Match); a curated SKU the model calls No Match keeps its grade; identity stays Exact", () => {
    const line = B12();
    const scored = scoreCandidates(line, [
      own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm"),
      own("ONB12STF", "VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm", { knownCross: { matchType: "Exact Match", source: "S", approvalStatus: "APPROVED" } }),
      own("B12LT", "ENDOPATH XCEL Bladeless Trocars 12 mm, 100 mm length", { identity: true }),
    ]);
    const input = lineInput("L1", "B12LT", line.description, scored);
    const verdict: GroupGrade = { constructionVerdict: "fake", lines: [{ cfn: "B12LT", bestSku: "UNVCA12STF", grades: [
      { sku: "UNVCA12STF", matchType: "Exact Match", rationale: "model says exact", additionalProducts: null, clinicalCaveat: null },
      { sku: "ONB12STF", matchType: "No Match", rationale: "model says no", additionalProducts: null, clinicalCaveat: null },
      { sku: "B12LT", matchType: "Alternative Match", rationale: "model demotes identity", additionalProducts: null, clinicalCaveat: null },
    ] }] };
    const out = applyGroupGrades([input], verdict, false).get("L1")!;
    const by = (sku: string) => out.find((c) => c.sku === sku)!;
    expect(by("UNVCA12STF").matchType).toBe("No Match"); // cap binds
    expect(by("UNVCA12STF").rationale).toBe("model says exact");
    expect(by("ONB12STF").matchType).toBe(scored.find((c) => c.sku === "ONB12STF")!.matchType); // curated keeps its prior grade
    expect(by("B12LT").matchType).toBe("Exact Match"); // identity
    expect(out[0].sku).toBe("B12LT");
    expect(out[out.length - 1].sku).toBe("UNVCA12STF"); // bestSku cannot move a No Match to the front
    expect(by("UNVCA12STF").factors.notes).toContain("graded by model");
  });
  it("a verdict that lowers a grade is applied; a soft cap (Close) binds an Exact verdict", () => {
    const line = B12();
    const scored = scoreCandidates(line, [own("ONB12STF", "VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm"), own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    expect(scored.find((c) => c.sku === "ONB12STF")!.factors.cap).toBe("Close Match");
    const verdict: GroupGrade = { constructionVerdict: "fake", lines: [{ cfn: "B12LT", bestSku: null, grades: [
      { sku: "ONB12STF", matchType: "Exact Match", rationale: "r", additionalProducts: null, clinicalCaveat: null },
      { sku: "NONB12STF", matchType: "Alternative Match", rationale: "r2", additionalProducts: "HANDLE-1", clinicalCaveat: "check" },
    ] }] };
    const out = applyGroupGrades([lineInput("L1", "B12LT", line.description, scored)], verdict, true).get("L1")!;
    expect(out.find((c) => c.sku === "ONB12STF")!.matchType).toBe("Close Match");
    const demoted = out.find((c) => c.sku === "NONB12STF")!;
    expect(demoted.matchType).toBe("Alternative Match");
    expect(demoted.rationale).toBe("r2 Caveat: check");
    expect((demoted as ScoredCandidate & { additionalProducts?: string }).additionalProducts).toBe("HANDLE-1");
    expect(demoted.factors.notes).toContain("graded by model (cached verdict)");
  });
  it("the sibling floor never lifts a hard-capped No Match (a cannula stays No Match for the trocar sibling)", () => {
    const sleeveLine = comp("CB12LT", "Ethicon", "ENDOPATH XCEL Universal Sleeves 12 mm, 100 mm length");
    const trocarLine = B12();
    const sleeve = () => own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm");
    const s1 = scoreCandidates(sleeveLine, [sleeve()]);
    const s2 = scoreCandidates(trocarLine, [sleeve()]);
    expect(s1[0].matchType).not.toBe("No Match");
    expect(s2[0]).toMatchObject({ matchType: "No Match" }); expect(s2[0].factors.cap).toBe("No Match");
    const group = [lineInput("S", "CB12LT", sleeveLine.description, s1), lineInput("T", "B12LT", trocarLine.description, s2)];
    const verdict: GroupGrade = { constructionVerdict: "fake", lines: [
      { cfn: "CB12LT", bestSku: "UNVCA12STF", grades: [{ sku: "UNVCA12STF", matchType: "Exact Match", rationale: "r", additionalProducts: null, clinicalCaveat: null }] },
      { cfn: "B12LT", bestSku: null, grades: [{ sku: "UNVCA12STF", matchType: "No Match", rationale: "r", additionalProducts: null, clinicalCaveat: null }] },
    ] };
    const out = applyGroupGrades(group, verdict, false);
    expect(out.get("T")![0].matchType).toBe("No Match");
    expect(out.get("T")![0].factors.notes).not.toContain("lifted to Alternative by sibling consistency");
    // …but a soft No Match (score too low, no hard cap) is lifted for consistency
    const weak = { ...s2[0], matchType: "No Match", factors: { ...s2[0].factors, cap: "Exact Match" } } as ScoredCandidate;
    const out2 = applyGroupGrades([group[0], lineInput("T2", "B12LT", trocarLine.description, [weak])], { constructionVerdict: "fake", lines: [verdict.lines[0], { ...verdict.lines[1] }] }, false);
    expect(out2.get("T2")![0].matchType).toBe("Alternative Match");
    expect(out2.get("T2")![0].factors.notes).toContain("lifted to Alternative by sibling consistency");
  });
  it("no verdict (model failure) leaves the heuristic verdicts standing", () => {
    const line = B12();
    const scored = scoreCandidates(line, [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    expect(applyGroupGrades([lineInput("L", "B12LT", line.description, scored)], null, false).get("L")).toBe(scored);
  });
});

describe("ws1 ranking: confidence is not similarity", () => {
  it("a low-confidence curated Exact and a high-confidence attribute Exact can share a score; grade, score and confidence are separate", () => {
    const line = B12();
    const [top] = scoreCandidates(line, [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    expect(top.matchType).toBe("Exact Match");
    expect(top.confidence).toBeCloseTo(0.8 * (0.6 + 0.4 * 1), 6); // attribute base × full coverage
    const sim = binSimilarity(line.bin, top.bin);
    expect(sim.access?.coverage).toBe(1);
    const [thin] = scoreCandidates(comp("X", "Ethicon", "ENDOPATH XCEL Bladeless Trocars"), [own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    expect(thin.confidence).toBeLessThan(top.confidence);
    expect(thin.matchType).toBe("Close Match");
  });
});

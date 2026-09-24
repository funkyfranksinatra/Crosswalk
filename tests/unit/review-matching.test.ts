/**
 * Independent review — can any WS1 change make "Exact Match" easier than the hard/soft caps allow?
 * Adversarial pairs with identical sizes: cannula vs trocar (hard), dilating vs bladed, optical vs
 * non-optical (soft), a negated description, and the fake grader re-bound after all other changes.
 * Pure: no database, no model.
 */
import { describe, it, expect } from "vitest";
import { heuristicBin, binSimilarity, BIN_VERSION } from "@/lib/match/bin";
import { scoreCandidates, type CandidateInput, type ScoredCandidate } from "@/lib/match/score";
import { componentOf } from "@/lib/match/component";
import { applyGroupGrades, type GradeLineInput, type GroupGrade } from "@/lib/match/grading";

const own = (sku: string, description: string, extra: Partial<CandidateInput> = {}): CandidateInput => ({ ownProductId: sku, sku, description, bin: heuristicBin({ sku, manufacturer: "Medtronic", description, category: "Trocar Products" }), unitPrice: null, cogs: null, provenance: "seed", ...extra });
const comp = (code: string, manufacturer: string, description: string) => ({ bin: heuristicBin({ code, manufacturer, description }), description, estPrice: null as number | null });
const grades = (line: ReturnType<typeof comp>, cands: CandidateInput[]) => Object.fromEntries(scoreCandidates(line, cands).map((c) => [c.sku, { grade: c.matchType, cap: c.factors.cap ?? null, score: c.score }]));

describe("review: adversarial pairs never reach Exact through the WS1 changes (BIN_VERSION 8)", () => {
  it("BIN_VERSION is 8 (rebuild forced for the negation / component changes)", () => { expect(BIN_VERSION).toBe(8); });

  it("cannula vs trocar with identical sizes: hard cap No Match in both directions, in binSimilarity and scoreCandidates", () => {
    const trocarLine = comp("X-TROCAR-12", "Ethicon", "ENDOPATH XCEL Bladeless Trocar 12 mm x 100 mm");
    const cannulaLine = comp("X-CANNULA-12", "Ethicon", "ENDOPATH XCEL Fixation Cannula 12 mm x 100 mm, cannula only");
    const trocar = own("T12", "VersaOne Bladeless Trocar with Fixation Cannula; 12 mm x 100 mm");
    const cannula = own("C12", "VersaOne Universal Fixation Cannula; 12 mm x 100 mm");
    expect(componentOf(trocar.description)).toBe("trocar");
    expect(componentOf(cannula.description)).toBe("cannula");
    const simTC = binSimilarity(trocarLine.bin, cannula.bin), simCT = binSimilarity(cannulaLine.bin, trocar.bin);
    expect(simTC.cap).toBe("No Match");
    expect(simCT.cap).toBe("No Match");
    const g1 = grades(trocarLine, [trocar, cannula]);
    expect(g1.C12.grade).toBe("No Match");
    expect(g1.T12.grade).not.toBe("No Match");
    const g2 = grades(cannulaLine, [trocar, cannula]);
    expect(g2.T12.grade).toBe("No Match");
    expect(g2.C12.grade).not.toBe("No Match");
  });

  it("the extended 'with … cannula' component rule does not turn cannula-only text into a trocar", () => {
    for (const text of [
      "VersaOne Universal Fixation Cannula 12 mm, for use with VersaOne bladeless trocar",
      "Fixation cannula 12 mm x 100 mm for use with the Versaport Plus bladeless trocar",
      "Endopath Xcel stability sleeve 12 mm (sleeve only)",
    ]) expect(componentOf(text), text).toBe("cannula");
    for (const text of ["Versaport Plus Bladeless 12 mm x 100 mm with fixation cannula", "Bladeless obturator with 100mm Radiolucent Sleeve, 12 mm", "ENDOPATH XCEL Bladeless Trocar with Stability Sleeve 12 mm"]) expect(componentOf(text), text).toBe("trocar");
  });

  it("dilating-tip vs bladed (same size): capped below Exact; bladed line does not get a dilating-tip Exact", () => {
    const bladedLine = comp("X-BLADED-12", "Ethicon", "ENDOPATH Bladed Trocar 12 mm x 100 mm, shielded blade");
    const dilating = own("D12", "VersaOne Dilating Tip Trocar with Fixation Cannula; 12 mm x 100 mm");
    const bladed = own("B12", "VersaOne Bladed Trocar with Fixation Cannula; 12 mm x 100 mm");
    const g = grades(bladedLine, [dilating, bladed]);
    expect(g.D12.grade).not.toBe("Exact Match");
    expect(binSimilarity(bladedLine.bin, dilating.bin).cap === null || binSimilarity(bladedLine.bin, dilating.bin).cap !== "Exact Match").toBe(true);
    expect(["Exact Match", "Close Match"]).toContain(g.B12.grade);
  });

  it("optical vs non-optical (same size): the soft cap holds; the negated 'non-optical' text no longer reads as optical", () => {
    // (an "ENDOPATH XCEL Optical …" line would be read as non-optical by the unchanged `ethicon.xcel` brand prior — Xcel optical entry is OPTIVIEW — so a neutral brand carries the word)
    const opticalLine = comp("X-OPT-12", "Genicon", "Optical Bladeless Trocar 12 mm x 100 mm, visualized entry");
    const optical = own("O12", "VersaOne Optical Trocar with Fixation Cannula; 12 mm x 100 mm");
    const nonOptical = own("N12", "VersaOne Bladeless Trocar with Fixation Cannula; 12 mm x 100 mm");
    // REV note: with the VersaOne brand word the un-guarded `mdt.versaone-optical` rule still reads "Non-Optical" as optical
    // (REVIEW.md REV finding); the generic negation rule is exercised here without the brand word.
    const negated = own("NEG12", "Non-Optical Bladeless Trocar with Fixation Cannula; 12 mm x 100 mm");
    expect(negated.bin.access?.visualization ?? JSON.stringify(negated.bin)).not.toBe("optical");
    const g = grades(opticalLine, [optical, nonOptical, negated]);
    expect(g.N12.grade).not.toBe("Exact Match");
    expect(g.NEG12.grade).not.toBe("Exact Match");
    expect(g.O12.grade).toBe("Exact Match");
    const g2 = grades(comp("X-NONOPT-12", "Genicon", "Bladeless Trocar 12 mm x 100 mm, non-optical"), [optical, nonOptical, negated]);
    expect(g2.O12.grade).not.toBe("Exact Match");
  });

  it("the fake grader is still bound by the cap after every other change: Exact verdict on a cannula stays No Match; sibling floor never lifts it", () => {
    const line = comp("B12LT", "Ethicon", "ENDOPATH XCEL Bladeless Trocars 12 mm, 100 mm length");
    const scored = scoreCandidates(line, [own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm"), own("NONB12STF", "VersaOne Bladeless Trocar with Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    const mk = (id: string, cfn: string, cands: ScoredCandidate[]): GradeLineInput => ({ lineId: id, cfn, manufacturer: "Ethicon", brand: "ENDOPATH XCEL", description: line.description, bin: line.bin, candidates: cands });
    const verdict: GroupGrade = { constructionVerdict: "fake", lines: [
      { cfn: "B12LT", bestSku: "UNVCA12STF", grades: [{ sku: "UNVCA12STF", matchType: "Exact Match", rationale: "model says exact", additionalProducts: null, clinicalCaveat: null }, { sku: "NONB12STF", matchType: "Exact Match", rationale: "ok", additionalProducts: null, clinicalCaveat: null }] },
      { cfn: "B5LT", bestSku: "UNVCA12STF", grades: [{ sku: "UNVCA12STF", matchType: "Alternative Match", rationale: "sibling", additionalProducts: null, clinicalCaveat: null }] },
    ] };
    const sibling = scoreCandidates(comp("B5LT", "Ethicon", "ENDOPATH XCEL Fixation Cannula 12 mm (cannula only)"), [own("UNVCA12STF", "VersaOne Universal Fixation Cannula; Size: 12 mm; Length: 100 mm")]);
    const out = applyGroupGrades([mk("L1", "B12LT", scored), mk("L2", "B5LT", sibling)], verdict, false);
    const l1 = out.get("L1")!;
    expect(l1.find((c) => c.sku === "UNVCA12STF")!.matchType).toBe("No Match");
    expect(l1[0].sku).toBe("NONB12STF");
    expect(l1.find((c) => c.sku === "NONB12STF")!.matchType).toBe("Exact Match");
  });
});

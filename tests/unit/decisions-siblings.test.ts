/**
 * Sibling-family evidence and sleeve-attribute clauses (the product-truth questions the debug run
 * left to a sheet owner, answered by the labeler's own catalog instead — docs/MATCH_QUALITY_MODEL.md §3.4).
 */
import { describe, it, expect } from "vitest";
import { brandRoot, siblingsOf, siblingAssertions, type SiblingRecord } from "@/lib/match/siblings";
import { componentOf } from "@/lib/match/component";
import { heuristicBin } from "@/lib/match/bin";
import { buildAccessProfile } from "@/lib/match/access";

const line = (brand: string, n: number, desc: string): SiblingRecord[] => Array.from({ length: n }, (_, i) => ({ code: `${brand.replace(/\s+/g, "")}-${i + 1}`, brand, description: desc }));

describe("brand root", () => {
  it("strips the feature markers a labeler appends to a line name", () => {
    expect(brandRoot("ENDOPATH XCEL OPTIVIEW")).toBe("ENDOPATH XCEL");
    expect(brandRoot("Endopath Xcel with OPTIVIEW Technology")).toBe("ENDOPATH XCEL");
    expect(brandRoot("Kii Fios First Entry")).toBe("KII FIRST ENTRY");
    expect(brandRoot("Acme Port™")).toBe("ACME PORT");
    expect(brandRoot(null)).toBe("");
  });
});

describe("sibling assertions", () => {
  const plain: SiblingRecord = { code: "AP-12-100", brand: "Acme Port", description: "Acme Port Bladeless Trocar 12 mm x 100 mm" };
  const optical = line("Acme Port Optical", 4, "Acme Port Optical Bladeless Trocar 12 mm x 100 mm with optical entry");
  const bladeless = line("Acme Port", 5, "Acme Port Bladeless Trocar 5 mm x 100 mm");
  it("a plain record in a line whose optical variants are marked is non-optical, with the siblings as provenance", () => {
    const sib = siblingsOf(plain, [...optical, ...bladeless]);
    expect(sib.length).toBe(9);
    const a = siblingAssertions(plain, sib, "Acme");
    expect(a).toHaveLength(1);
    expect(a[0].assert).toEqual({ visualization: "non-optical" });
    expect(a[0].via).toMatch(/Acme marks optical products in this line \(4 sibling records, e\.g\. AcmePortOptical-1/);
  });
  it("never argues with the record's own words, and needs enough marked siblings", () => {
    const stated: SiblingRecord = { ...plain, description: "Acme Port Optical Trocar 12 mm" };
    expect(siblingAssertions(stated, siblingsOf(stated, optical), "Acme")).toEqual([]);
    expect(siblingAssertions(plain, siblingsOf(plain, optical.slice(0, 2)), "Acme")).toEqual([]);
  });
  it("only siblings of the same line count — a different brand, a sleeve or a needle is not a sibling", () => {
    const other = [...line("Other Port Optical", 5, "Other Port Optical Trocar 12 mm"), ...line("Acme Port Optical", 5, "Acme Port Optical universal sleeve only"), ...line("Acme Port Optical", 5, "Acme Port Optical Veress insufflation needle")];
    expect(siblingsOf(plain, other)).toHaveLength(0);
    expect(siblingAssertions(plain, siblingsOf(plain, other), "Acme")).toEqual([]);
  });
  it("fills the profile gap below the record's text and above the intake description; corroborates a generic prior with the family evidence", () => {
    const sib = siblingsOf(plain, [...optical, ...bladeless]);
    // no tip word → no generic prior: the siblings fill the gap, and the rep's intake text cannot override them
    const bare: SiblingRecord = { ...plain, description: "Acme Port Trocar 12 mm x 100 mm" };
    const p = buildAccessProfile([{ text: bare.description, source: "gudid:description" }, ...siblingAssertions(bare, sib, "Acme").map((a) => ({ text: null, source: "gudid:siblings" as const, assert: a.assert, via: a.via })), { text: "OPTICAL 12MM TROCAR", source: "intake:description" }]);
    expect(p.visualization).toBe("non-optical");
    expect(p.evidence.find((e) => e.field === "visualization")?.source).toBe("gudid:siblings");
    // "bladeless" carries the generic non-optical prior; the siblings turn it into corroborated evidence
    const bin = heuristicBin({ code: plain.code, brand: plain.brand, description: plain.description, manufacturer: "Acme", siblings: [...optical, ...bladeless] });
    expect(bin.access?.visualization).toBe("non-optical");
    expect(bin.access?.evidence.some((e) => e.field === "visualization" && e.source === "gudid:siblings" && /corroborated/.test(e.value))).toBe(true);
    const own = heuristicBin({ sku: "OPT12", brand: "Ours", description: "Ours Optical Trocar 12 mm x 100 mm bladeless", manufacturer: "Ours" });
    expect(own.access?.visualization).toBe("optical");
  });
  it("an explicit optical marker on the record itself is read before the siblings and wins", () => {
    const marked: SiblingRecord = { code: "AP-12-100-O", brand: "Acme Port Optical", description: "Acme Port Optical Bladeless Trocar 12 mm x 100 mm" };
    const bin = heuristicBin({ code: marked.code, brand: marked.brand, description: marked.description, manufacturer: "Acme", siblings: [...optical, ...bladeless] });
    expect(bin.access?.visualization).toBe("optical");
  });
});

describe("sleeve-attribute clauses", () => {
  it("a sleeve quality named after the trocar describes the trocar (Thoracoport), sleeve-only SKUs stay cannulas", () => {
    expect(componentOf("Thoracoport™ 10.5 mm for instrument up to 11 mm; Single Use Trocar; Non-conductive Sleeve")).toBe("trocar");
    expect(componentOf("Thoracoport 5.5 mm for instrument up to 6 mm; Single Use Trocar; Non Conductive Sleeve")).toBe("trocar");
    expect(componentOf("Trocar 12 mm; Smooth Sleeve")).toBe("trocar");
    expect(componentOf("Trocar; Sleeve only")).toBe("cannula");
    expect(componentOf("Trocar sleeve assembly")).toBe("cannula");
    expect(componentOf("12 mm trocar; universal sleeve")).toBe("cannula");
    expect(componentOf("Fixation cannula for use with 12 mm trocar")).toBe("cannula");
  });
  it("a sleeve sold with its obturator is the complete device (Endopath thoracic trocar sleeves), so it crosses to Thoracoport", () => {
    expect(componentOf("ENDOPATH — Endopath Surgical Thoracic Trocar Sleeves with Rounded Tip Obturator")).toBe("trocar");
    expect(componentOf("Fixation Cannula; for use with obturator")).toBe("cannula");
    expect(componentOf("Obturator with seal")).toBe("obturator");
    expect(componentOf("Universal sleeve with instrument seal")).toBe("cannula");
    expect(componentOf("Trocar Sleeve; 12 mm")).toBe("cannula");
  });
});

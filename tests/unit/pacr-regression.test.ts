/**
 * PACR-win regression suite (REQ-7628) and adversarial match tests, offline: the trocar-family
 * catalog, the competitor codes as GUDID resolved them (+ intake descriptions) and the curated rows
 * live in tests/fixtures/trocar-benchmark.json. Lines are judged exactly as the pipeline judges them
 * (src/lib/match/line.ts + scoreCandidates), so a matcher change that loses one of these shows here
 * before it reaches an account.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { heuristicBin, type Bin } from "@/lib/match/bin";
import { scoreCandidates, type CandidateInput, type ScoredCandidate } from "@/lib/match/score";
import { attributeShortlist, competitorBinForLine, curatedCandidates } from "@/lib/match/line";

type Fixture = {
  catalog: { sku: string; description: string; brand: string | null; labeler: string | null; gmdnName: string | null; sizes: { type?: string; value?: string; unit?: string }[] }[];
  competitors: { code: string; manufacturer: string | null; brand: string | null; description: string | null; gmdnName: string | null; sizes: { type?: string; value?: string; unit?: string }[]; intake: string | null }[];
  crosses: { competitorCodeNorm: string; ownSku: string; preferredOwnSku: string | null; matchType: string; source: string; competitorDescription: string | null }[];
};
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/trocar-benchmark.json"), "utf8")) as Fixture;

const pool = fx.catalog.map((p) => ({ id: p.sku, sku: p.sku, description: p.description, bin: heuristicBin({ sku: p.sku, manufacturer: p.labeler ?? "Medtronic", brand: p.brand, description: p.description, gmdnName: p.gmdnName, sizes: p.sizes, category: "Trocar Products" }) }));
const idBySku = new Map(pool.map((p) => [p.sku.toUpperCase(), p.id]));
const byId = new Map(pool.map((p) => [p.id, p]));

/** Judge one competitor code the way run.ts does (heuristic mode, no prices). */
function judge(code: string, opts: { intake?: string | null; withCrosses?: boolean; selfSku?: string | null; manufacturer?: string } = {}): ScoredCandidate[] {
  const found = fx.competitors.find((c) => c.code === code);
  if (!found) throw new Error(`fixture has no competitor ${code}`);
  const cp = opts.manufacturer ? { ...found, manufacturer: opts.manufacturer } : found;
  const curatedDescription = opts.withCrosses === false ? null : fx.crosses.find((k) => k.competitorCodeNorm === code && k.competitorDescription)?.competitorDescription ?? null;
  const description = [cp.description, curatedDescription && !(cp.description ?? "").includes(curatedDescription) ? curatedDescription : null].filter((x): x is string => Boolean(x)).join(" ; ");
  const cached: Bin = heuristicBin({ code, manufacturer: cp.manufacturer, name: cp.brand, brand: cp.brand, description, gmdnName: cp.gmdnName, sizes: cp.sizes });
  const compBin = competitorBinForLine(cached, opts.intake === undefined ? cp.intake : opts.intake);
  const crosses = opts.withCrosses === false ? [] : fx.crosses.filter((k) => k.competitorCodeNorm === code).map((k) => ({ ...k, approvalStatus: "APPROVED" }));
  const { ids, crossById } = curatedCandidates(crosses, idBySku);
  for (const o of attributeShortlist(compBin, cp.description ?? "", pool, 12)) ids.add(o.id);
  if (opts.selfSku && idBySku.has(opts.selfSku)) ids.add(idBySku.get(opts.selfSku)!);
  const inputs: CandidateInput[] = [...ids].map((id) => { const o = byId.get(id)!; const k = crossById.get(id); return { ownProductId: id, sku: o.sku, description: o.description, bin: o.bin, unitPrice: null, cogs: null, provenance: "seed", identity: opts.selfSku != null && o.sku.toUpperCase() === opts.selfSku, knownCross: k ? { matchType: k.matchType, preferredOwnSku: k.preferredOwnSku, source: k.source, approvalStatus: "APPROVED", preferred: k.preferred } : null }; });
  return scoreCandidates({ bin: compBin, description: cp.description ?? "", estPrice: null }, inputs);
}
const top = (code: string, opts?: Parameters<typeof judge>[1]) => judge(code, opts).filter((c) => c.matchType !== "No Match")[0];
const rankOf = (res: ScoredCandidate[], sku: string) => { const i = res.findIndex((c) => c.sku.toUpperCase() === sku.toUpperCase() && c.matchType !== "No Match"); return i < 0 ? null : i + 1; };

describe("PACR-win regression suite (REQ-7628)", () => {
  const cases: [string, string, string?][] = [
    ["2B5ST", "ONB5SHF", "OPTIVIEW 5 mm short → optical 5 x 70"], ["2B5LT", "ONB5STF"], ["2B5XT", "ONB5LGF", "XT = 150 mm despite the item master's '100 mm'"], ["2B12XT", "ONB12LGF"],
    ["CTF04", "ONB5STF", "Kii Fios 5 x 100 optical"], ["CTF73", "ONB12STF"], ["CTF74", "ONB12STF"],
    ["CB5ST", "UNVCA5SHF", "universal sleeve → cannula only, never a trocar"], ["CB5LT", "UNVCA5STF"], ["CB11LT", "UNVCA11STF"], ["CB12LT", "UNVCA12STF"], ["2CB5LT", "UNVCA5STF"], ["2CB12LT", "UNVCA12STF"], ["CTB11LT", "UNVCA11STF"], ["CTB12LT", "UNVCA12STF"],
    ["23NBL", "MS101003", "2 mm/3 mm parsed as a size set"],
  ];
  for (const [code, want, why] of cases) it(`${code} → ${want}${why ? ` (${why})` : ""}`, () => {
    const t = top(code);
    expect(t?.sku, judge(code).slice(0, 3).map((c) => `${c.sku} ${c.matchType} ${c.score.toFixed(2)} [${c.rationale}]`).join("\n")).toBe(want);
  });
  it("dilating tip = bladeless: D5LT / D11LT / D12LT → the bladeless fixation trocar of that size (VersaOne or Versaport Plus — equal specs; the priced one wins in a run); the bladed curated rows are demoted", () => {
    for (const [code, ok, bladed] of [["D5LT", ["NONB5STF", "NB5STF"], "B5STF"], ["D11LT", ["NONB11STF", "NB11STF"], "B11STF"], ["D12LT", ["NONB12STF", "NB12STF"], "B12STF"]] as const) {
      const res = judge(code);
      expect(ok, `${code}: ${res.slice(0, 3).map((c) => `${c.sku} ${c.matchType}`).join(", ")}`).toContain(res[0].sku);
      expect(res.find((c) => c.sku === bladed)?.matchType, `${code} ${bladed}`).not.toBe("Exact Match");
    }
  });
  it("CTF71 (Kii Fios 12 x 150 optical) → ONB12LGF; PACR's 5 mm pick would be a diameter mismatch", () => {
    const res = judge("CTF71");
    expect(res[0].sku).toBe("ONB12LGF");
    expect(res.find((c) => c.sku === "ONB5STF")?.matchType ?? "No Match").not.toMatch(/Exact|Close/);
  });
  it("OPTIVIEW / Kii Fios / Optical Separator lines put optical trocars first", () => {
    for (const code of ["2B5LT", "CTF04", "CTF73", "C0124", "CFF01"]) expect(top(code)?.description, code).toMatch(/Optical|Visiport/i);
  });
});

describe("adversarial match tests", () => {
  it("no cannula-only SKU is ever Exact or Close for a complete-trocar line", () => {
    for (const code of ["B12LTH", "D11LT", "2B5XT", "CTF04", "C0124"]) for (const c of judge(code)) {
      if (/Universal .*Cannula|Sleeve$|cannula only/i.test(c.description) && !/Trocar|Step|radially/i.test(c.description)) expect(c.matchType, `${code} → ${c.sku}`).toMatch(/Alternative|No Match/);
    }
  });
  it("no trocar is Exact or Close for a cannula-only line", () => {
    for (const code of ["CB12LT", "CTB12LT", "CFS22"]) for (const c of judge(code)) if (/Trocar with|Optical Trocar|Bladeless Trocar|Bladed Trocar/i.test(c.description)) expect(c.matchType, `${code} → ${c.sku}`).toMatch(/Alternative|No Match/);
  });
  it("a 5 mm line never gets a 12 mm Exact/Close, and a 12 mm line never a 5 mm one", () => {
    for (const c of judge("2B5XT")) if (/12 mm/.test(c.description)) expect(c.matchType, c.sku).toMatch(/Alternative|No Match/);
    for (const c of judge("2B12XT")) if (/5 mm/.test(c.description) && !/5 mm - 1[12] mm/.test(c.description)) expect(c.matchType, c.sku).toMatch(/Alternative|No Match/);
  });
  it("an insufflation needle does not cross to a trocar or a dilating system", () => {
    const res = judge("C2201");
    for (const c of res) if (/Trocar|VersaStep|Step/i.test(c.description) && !/needle/i.test(c.description)) expect(c.matchType, c.sku).toBe("No Match");
  });
  it("a seal / valve line crosses only to accessories", () => {
    for (const c of judge("YA05VSS01")) if (/Trocar|Cannula|Sleeve|Obturator|Step/i.test(c.description) && !/Seal|Valve|Reducer|Cap/i.test(c.description)) expect(c.matchType, c.sku).toBe("No Match");
  });
  it("a record without sizes, from a manufacturer without a SKU convention, is never Exact (size unconfirmed)", () => {
    const t = top("B12LTH", { intake: null, withCrosses: false, manufacturer: "Acme Surgical" });
    expect(t?.matchType).not.toBe("Exact Match");
    expect(t?.confidence ?? 0).toBeLessThan(0.75);
  });
  it("an intake description cannot override the SKU convention, only fill it", () => {
    const res = judge("2B5XT", { intake: "ENDOPATH XCEL Bladeless Trocars with OPTIVIEW 5 mm, 100 mm length" });
    expect(res[0].sku).toBe("ONB5LGF");
  });
  it("SELF_MATCH: our own code is retained as itself ahead of every substitute", () => {
    const res = judge("175772P", { selfSku: "175772P", withCrosses: false });
    expect(res[0]).toMatchObject({ sku: "175772P", source: "identity", matchType: "Exact Match", confidence: 1 });
  });
  it("Exact requires evidence: fewer than 4 decisive attributes known caps at Close", () => {
    const res = judge("MDO12-100", { intake: null, withCrosses: false });
    const exact = res.filter((c) => c.matchType === "Exact Match");
    for (const c of exact) expect(c.factors.evidence?.filter((e) => e.kind === "agree").length ?? 0, c.sku).toBeGreaterThanOrEqual(4);
  });
  it("PACR's 7 mm → 5 mm cross (FP007 → 179308) is not reproduced", () => {
    expect(judge("FP007").find((c) => c.sku === "179308")?.matchType ?? "No Match").toMatch(/Alternative|No Match/);
  });
  it("PACR's 5 mm → 12 mm blunt cross (C0Q20 → 176626P) is not reproduced", () => {
    expect(judge("C0Q20").find((c) => c.sku === "176626P")?.matchType ?? "No Match").toMatch(/Alternative|No Match/);
  });
  it("next-best alternatives are distinct SKUs that survive the hard constraints, each explained", () => {
    const res = judge("CTF73").filter((c) => c.matchType !== "No Match").slice(0, 3);
    expect(new Set(res.map((c) => c.sku)).size).toBe(res.length);
    for (const c of res) { expect(c.rationale.length).toBeGreaterThan(20); expect(c.factors.evidence?.some((e) => e.kind === "hard")).toBe(false); }
  });
});

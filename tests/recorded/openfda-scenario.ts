/**
 * The resolver scenario that is recorded once (scripts/record-openfda.ts) and replayed
 * offline by tests/unit/openfda-replay.test.ts. Keep it deterministic: no model, fixed codes.
 */
import { prisma } from "@/lib/db";
import { resolveCfn, buildContext } from "@/lib/pipeline/resolve";

export const CODES = ["1DLMC05", "SPMII", "1190500", "PPM1510X3", "1410015010", "112660"] as const;

export type ScenarioResult = Record<string, { resolution: string; manufacturer: string | null; cfnMatched: string | null; confidence: number | null }>;

export async function runScenario(): Promise<ScenarioResult> {
  const out: ScenarioResult = {};
  for (const code of CODES) await prisma.competitorProduct.deleteMany({ where: { cfnNorm: code } });
  // Pass 1: strict, no context (what the pipeline does first).
  for (const code of CODES.slice(0, 5)) {
    const cp = await resolveCfn(code, { useLlm: false, strict: true });
    if (cp) out[code] = { resolution: cp.resolution, manufacturer: cp.manufacturer, cfnMatched: cp.cfnMatched, confidence: cp.confidence };
  }
  // Pass 2: the Excel-stripped Bard code resolves with list context (the other lines are Bard/Gore/Ethicon).
  const ctx = buildContext([{ manufacturer: "BD - Bard", category: null, binFamily: "Hernia Mesh" }, { manufacturer: "BD - Bard", category: null, binFamily: "Hernia Mesh" }, { manufacturer: "W.L. Gore", category: null, binFamily: "Hernia Mesh" }], [...CODES], "Medtronic", ["Covidien"]);
  const bard = await resolveCfn("112660", { useLlm: false, ctx });
  if (bard) out["112660"] = { resolution: bard.resolution, manufacturer: bard.manufacturer, cfnMatched: bard.cfnMatched, confidence: bard.confidence };
  return out;
}

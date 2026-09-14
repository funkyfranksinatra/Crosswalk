/**
 * Consistent model grading.
 *
 * Two guarantees a rep can rely on:
 *  1. Siblings — lines from the same manufacturer, brand and product family —
 *     are graded together in ONE model call with an explicit consistency rule,
 *     so 8×16 and 8×20 of the same mesh cannot get different constructions
 *     verdicts. A deterministic floor then enforces it even if the model slips.
 *  2. Every verdict is cached by a hash of its exact inputs (competitor bins,
 *     candidate bins, model, prompt version). Re-running with unchanged data
 *     replays the stored verdict instead of asking the model again, so a
 *     re-run cannot flip a line.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { structured, llmConfig } from "@/lib/llm/client";
import { constructionSignature, type Bin } from "./bin";
import type { ScoredCandidate } from "./score";

export const GRADE_PROMPT_VERSION = 3;
export const MAX_GROUP = 8; // lines per call; bigger groups are split
export const MAX_SHORTLIST = 6; // candidates per line sent to the model

const MATCH_RANK: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "No Match": 3 };

export type GradeLineInput = {
  lineId: string;
  cfn: string;
  manufacturer: string | null;
  brand: string | null;
  description: string | null;
  bin: Bin;
  candidates: ScoredCandidate[];
};

/**
 * Siblings share manufacturer, brand, family AND construction. The construction signature is what
 * makes the group's single verdict valid: Phasix (flat) and Phasix ST (barrier) share a brand but not
 * a construction, and "GORE DUALMESH" vs "GORE-TEX Soft Tissue Patch" share only the word GORE.
 */
export function siblingKey(l: { manufacturer: string | null; brand: string | null; bin: Bin }): string {
  const brand = (l.brand ?? "").toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, " ").trim() || "-";
  return `${(l.manufacturer ?? "?").toLowerCase()}|${brand}|${l.bin.family}|${constructionSignature(l.bin)}`;
}

export function groupSiblings<T extends { manufacturer: string | null; brand: string | null; bin: Bin }>(lines: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const l of lines) {
    const k = siblingKey(l);
    map.set(k, [...(map.get(k) ?? []), l]);
  }
  const groups: T[][] = [];
  for (const g of map.values()) for (let i = 0; i < g.length; i += MAX_GROUP) groups.push(g.slice(i, i + MAX_GROUP));
  return groups;
}

// ---------------------------------------------------------------------------

const LineGradeSchema = z.object({
  cfn: z.string(),
  grades: z.array(
    z.object({
      sku: z.string(),
      matchType: z.enum(["Exact Match", "Close Match", "Alternative Match", "No Match"]),
      rationale: z.string().describe("one or two sentences a rep can read to the customer"),
      additionalProducts: z.string().nullable().describe("other SKUs the customer must also buy (handle, shell, adapter), or null"),
      clinicalCaveat: z.string().nullable(),
    }),
  ),
  bestSku: z.string().nullable(),
});
const GroupGradeSchema = z.object({
  constructionVerdict: z.string().describe("one sentence stating the construction relationship that applies to EVERY line in this group, e.g. 'fully resorbable P4HB vs permanent polypropylene: Alternative at best'"),
  lines: z.array(LineGradeSchema),
});
export type GroupGrade = z.infer<typeof GroupGradeSchema>;

function shortlist(c: ScoredCandidate[]) {
  return c.slice(0, MAX_SHORTLIST);
}

/** Stable key for a group's inputs. Anything that could change the verdict is in it. */
export function gradeCacheKey(group: GradeLineInput[], companyName: string): string {
  const payload = {
    v: GRADE_PROMPT_VERSION,
    model: llmConfig().model,
    company: companyName,
    lines: group.map((l) => ({ cfn: l.cfn, bin: stripBin(l.bin), cands: shortlist(l.candidates).map((c) => ({ sku: c.sku, bin: stripBin(c.bin), kc: c.knownCross?.matchType ?? null })) })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function stripBin(b: Bin) {
  // exclude the summary sentence: cosmetic, and free to vary between binner runs
  const { summary: _s, function: _f, ...rest } = b;
  return rest;
}

/** Grade one sibling group, using the cache when the inputs are unchanged. */
export async function gradeGroup(group: GradeLineInput[], companyName: string, onLog?: (m: string) => Promise<void>, opts: { ignoreCache?: boolean } = {}): Promise<{ grade: GroupGrade | null; cached: boolean }> {
  if (!llmConfig().available || group.length === 0) return { grade: null, cached: false };
  const key = gradeCacheKey(group, companyName);
  const hit = opts.ignoreCache ? null : await prisma.llmGrade.findUnique({ where: { key } });
  if (hit) {
    try {
      const parsed = GroupGradeSchema.safeParse(JSON.parse(hit.json));
      if (parsed.success) return { grade: parsed.data, cached: true };
    } catch {}
  }

  const isGroup = group.length > 1;
  const user = [
    isGroup
      ? `These ${group.length} competitor products are SIBLINGS: same manufacturer (${group[0].manufacturer ?? "?"}), same brand (${group[0].brand ?? "?"}), same product family. They differ only in size/configuration.`
      : `One competitor product.`,
    "",
    ...group.flatMap((l, i) => [
      `LINE ${i + 1} — ${l.cfn}: ${l.description ?? ""}`,
      `  bin: ${JSON.stringify(stripBin(l.bin))}`,
      `  ${companyName} candidates:`,
      ...shortlist(l.candidates).map((c, j) => `    ${j + 1}. ${c.sku} — ${c.description}\n       bin: ${JSON.stringify(stripBin(c.bin))}\n       attribute score ${(c.scoreBin * 100).toFixed(0)}% → ${c.matchType}${c.knownCross ? `\n       curated cross reference on file: ${c.knownCross.matchType} (${c.knownCross.source})` : ""}`),
      "",
    ]),
    "Grade every candidate on every line. Exact = same function, size and construction (a surgeon would accept it 1:1). Close = same function and construction, minor size/feature differences. Alternative = fulfils the need with a different construction or platform. No Match = not a substitute at all.",
    isGroup
      ? "CONSISTENCY RULE: construction differences (material, absorbability, barrier, plug vs flat) are identical across siblings, so the construction verdict must be identical across siblings — state it once in constructionVerdict and apply it to every line. Only SIZE may move a candidate between tiers, and never from Alternative to No Match: if a candidate is an Alternative for one sibling it is at least an Alternative for the others."
      : "State the construction relationship in constructionVerdict.",
    "bestSku: the single SKU the rep should quote for that line. Among the candidates in the best tier, prefer the one with the FEWEST construction differences from the competitor (an uncoated mesh for an uncoated mesh before one that adds a barrier or changes the base polymer), then the closest size — an oversize sheet that can be trimmed beats an undersize one, and a round of similar diameter beats a much larger rectangle. Use the same product platform across siblings whenever sizes allow.",
    "Respect curated cross references unless the attributes clearly contradict them. Return one entry per line, in the same order, echoing each line's cfn exactly.",
  ].join("\n");

  const res = await structured({
    purpose: isGroup ? "grade-group" : "grade",
    subject: group.map((l) => l.cfn).join(","),
    system: `You are a clinical product specialist at ${companyName} preparing a competitive cross-reference for a hospital bid. Be precise, conservative, consistent across sibling products, and explain in plain language.`,
    user,
    schema: GroupGradeSchema,
    schemaName: "group_grades",
    maxOutputTokens: 600 + 900 * group.length,
  });
  if (!res.ok) {
    await onLog?.(`  model grading failed for ${group.map((l) => l.cfn).join(", ")}: ${res.error.slice(0, 160)} — heuristic verdicts kept`);
    return { grade: null, cached: false };
  }
  await prisma.llmGrade.upsert({ where: { key }, create: { key, model: res.model, json: JSON.stringify(res.data), lines: group.length }, update: { json: JSON.stringify(res.data), model: res.model } }).catch(() => {});
  return { grade: res.data, cached: false };
}

/**
 * Apply a group's grades to each line's scored candidates and enforce the
 * sibling floor deterministically. Returns the re-ordered candidates per line.
 */
export function applyGroupGrades(group: GradeLineInput[], grade: GroupGrade | null, cached: boolean): Map<string, ScoredCandidate[]> {
  const out = new Map<string, ScoredCandidate[]>();
  if (!grade) {
    for (const l of group) out.set(l.lineId, l.candidates);
    return out;
  }
  const byCfn = new Map(grade.lines.map((g) => [g.cfn.toUpperCase(), g]));
  const bestByLine = new Map<string, string | null>();

  // Pass 1: apply the model's per-line grades.
  for (const l of group) {
    const g = byCfn.get(l.cfn.toUpperCase()) ?? grade.lines[group.indexOf(l)];
    if (!g) { out.set(l.lineId, l.candidates); continue; }
    bestByLine.set(l.lineId, g.bestSku);
    let scored = l.candidates.map((s) => {
      const gg = g.grades.find((x) => x.sku.toUpperCase() === s.sku.toUpperCase());
      if (!gg) return s;
      const rationale = [gg.rationale, gg.clinicalCaveat ? `Caveat: ${gg.clinicalCaveat}` : null].filter(Boolean).join(" ");
      const matchType = s.knownCross && gg.matchType === "No Match" ? s.matchType : s.identity ? "Exact Match" : gg.matchType;
      return { ...s, matchType, rationale, factors: { ...s.factors, notes: [...s.factors.notes, cached ? "graded by model (cached verdict)" : "graded by model", ...(group.length > 1 ? [`graded with ${group.length - 1} sibling line(s)`] : [])] }, additionalProducts: gg.additionalProducts ?? undefined } as ScoredCandidate & { additionalProducts?: string };
    });
    scored = sortGraded(scored, g.bestSku);
    out.set(l.lineId, scored);
  }

  // Pass 2: sibling floor — a SKU that is at least an Alternative for one sibling can't be No Match for another.
  if (group.length > 1) {
    const floor = new Map<string, string>(); // sku -> best non-No-Match tier seen in the group
    for (const l of group) for (const s of out.get(l.lineId) ?? []) {
      if (s.matchType === "No Match") continue;
      const prev = floor.get(s.sku);
      if (!prev || MATCH_RANK[s.matchType] < MATCH_RANK[prev]) floor.set(s.sku, s.matchType);
    }
    for (const l of group) {
      const scored = (out.get(l.lineId) ?? []).map((s) => {
        if (s.matchType !== "No Match" || !floor.has(s.sku)) return s;
        return { ...s, matchType: "Alternative Match", rationale: `${s.rationale ?? ""} Rated Alternative for consistency with sibling products on this list.`.trim(), factors: { ...s.factors, notes: [...s.factors.notes, "lifted to Alternative by sibling consistency"] } };
      });
      out.set(l.lineId, sortGraded(scored, bestByLine.get(l.lineId) ?? null));
    }
  }
  return out;
}

function sortGraded(scored: ScoredCandidate[], bestSku: string | null): ScoredCandidate[] {
  const sorted = [...scored].sort((a, b) => {
    const m = (MATCH_RANK[a.matchType] ?? 3) - (MATCH_RANK[b.matchType] ?? 3);
    return m !== 0 ? m : b.score - a.score;
  });
  const best = bestSku ? sorted.find((s) => s.sku.toUpperCase() === bestSku.toUpperCase()) : null;
  if (best && best.matchType !== "No Match" && best.matchType === sorted[0].matchType && best !== sorted[0]) return [best, ...sorted.filter((s) => s !== best)];
  return sorted;
}

/**
 * Ranking. Every candidate gets a composite score built from the factors
 * that are actually available for it. Missing factors don't silently
 * punish a product — the weights renormalise — and the factor set used is
 * stored on the candidate so the UI can show *why* something ranked first.
 */
import type { Bin } from "./bin";
import { binSimilarity, matchTypeFromScore } from "./bin";

export type Weights = { bin: number; price: number; cogs: number; margin: number };
export const DEFAULT_WEIGHTS: Weights = { bin: 0.5, price: 0.2, cogs: 0.15, margin: 0.15 };

export const MATCH_ORDER: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "US Downsell Match": 2, "No Match": 3 };

/** Curated crosses are strong evidence; give them a bin-score floor. */
export const KNOWN_CROSS_FLOOR: Record<string, number> = { "Exact Match": 0.95, "Close Match": 0.8, "Alternative Match": 0.62, "US Downsell Match": 0.6 };

export type CandidateInput = {
  ownProductId: string;
  sku: string;
  description: string;
  bin: Bin;
  unitPrice: number | null; // from selected pricebook or list price
  cogs: number | null;
  identity?: boolean; // the competitor code *is* this SKU
  /** "seed" | "manual" | "gudid-import" — imported SKUs rank below curated ones at equal match quality */
  provenance?: string | null;
  knownCross?: { matchType: string; preferredOwnSku?: string | null; additionalProducts?: string | null; notes?: string | null; source: string } | null;
};

export type ScoredCandidate = CandidateInput & {
  matchType: string;
  source: "known-cross" | "attribute" | "identity";
  score: number;
  scoreBin: number;
  scorePrice: number | null;
  scoreCogs: number | null;
  scoreMargin: number | null;
  factors: { used: string[]; weights: Weights; notes: string[] };
  rationale: string;
};

export function scoreCandidates(
  competitor: { bin: Bin; description: string; estPrice: number | null },
  candidates: CandidateInput[],
  weights: Weights = DEFAULT_WEIGHTS,
): ScoredCandidate[] {
  const cogsValues = candidates.map((c) => c.cogs).filter((v): v is number => v != null);
  const cogsMin = cogsValues.length ? Math.min(...cogsValues) : null;
  const cogsMax = cogsValues.length ? Math.max(...cogsValues) : null;

  const scored = candidates.map<ScoredCandidate>((c) => {
    const sim = binSimilarity(competitor.bin, c.bin, competitor.description, c.description);
    let scoreBin = sim.score;
    let matchType = matchTypeFromScore(scoreBin, sim.dimensions, sim.cap);
    let source: ScoredCandidate["source"] = "attribute";
    const notes = [...sim.notes];
    if (c.provenance === "gudid-import") notes.push("SKU added from a GUDID import — not in the curated catalog, no price on file");

    if (c.identity) {
      scoreBin = 1;
      matchType = "Exact Match";
      source = "identity";
      notes.unshift("this is already our product — retain");
    }

    if (c.knownCross && !c.identity) {
      const floor = KNOWN_CROSS_FLOOR[c.knownCross.matchType] ?? 0.6;
      scoreBin = Math.max(scoreBin, floor);
      matchType = c.knownCross.matchType === "US Downsell Match" ? "Alternative Match" : c.knownCross.matchType;
      source = "known-cross";
      notes.unshift(`curated cross reference (${c.knownCross.source})`);
    }

    // Price competitiveness: how does our price compare with what they pay today?
    let scorePrice: number | null = null;
    if (competitor.estPrice != null && c.unitPrice != null && competitor.estPrice > 0) {
      const ratio = c.unitPrice / competitor.estPrice;
      scorePrice = ratio <= 1 ? 1 : Math.max(0, 1 - (ratio - 1) * 2); // 25% dearer -> 0.5, 50% dearer -> 0
      notes.push(ratio <= 1 ? `priced ${Math.round((1 - ratio) * 100)}% under competitor` : `priced ${Math.round((ratio - 1) * 100)}% over competitor`);
    }

    // Cost to manufacture: relative to the other candidates for this line.
    let scoreCogs: number | null = null;
    if (c.cogs != null && cogsMin != null && cogsMax != null) {
      scoreCogs = cogsMax === cogsMin ? 1 : 1 - (c.cogs - cogsMin) / (cogsMax - cogsMin);
    }

    // Margin: (price - cogs) / price, saturating at 60% margin.
    let scoreMargin: number | null = null;
    if (c.cogs != null && c.unitPrice != null && c.unitPrice > 0) {
      const margin = (c.unitPrice - c.cogs) / c.unitPrice;
      scoreMargin = Math.max(0, Math.min(1, margin / 0.6));
      notes.push(`${Math.round(margin * 100)}% margin`);
    }

    const parts: [string, number | null, number][] = [
      ["bin", scoreBin, weights.bin],
      ["price", scorePrice, weights.price],
      ["cogs", scoreCogs, weights.cogs],
      ["margin", scoreMargin, weights.margin],
    ];
    let acc = 0;
    let wsum = 0;
    const used: string[] = [];
    for (const [name, v, w] of parts) {
      if (v == null) continue;
      acc += v * w;
      wsum += w;
      used.push(name);
    }
    const score = wsum ? acc / wsum : 0;

    return {
      ...c,
      matchType,
      source,
      score,
      scoreBin,
      scorePrice,
      scoreCogs,
      scoreMargin,
      factors: { used, weights, notes },
      rationale: notes.slice(0, 4).join("; "),
    };
  });

  // Order: match quality, then evidence strength, then composite score.
  const SOURCE_ORDER: Record<string, number> = { identity: 0, "known-cross": 1, attribute: 2 };
  // Curated / hand-added SKUs are verified commercial products; SKUs adopted from a GUDID import are
  // not (unpriced, uncurated) and lose ties.
  const provenanceRank = (c: ScoredCandidate) => (c.provenance === "gudid-import" ? 1 : 0);
  scored.sort((a, b) => {
    const m = (MATCH_ORDER[a.matchType] ?? 3) - (MATCH_ORDER[b.matchType] ?? 3);
    if (m !== 0) return m;
    const so = (SOURCE_ORDER[a.source] ?? 2) - (SOURCE_ORDER[b.source] ?? 2);
    if (so !== 0) return so;
    const pr = provenanceRank(a) - provenanceRank(b);
    if (pr !== 0) return pr;
    return b.score - a.score;
  });
  return scored;
}

/**
 * Ranking. Every candidate gets a composite score built from the factors
 * that are actually available for it. Missing factors don't silently
 * punish a product — the weights renormalise — and the factor set used is
 * stored on the candidate so the UI can show *why* something ranked first.
 *
 * Three things come out per candidate and they are kept apart (docs/MATCH_QUALITY_MODEL.md §1):
 * the match score (similarity on the evidence), the classification (Exact / Close / Alternative /
 * No Match) and the confidence (how much evidence supports that classification).
 */
import type { Bin } from "./bin";
import { binSimilarity, matchTypeFromScore } from "./bin";
import type { Grade } from "./constraints";

export type Weights = { bin: number; price: number; cogs: number; margin: number };
export const DEFAULT_WEIGHTS: Weights = { bin: 0.5, price: 0.2, cogs: 0.15, margin: 0.15 };

/**
 * The one grade ordering (docs/MATCH_QUALITY_MODEL.md §5.1): Exact > Close > Alternative > US Downsell > No Match.
 * A downsell is a partial substitute — a weaker recommendation than an Alternative (its curated floor is
 * lower and its equivalence level is PARTIAL_SUBSTITUTE), never its equal. line.ts `betterCross` and the
 * candidate sort below both read this table; nothing else may define its own.
 */
export const MATCH_ORDER: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "US Downsell Match": 3, "No Match": 4 };
/** Rank of a grade string; unknown grades sort last. */
export const gradeRank = (grade: string): number => MATCH_ORDER[grade] ?? MATCH_ORDER["No Match"] + 1;

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
  /** identity via succession: the competitor code is our discontinued SKU and this is its successor */
  successorOf?: string | null;
  /** "seed" | "manual" | "gudid-import" — imported SKUs rank below curated ones at equal match quality */
  provenance?: string | null;
  knownCross?: { id?: string; matchType: string; preferredOwnSku?: string | null; additionalProducts?: string | null; notes?: string | null; source: string; /** DRAFT / IN_REVIEW rep proposals are a soft prior, never a tier floor */ approvalStatus?: string; endorsements?: number; /** the reviewer's preferred cross for this competitor code, across every curated row */ preferred?: boolean; /** a reviewer confirmed this row against soft evidence (Crosswalk → Evidence conflicts → Keep): soft findings no longer demote it; hard ones still do */ kept?: boolean } | null;
};

/** How much a rep-proposed (unreviewed) cross lifts the bin score: enough to surface it, never enough to change the tier on its own. */
export const REP_PRIOR_BOOST = 0.12;

export type ScoredCandidate = CandidateInput & {
  matchType: string;
  source: "known-cross" | "attribute" | "identity";
  score: number;
  scoreBin: number;
  scorePrice: number | null;
  scoreCogs: number | null;
  scoreMargin: number | null;
  /** evidence strength for `matchType`, 0..1 — below 0.75 the rep is asked to verify */
  confidence: number;
  factors: { used: string[]; weights: Weights; notes: string[]; evidence?: { kind: string; field: string; text: string }[]; curated?: { source: string; grade: string; effective: string; contradicted: boolean; preferred: boolean; /** the KnownCross row, so a run can queue the contradiction for review */ knownCrossId?: string; /** a reviewer kept the row despite soft findings */ kept?: boolean; /** the findings that contradict the sheet (hard and soft), for the review queue */ findings?: string[] }; /** best grade the hard/soft constraints allow — binds the model grader too */ cap?: string };
  rationale: string;
};

const GRADE_RANK: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "No Match": 3 };
const worse = (a: string, b: string): string => (GRADE_RANK[a] >= GRADE_RANK[b] ? a : b);

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
    const rawSim = sim.score;
    let scoreBin = sim.score;
    // Attributes alone: Exact needs most of the decisive fields known (constraints.ts attributeCap).
    let matchType = matchTypeFromScore(scoreBin, sim.dimensions, sim.access?.attributeCap ?? sim.cap);
    let source: ScoredCandidate["source"] = "attribute";
    const notes = [...sim.notes];
    const evidence = sim.access?.findings ?? [];
    const hard = sim.access?.hard ?? 0;
    const soft = sim.access?.soft ?? 0;
    let curated: ScoredCandidate["factors"]["curated"];
    if (c.provenance === "gudid-import") notes.push("SKU added from a GUDID import — not in the curated catalog, no price on file");

    // ---- confidence (docs/MATCH_QUALITY_MODEL.md §6) ---------------------------------------
    let base = 0.8;
    // How much of the decisive evidence is known on both sides.
    const coverage = sim.access ? 0.6 + 0.4 * sim.access.coverage : sim.dimensions === null ? 0.7 : sim.dimensions <= 0.35 && /unknown on one side/.test(notes.join(" ")) ? 0.75 : 1;

    if (c.identity) {
      scoreBin = 1;
      matchType = "Exact Match";
      source = "identity";
      base = 1;
      notes.unshift(c.successorOf ? `successor to our discontinued SKU ${c.successorOf} — the customer already buys this from us` : "this is already our product — retain");
    }

    const unreviewed = c.knownCross && c.knownCross.approvalStatus !== undefined && c.knownCross.approvalStatus !== "APPROVED";
    if (c.knownCross && !c.identity && !unreviewed) {
      // The sheet is evidence, not an override: its grade holds unless a hard or soft constraint says
      // otherwise, and then the explanation names both the sheet and the contradiction.
      const sheetGrade = c.knownCross.matchType === "US Downsell Match" ? "Alternative Match" : c.knownCross.matchType;
      // A row a reviewer KEPT holds its grade against soft findings (length class, optical, tip…);
      // a hard finding (component, diameter) still caps it — nobody can confirm a sleeve into a trocar.
      const keptAgainstSoft = Boolean(c.knownCross.kept) && !(sim.access?.hard ?? 0);
      const effective = keptAgainstSoft ? sheetGrade : worse(sheetGrade, sim.cap as Grade);
      const contradicted = effective !== sheetGrade;
      source = "known-cross";
      base = 0.9;
      if (effective === "No Match") { matchType = "No Match"; scoreBin = rawSim; }
      else {
        matchType = effective;
        const floor = KNOWN_CROSS_FLOOR[effective] ?? 0.6;
        // The floor carries the sheet's judgement; the attributes still order candidates inside a grade.
        scoreBin = floor + (1 - floor) * rawSim;
      }
      const contradictions = (sim.access?.findings ?? []).filter((f) => f.kind === "hard" || f.kind === "soft").map((f) => f.text);
      curated = { source: c.knownCross.source, grade: sheetGrade, effective, contradicted, preferred: Boolean(c.knownCross.preferred), knownCrossId: c.knownCross.id, kept: keptAgainstSoft || undefined, findings: contradicted ? contradictions : undefined };
      if (keptAgainstSoft && contradictions.length) notes.push("curated grade kept by a reviewer despite: " + contradictions.join("; "));
      notes.unshift(contradicted ? `curated cross (${c.knownCross.source}, ${sheetGrade}) — contradicted by the product attributes; ranked as ${effective}` : `curated cross (${c.knownCross.source}, ${sheetGrade})${c.knownCross.preferred ? ", reviewer's preferred cross" : ""}`);
    } else if (c.knownCross && !c.identity && unreviewed) {
      // Learning loop: a rep chose this SKU for this code before. It earns a place on the shortlist and
      // a small lift, but the tier still comes from the attributes until clinical/marketing review approves it.
      scoreBin = Math.min(1, scoreBin + REP_PRIOR_BOOST);
      matchType = matchTypeFromScore(scoreBin, sim.dimensions, sim.access?.attributeCap ?? sim.cap);
      base = 0.6;
      const n = c.knownCross.endorsements ?? 1;
      notes.unshift(`chosen by ${n === 1 ? "a rep" : `${n} reps`} before (pending review)`);
    } else if (!c.identity) {
      notes.unshift(matchType === "No Match" ? "no acceptable match on the attributes" : "attribute match");
    }
    // A contradiction is uncertainty about a *curated* grade (the sheet said Exact, the attributes disagree).
    // On the attribute path the mismatch is already the reason for the grade, so it does not lower confidence.
    const contradiction = c.identity || source !== "known-cross" ? 0 : Math.min(0.9, 0.25 * soft + 0.5 * hard + (sim.access?.techniqueDiffers ? 0.125 : 0));
    let confidence = c.identity ? 1 : Math.max(0, Math.min(1, base * coverage * (1 - contradiction)));
    if (matchType === "No Match") confidence = Math.min(confidence, 0.5);

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
      confidence,
      factors: { used, weights, notes, evidence, curated, cap: c.identity ? "Exact Match" : sim.cap },
      rationale: notes.slice(0, 5).join("; "),
    };
  });

  // Order: match quality, then identity, then evidence strength (confidence: a curated cross with the
  // attributes behind it beats one whose SKU we know little about, and an attribute match with every
  // dimension confirmed beats a thin curated row), then the reviewer's preferred cross, then score.
  const SOURCE_ORDER: Record<string, number> = { identity: 0, "known-cross": 1, attribute: 2 };
  // Curated / hand-added SKUs are verified commercial products; SKUs adopted from a GUDID import are
  // not (unpriced, uncurated) and lose ties.
  const provenanceRank = (c: ScoredCandidate) => (c.provenance === "gudid-import" ? 1 : 0);
  // Confidence orders candidates only where it is measured on the decisive attributes (the access
  // model); families without a profile keep the curated-first, then score order.
  const accessAware = (c: ScoredCandidate) => Boolean(c.factors.evidence?.length);
  scored.sort((a, b) => {
    const m = gradeRank(a.matchType) - gradeRank(b.matchType);
    if (m !== 0) return m;
    const ident = Number(b.source === "identity") - Number(a.source === "identity");
    if (ident !== 0) return ident;
    const pr = provenanceRank(a) - provenanceRank(b);
    if (pr !== 0) return pr;
    const pf = Number(Boolean(b.knownCross?.preferred)) - Number(Boolean(a.knownCross?.preferred));
    if (pf !== 0) return pf;
    if (accessAware(a) && accessAware(b) && Math.abs(a.confidence - b.confidence) > 0.02) return b.confidence - a.confidence;
    const so = (SOURCE_ORDER[a.source] ?? 2) - (SOURCE_ORDER[b.source] ?? 2);
    if (so !== 0) return so;
    if (Math.abs(a.score - b.score) > 1e-6) return b.score - a.score;
    // Equal on every attribute (two platforms' same-spec SKUs): the one this customer has a price for is the offer.
    const priced = Number(b.unitPrice != null) - Number(a.unitPrice != null);
    if (priced !== 0) return priced;
    // Still tied: order by SKU so the result never depends on the order rows came out of the database
    // (a re-run, an export and the evaluation harness must all see the same ranking).
    return a.sku.localeCompare(b.sku);
  });
  // A near tie inside the top grade (two platforms' same-spec SKUs) is not doubt about the grade; the
  // explanation names the runner-up so the rep can pick the platform the customer prefers.
  if (scored.length > 1 && scored[0].matchType !== "No Match" && scored[1].matchType === scored[0].matchType && scored[0].source !== "identity" && scored[1].source !== "identity" && scored[0].score - scored[1].score < 0.02 && !scored[0].knownCross?.preferred) {
    scored[0].factors.notes.splice(1, 0, `${scored[1].sku} is an equivalent ${scored[0].matchType.replace(" Match", "").toLowerCase()} match`);
    scored[0].rationale = scored[0].factors.notes.slice(0, 5).join("; ");
  }
  return scored;
}

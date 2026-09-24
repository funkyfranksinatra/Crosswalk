/**
 * Per-line candidate assembly, shared by the pipeline (src/lib/pipeline/run.ts) and the offline
 * regression suite (tests/unit/pacr-regression.test.ts) so both judge a line the same way:
 *
 *   competitor bin (+ intake description)  →  curated crosses ∪ attribute shortlist  →  scoreCandidates
 */
import { binSimilarity, withAccessProfile, type Bin } from "./bin";
import { buildAccessProfile, mergeProfiles, emptyProfile } from "./access";

export type CrossRow = { ownSku: string; preferredOwnSku: string | null; matchType: string; source: string; approvalStatus: string; additionalProducts?: string | null; notes?: string | null; endorsements?: number };

const GRADE_ORDER: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "US Downsell Match": 3 };
export const betterCross = (a: string, b: string) => (GRADE_ORDER[a] ?? 9) < (GRADE_ORDER[b] ?? 9);

/** Fold the line's intake description into a (cached, GUDID-based) competitor bin: gaps only, evidence kept. */
export function competitorBinForLine(compBin: Bin, intakeDescription: string | null | undefined): Bin {
  if (compBin.family !== "Trocar Products" || !intakeDescription) return compBin;
  const extra = buildAccessProfile([{ text: intakeDescription, source: "intake:description" }]);
  return withAccessProfile(compBin, mergeProfiles(compBin.access ?? emptyProfile(), extra));
}

/**
 * Curated rows → one candidate per catalog SKU. A row's "preferred" column redirects it to the reviewer's
 * SKU; any SKU named in that column (and present in the catalog) is flagged `preferred` so it outranks
 * the other curated rows of its grade. Approved rows beat rep drafts; the better grade wins per SKU.
 */
export function curatedCandidates<T extends CrossRow>(crosses: T[], idBySku: Map<string, string>): { ids: Set<string>; crossById: Map<string, T & { preferred: boolean }> } {
  const ids = new Set<string>();
  const crossById = new Map<string, T & { preferred: boolean }>();
  const preferredSkus = new Set(crosses.map((k) => (k.preferredOwnSku ?? "").trim().toUpperCase()).filter((x) => x && idBySku.has(x)));
  const approved = (x: { approvalStatus: string }) => x.approvalStatus === "APPROVED";
  for (const k of crosses) {
    const sku = (k.preferredOwnSku && /^[A-Z0-9-]{4,}$/i.test(k.preferredOwnSku.trim()) ? k.preferredOwnSku : k.ownSku).trim().toUpperCase();
    const id = idBySku.get(sku);
    if (!id) continue;
    ids.add(id);
    const cur = crossById.get(id);
    if (!cur || (approved(k) && !approved(cur)) || (approved(k) === approved(cur) && betterCross(k.matchType, cur.matchType))) crossById.set(id, { ...k, preferred: preferredSkus.has(sku) });
  }
  return { ids, crossById };
}

/** Attribute shortlist: the family pool ranked by bin similarity, top N above the floor. */
export function attributeShortlist<T extends { id: string; bin: Bin; description: string }>(compBin: Bin, competitorDescription: string, pool: T[], max: number, floor = 0.3): T[] {
  return pool
    .filter((o) => compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family)
    .map((o) => ({ o, s: binSimilarity(compBin, o.bin, competitorDescription, o.description).score }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .filter((r) => r.s >= floor)
    .map((r) => r.o);
}

/**
 * Per-line candidate assembly, shared by the pipeline (src/lib/pipeline/run.ts) and the offline
 * regression suite (tests/unit/pacr-regression.test.ts) so both judge a line the same way:
 *
 *   competitor bin (+ intake description)  →  curated crosses ∪ attribute shortlist  →  scoreCandidates
 */
import { binSimilarity, withAccessProfile, type Bin } from "./bin";
import { buildAccessProfile, mergeProfiles, emptyProfile } from "./access";
import { gradeRank } from "./score";
import { isPlaceholderSku } from "@/lib/cfn";

export type CrossRow = { ownSku: string; preferredOwnSku: string | null; matchType: string; source: string; approvalStatus: string; additionalProducts?: string | null; notes?: string | null; endorsements?: number };

/** Strictly better grade per the one ordering in score.ts (Exact > Close > Alternative > US Downsell > No Match). */
export const betterCross = (a: string, b: string) => gradeRank(a) < gradeRank(b);

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
    // The preferred column redirects only to a SKU that exists in the catalog: reviewers also write notes
    // there (DUPLICATE, DISCONT, HAND, REPEAT…), and a note must not make the row vanish.
    const pref = (k.preferredOwnSku ?? "").trim().toUpperCase();
    const sku = pref && idBySku.has(pref) ? pref : k.ownSku.trim().toUpperCase();
    const id = idBySku.get(sku);
    if (!id) continue;
    ids.add(id);
    const cur = crossById.get(id);
    if (!cur || (approved(k) && !approved(cur)) || (approved(k) === approved(cur) && betterCross(k.matchType, cur.matchType))) crossById.set(id, { ...k, preferred: preferredSkus.has(sku) });
  }
  return { ids, crossById };
}

/** Attribute shortlist: the family pool ranked by bin similarity, top N above the floor. */
export function attributeShortlist<T extends { id: string; sku?: string; bin: Bin; description: string }>(compBin: Bin, competitorDescription: string, pool: T[], max: number, floor = 0.3): T[] {
  return pool
    .filter((o) => compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family)
    .map((o) => ({ o, s: binSimilarity(compBin, o.bin, competitorDescription, o.description).score }))
    .sort((a, b) => b.s - a.s || (a.o.sku ?? a.o.id).localeCompare(b.o.sku ?? b.o.id))
    .slice(0, max)
    .filter((r) => r.s >= floor)
    .map((r) => r.o);
}

/** What the catalog knows about one of our SKUs for SELF_MATCH. */
export type SelfRow = { sku: string; isActive: boolean; status: string | null; successorSku: string | null };
export type SelfMatch = { /** the SKU offered as identity (the code itself, or its live successor) */ selfSku: string | null; /** set when `selfSku` is a successor of the discontinued code */ successorOf: string | null; /** why no identity was offered, or how the successor was reached — for the line's rationale */ note: string | null };

const discontinued = (r: SelfRow) => !r.isActive || /not in commercial/i.test(r.status ?? "");
const SUCCESSOR_HOPS = 5;

/**
 * SELF_MATCH (docs/MATCH_QUALITY_MODEL.md §5): a competitor code that is our own SKU. Active → itself.
 * Discontinued → its successor, following a chain of discontinued successors up to SUCCESSOR_HOPS, with
 * a cycle guard (A → B → A ends with an explanation, never a loop); a missing, invalid or inactive
 * successor falls through to attribute matching with the reason on the line.
 */
export function resolveSelfMatch(selfCode: string, rows: Map<string, SelfRow>, inPool: (sku: string) => boolean): SelfMatch {
  const code = selfCode.toUpperCase();
  const row = rows.get(code);
  if (!row) return { selfSku: null, successorOf: null, note: null };
  if (!discontinued(row)) return inPool(code) ? { selfSku: code, successorOf: null, note: null } : { selfSku: null, successorOf: null, note: `Our SKU ${code} is not in the candidate pool — substitutes proposed from the catalog` };
  const visited = new Set<string>([code]);
  const path: string[] = [code];
  let cur = (row.successorSku ?? "").trim().toUpperCase();
  for (let hop = 0; hop < SUCCESSOR_HOPS; hop++) {
    if (!cur) return { selfSku: null, successorOf: null, note: `Our SKU ${code} is discontinued (no successor on file${path.length > 1 ? ` after ${path.slice(1).join(" → ")}` : ""}) — substitutes proposed from the catalog` };
    if (isPlaceholderSku(cur)) return { selfSku: null, successorOf: null, note: `Our SKU ${code} is discontinued (successor "${cur.slice(0, 40)}" is not a catalog number) — substitutes proposed from the catalog` };
    if (visited.has(cur)) return { selfSku: null, successorOf: null, note: `Our SKU ${code} is discontinued (successor chain loops: ${[...path, cur].join(" → ")}) — substitutes proposed from the catalog` };
    visited.add(cur); path.push(cur);
    const next = rows.get(cur);
    if (!next) return { selfSku: null, successorOf: null, note: `Our SKU ${code} is discontinued (successor ${cur} is not in our catalog) — substitutes proposed from the catalog` };
    if (!discontinued(next)) {
      if (!inPool(cur)) return { selfSku: null, successorOf: null, note: `Our SKU ${code} is discontinued (successor ${cur} is not an active catalog SKU) — substitutes proposed from the catalog` };
      return { selfSku: cur, successorOf: code, note: path.length > 2 ? `successor reached through ${path.join(" → ")}` : null };
    }
    cur = (next.successorSku ?? "").trim().toUpperCase();
  }
  return { selfSku: null, successorOf: null, note: `Our SKU ${code} is discontinued (successor chain longer than ${SUCCESSOR_HOPS}: ${path.join(" → ")} …) — substitutes proposed from the catalog` };
}

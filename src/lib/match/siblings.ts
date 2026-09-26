/**
 * Sibling-family evidence: what a labeler's OTHER records in the same product line say about
 * this one (docs/MATCH_QUALITY_MODEL.md §3.4).
 *
 * A record that names no visualization is "unknown" on its own words. But when the same labeler
 * marks the optical variants of the same line explicitly — Ethicon's "ENDOPATH XCEL OPTIVIEW"
 * next to "ENDOPATH XCEL", Applied's "Kii Fios First Entry" next to "Kii" — the absence of the
 * marker is itself evidence: the labeler would have said so. This module turns that into a
 * gap-filling assertion with the sibling records as provenance, so a curated row that crosses a
 * plain record to an optical product is contradicted by the labeler's own catalog rather than
 * left to a human with a spreadsheet.
 *
 * The inference is deliberately narrow: only binary features with one explicit marker (optical),
 * only within the same brand root, only when enough siblings carry the marker, and never when the
 * record itself mentions the marker (explicit text always wins and is read earlier).
 */
import { componentOf } from "./component";
import type { BrandAssertion } from "./brands";

export type SiblingRecord = { code: string | null; brand: string | null; description: string | null };

type Marker = {
  field: "visualization";
  /** the value the marker states */
  marked: "optical";
  /** the value implied by its absence */
  absent: "non-optical";
  re: RegExp;
  /** how many marked siblings make the inference safe */
  minSiblings: number;
};

export const SIBLING_MARKERS: readonly Marker[] = [
  { field: "visualization", marked: "optical", absent: "non-optical", re: /\boptiview\b|\boptical\b|\bvisual[\s-]*entry\b|\bfios\b|\bvisiport\b/i, minSiblings: 3 },
];

const MARKER_WORDS = /\b(?:with\s+)?(?:optiview(?:\s+technology)?|optical|fios|visual[\s-]*entry|visiport)\b/gi;

/** The line a brand belongs to once its feature markers are removed: "ENDOPATH XCEL OPTIVIEW" → "ENDOPATH XCEL". */
export function brandRoot(brand: string | null | undefined): string {
  return (brand ?? "").replace(/[™®©]/g, "").replace(MARKER_WORDS, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

function textOf(r: SiblingRecord): string {
  return [r.brand, r.description, r.code].filter(Boolean).join(" ; ");
}

/** The siblings that share this record's labeler line (same brand root) and are access products. */
export function siblingsOf(self: SiblingRecord, all: SiblingRecord[]): SiblingRecord[] {
  const root = brandRoot(self.brand);
  if (!root) return [];
  return all.filter((r) => r !== self && r.code !== self.code && brandRoot(r.brand) === root && ["trocar", "dilating-system"].includes(componentOf(textOf(r))));
}

/**
 * Gap-filling assertions the sibling family supports. Empty when the record states the feature
 * itself, when the family does not mark it, or when too few siblings do.
 */
export function siblingAssertions(self: SiblingRecord, siblings: SiblingRecord[], manufacturer?: string | null): { assert: BrandAssertion; via: string; codes: string[] }[] {
  const out: { assert: BrandAssertion; via: string; codes: string[] }[] = [];
  const selfText = textOf(self);
  for (const m of SIBLING_MARKERS) {
    if (m.re.test(selfText)) continue; // stated on its own words — read earlier, nothing to infer
    const marked = siblings.filter((s) => m.re.test(textOf(s)));
    if (marked.length < m.minSiblings) continue;
    const codes = marked.map((s) => s.code).filter((c): c is string => Boolean(c)).slice(0, 4);
    const who = manufacturer ?? "the labeler";
    out.push({
      assert: { [m.field]: m.absent } as BrandAssertion,
      via: `${who} marks ${m.marked} products in this line (${marked.length} sibling records${codes.length ? `, e.g. ${codes.join(", ")}` : ""}); this record carries no marker`,
      codes,
    });
  }
  return out;
}

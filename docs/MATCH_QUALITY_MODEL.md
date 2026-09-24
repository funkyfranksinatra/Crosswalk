# Match quality model

How Crosswalk decides that one of our SKUs is a substitute for a competitor product, how sure it is,
and what it tells the rep. This is the specification the matcher (`src/lib/match/*`) implements and
the evaluator (`scripts/eval-pacr.ts`) measures against. It was written for the REQ-7628 PACR
comparison (`docs/REQ-7628_PACR_vs_Crosswalk_comparison.md`) and generalises: the access-product
dimensions below are the first family modelled in depth; the score/confidence/classification
separation, the evidence provenance and the hard-vs-soft rule apply to every family.

## 1. Three separate outputs per candidate

| output | meaning | range | who consumes it |
|---|---|---|---|
| **match score** (`scoreBin`, `score`) | how similar the two products are on the evidence we have, after hard constraints | 0–1 | ranking within a grade |
| **confidence** (`confidence`) | how much evidence supports the classification — not the same as similarity | 0–1 | the rep ("verify" below 0.75), the export |
| **classification** (`matchType`) | Exact / Close / Alternative / No Match | enum | the offer, the acceptance gates |

A curated Exact cross with contradicting attributes is *Exact per the sheet, low confidence*, not
*Exact, high confidence*. An attribute-only match with every dimension known and equal is *Exact,
confidence 0.85*; the same match with the competitor's diameter unknown is *Close, confidence 0.6*
("size unconfirmed").

## 2. Evidence and provenance

Every attribute a candidate is judged on carries where it came from. Priority when sources disagree
(higher wins; lower sources fill gaps only):

1. `curated-spec` — sizes the sales team imported for the competitor code (Catalog → Competitor sizes)
2. `gudid:size` — structured `device_sizes` on the GUDID record
3. `gudid:description` — the GUDID brand / device description text
4. `intake:description` — the description column of the rep's intake sheet (the customer's item master)
5. `brand:<key>` — the brand → feature registry (`src/lib/match/brands.ts`): OPTIVIEW ⇒ optical, Kii Fios ⇒ optical, Visiport ⇒ optical, Stability/Universal Sleeve ⇒ cannula, …
6. `sku:<key>` — family SKU conventions (Ethicon Xcel `…ST/LT/XT` ⇒ 75/100/150 mm, Medtronic `…SHF/STF/LGF` ⇒ 70/100/150 mm with fixation cannula)

The registry is data (a table of rules with a provenance key and a note), not `includes("OPTIVIEW")`
calls scattered through the matcher. A rule contributes a feature only when the text does not
already state the opposite: a description that says "smooth cannula" is never overridden by a
SKU suffix that usually means "fixation".

## 3. Access-product dimensions (Trocar Products family)

| dimension | values | rule |
|---|---|---|
| component | trocar (complete: cannula + obturator), cannula (sleeve only), obturator (only), insufflation-needle, accessory (seal, reducer, cap), dilating-system (radially expanding access) | **hard** — a cannula is never a substitute for a trocar or vice versa; a dilating system is a trocar substitute |
| diameter | one or several port sizes in mm ("2/3 mm" is the set {2, 3}) | **hard** — no overlap ⇒ at most Alternative; both known and equal is required for Exact |
| compatible instrument range | "5–12 mm" | soft — the port is sized by its maximum; the range itself is compared when both sides state one |
| length | mm, with class short (≤ 80), standard (81–120), long (> 120) | different class ⇒ at most Close; unknown one side is not a mismatch |
| visualization | optical / non-optical | different ⇒ at most Close; same optical is strong positive evidence |
| tip | bladeless, bladed, blunt (Hasson), dilating | bladed vs bladeless ⇒ at most Close; dilating is a bladeless subtype |
| fixation style | fixation (threaded / ridged / z-thread), smooth, balloon, universal | soft — a note and a small penalty |
| low profile | yes / no | soft |
| single-use / reusable | | different ⇒ at most Close |
| pack / UOM | each vs box count | soft; reported, never a mismatch on its own |

Other families keep the generic bin similarity (family, product type, dimensions, features,
materials, text) and their existing construction caps (absorbable, barrier, material).

## 4. Hard constraints vs soft signals

A **hard constraint** caps the classification and multiplies the score regardless of everything else:

| constraint | cap | score × | note written |
|---|---|---|---|
| different family | Alternative | 0.5 | (existing) |
| incompatible component | **No Match** | 0.3 | "cannula only — the competitor line is a complete trocar" |
| diameter sets do not overlap | Alternative | 0.55 | "12 mm vs 5 mm" |
| fully-absorbable vs not (mesh) | Alternative | 0.85 | (existing) |

A **soft signal** adjusts the score and may lower the cap to Close:

| signal | cap | score × |
|---|---|---|
| optical vs non-optical | Close | 0.85 |
| bladed vs bladeless | Close | 0.85 |
| length class differs | Close | 0.85 |
| single-use vs reusable | Close | 0.9 |
| fixation style differs | — | 0.95 |
| low profile differs | — | 0.97 |
| same optical, same tip, same length class | — | small positive evidence (recorded, no multiplier) |

Hard constraints apply to curated crosses too. The sheet is evidence, not an override: a curated
Exact whose SKU is a cannula for a trocar line is reported as *curated cross, contradicted by
component* and ranked as the constraint says, with the sheet named in the explanation so the
discrepancy can be resolved by a reviewer. Curated rows are never modified.

## 5. Classification

| grade | required evidence |
|---|---|
| Exact | no hard violation, no soft cap; diameter known on both sides and equal; score ≥ 0.82 and dimension score ≥ 0.9 — **or** an approved curated Exact with no hard violation and no soft cap |
| Close | no hard violation; score ≥ 0.6; diameter equal or unknown on one side — or an approved curated Close / a capped curated Exact |
| Alternative | component compatible; score ≥ 0.38 — or a curated Alternative / Downsell, or a diameter-capped curated cross |
| No Match | everything else, including any component incompatibility |
| SELF_MATCH | the competitor code is our own active SKU: Exact, source `identity`, confidence 1. A discontinued own SKU with a successor proposes the successor (source `identity`, note); without one it falls through to attributes |

Exact is never easier than before: the size condition, the dimension threshold and the curated
requirement are unchanged; the caps only remove Exact where evidence contradicts it.

## 6. Confidence

`confidence = base(source) × (0.6 + 0.4 × evidenceCoverage) × (1 − contradictionPenalty)`

- base: identity 1.0; approved curated 0.9; attribute 0.8; rep-proposed (unreviewed) 0.6
- evidenceCoverage: share of the family's decisive dimensions known on *both* sides (access:
  component, diameter, length, visualization, tip); families without a profile use the size
  evidence (both sizes known 1.0; one side unknown 0.75; none 0.7)
- contradictionPenalty applies to curated grades only — it measures doubt about the sheet's
  grade: 0.25 per soft contradiction, 0.5 for a hard one, 0.125 for a different access technique
  (a curated Exact that violates a hard constraint ends well under the 0.75 "verify" line). On
  the attribute path a mismatch is already the reason for the grade, not doubt about it.
- a near tie inside the top grade (two platforms' same-spec SKUs) names the runner-up in the
  explanation instead of lowering confidence: the grade is not in doubt, only the platform choice

Confidence is stored on the candidate, shown to the rep, and never raised by a blanket offset.

## 7. Next-best

Alternatives are distinct SKUs that survive the hard constraints, ordered by grade then score;
each carries the differences that kept it from being first ("length 150 mm vs 100 mm", "smooth
cannula vs fixation"). A candidate that is only a different pack of the top pick is listed after
genuinely different products.

## 8. Explanations

The rationale is assembled from evidence lines, each with its provenance, mismatches first:
`curated cross (Access-PACR, Exact) · optical = optical (OPTIVIEW) · 12 mm = 12 mm (GUDID size)
· 100 mm = 100 mm (intake description) · fixation cannula = fixation`. When the top pick is not
Exact, the first line says why.

## 9. Pricing context

A request that names a known account is priced through the contract waterfall (List → National →
GPO tier → IDN → Local) for every candidate, not through the request's price book alone; the
candidate records the applied level and contract, and a missing price records the reason (no entry,
expired, wrong currency, outside every volume band). Prices are never inferred from other SKUs.

## 10. Acceptance gates (checked by `scripts/eval-pacr.ts report --before`)

1. every REQ-7628 PACR-win case improves or is explained (curated / ambiguous / source data)
2. own-SKU lines stay SELF_MATCH: 100%
3. diameter mismatches do not increase; component mismatches do not increase
4. curated-sheet top-1 / top-3 do not regress
5. Exact / Close counts do not rise without evidence (mean score by grade reported)
6. coverage does not collapse: proposals within 5% of baseline unless the removed ones were mismatches
7. intake: unaccounted rows = 0
8. pricing: with account 0001583870 every priceable proposal is priced with a source
9. the unit, DB and regression suites pass

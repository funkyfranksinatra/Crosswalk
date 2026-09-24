# REQ-7628 — Crosswalk vs PACR: superiority run

Account 0001583870 (Sanford Medical Center Fargo West), the 244-line competitor usage list PACR
reported on Sept 22, 2026. Starting commit `ea820a0`; every number below is measured by
`scripts/eval-pacr.ts` on the same list, the same local catalog (353 active SKUs, 3,652 curated
cross rows, 4,679-record GUDID library), the same contract fixture, in heuristic (no-model) mode.
Raw records: `docs/eval/baseline.json` (before) and `docs/eval/after.json` (after); rendered
metrics: `docs/eval/baseline.md`, `docs/eval/after.md`. Reproduce with the commands in §15.

## 1. Executive summary

Crosswalk now answers the Sanford list with **234 proposals (95.9%)** against PACR's 100 (41.0%),
with **zero diameter mismatches and zero component (device-type) mismatches** on its top picks
(PACR: 3 and 4), and it prices **159 of 234 proposals under the account's own contracts** — the same
TROCAR / ENDO - SANFORD HLTH and Vizient Tier-1 prices PACR reported — with the applied contract
named on every line and a reason on every unpriced one. On the 20 lines the earlier comparison
identified as PACR's advantages (OPTIVIEW / Kii Fios optical trocars, universal sleeves, the 2/3 mm
mini trocar, dilating tips), Crosswalk's top pick is now the evidence-based answer on **20/20**
(was 7/20); on 10 of those 20 PACR's own pick is not (it crosses a 12 mm sleeve to an 11 mm, a
sleeve to a complete trocar, dilating tips to bladed trocars, a 5 × 100 optical trocar to a
non-optical 150 mm).

The matcher gained a provenance-tagged attribute model for access products, a data-driven
brand → feature registry, hard constraints (a cannula is never a trocar; diameter sets must
overlap) and soft signals (optical, tip, length class, fixation, variant add-ons) that cap the
grade, a clean separation of match score / confidence / classification, and curated crosses
treated as evidence rather than an override. Coverage did not move (234 → 234), own-SKU lines
stayed 27/27 SELF_MATCH, no input row was lost, and the cross-family attribute-only check (stapling,
laparoscopic instruments) is level with the baseline while trocars improved 16 → 30 top-1 of 60.

Two things did not improve and are reported honestly: agreement with the curated sheet's *first*
answer fell from 81/85 to 71/85 (top-3 84 → 80), because 14 lines now rank an attribute-confirmed
product above a curated row that the attributes contradict — each is classified in §8 (11 curated
rows are stale or internally inconsistent, 3 are ambiguous); and 74 of 234 top picks carry a
confidence below 0.75 and are flagged "verify" — deliberately, since their evidence is incomplete.

## 2. Baseline (ea820a0, `docs/eval/baseline.md`)

| metric | PACR (export) | Crosswalk before |
|---|---|---|
| input rows / lines | 244 (+ TOTAL row) | 244 parsed, 0 skipped, 0 unaccounted |
| resolved in GUDID | — | 236/244 (96.7%), 102 via the local library, 8 not found |
| proposals | 100 (75 Exact, 25 Close) | 234 (116 Exact, 113 Close, 5 Alternative); 10 no-match |
| own-SKU lines retained as self | — | 27/27 |
| same top SKU as PACR | — | 29 of PACR's 100 (next-best 40, rank 4+ 10, different 21) |
| curated sheet top-1 / top-3 | 74 / — of 77 proposed on those lines | 81 / 84 of 85 |
| diameter mismatches (top pick, same measurement) | 3 / 71 checked | **55 / 179** |
| component mismatches | 4 / 74 | **27 / 190** |
| priced | 100/100 (80 TROCAR - SANFORD HLTH, 13 HOSPITAL LIST PRICE, 6 ENDO, 1 VIZIENT T1) | **30/234** (list price only; the run ignored the account's contracts) |
| PACR-win cases, evidence-based answer on top | 10/20 | 7/20 |

Before the baseline was taken, the three locally modified files in Alex's checkout (`.gitignore`,
`README.md`, `package.json`) were examined: they are exactly the tracked-file differences between
`main` and `mac-demo`, left by an interrupted `git checkout` on the mounted filesystem (reflog:
`main → mac-demo → mac-demo → main`), not user edits; `mac-demo` still carries that content on its
branch. Nothing was lost by resetting them.

## 3. PACR advantages identified (from `REQ-7628_PACR_vs_Crosswalk_comparison.md`, re-verified)

1. Optical trocars named by brand (OPTIVIEW, Kii Fios / Kii Optical, Optical Separator, Visiport):
   Crosswalk crossed 2B5XT to a *sleeve* (UNVCA5SHF), 2B12XT to the non-optical NONB12LGF, CTF73/74
   to Versaport 179096PF; PACR put optical ONB… trocars first on most of them.
2. Universal / stability sleeves (CB…, 2CB…, CTB…): Crosswalk crossed CB12LT / 2CB12LT to the
   Versaport 177091P sleeve and CTB12LT to the 150 mm cannula; PACR gave the VersaOne UNVCA…STF.
3. 23NBL "2 mm/3 mm": Crosswalk's attribute path read 15 mm (baseline in this environment already
   had the curated MS101003 on top, but only through the curated shortcut).
4. Dilating-tip trocars D5LT / D11LT / D12LT: both systems crossed to bladed or legacy SKUs.
5. Pricing: PACR priced 100 lines under the account's contracts; Crosswalk priced 30 at list.

## 4. Root causes

| cause | evidence |
|---|---|
| Size parser read every "N mm" as a diameter and a range "5–12 mm" as two diameters | 179076P "5-10mm Trocar" matched 5 mm and 12 mm lines alike; 176674PF "5 mm - 11 mm … Size: 12 mm" was 5/11 mm |
| Brand knowledge absent: OPTIVIEW, Kii Fios, Visiport carried no "optical"; sleeves carried no "cannula only" | GUDID descriptions for Ethicon codes are generic ("Bladeless Trocars with Stability Sleeves") |
| No component dimension: a 12 mm cannula scored like a 12 mm trocar | 27 component mismatches at baseline |
| Curated rows applied as a floor per row, so an Exact row for a *sleeve* outranked the reviewer's preferred trocar | 2B5XT → UNVCA5SHF (Access-Nikki-Mike marks ONB5LGF preferred) |
| Binning stage dropped the GUDID description whenever a curated description existed (filter bug) | `[cp.description, curated].filter(x => !cp.description.includes(x))` removes `cp.description` itself |
| Ethicon sizes live only in the SKU (B5**XT** = 150 mm) and in the customer's item master; neither was read | Ethicon records have no `device_sizes` |
| The request run priced from the request price book / catalog list only; the contract waterfall (`src/lib/contracts`) was used by proposals, not by runs | 30/234 priced |
| Score, confidence and grade were one number (`score`), so a curated Exact with contradicting attributes showed 0.95 | export "Confidence" column = composite score |

## 5. Matcher changes (all with tests; no Sanford-specific code)

- **`src/lib/match/access.ts`** — `AccessProfile`: component, diameter set, instrument range, length
  (mm + class), visualization, tip, fixation, low profile, variant add-ons, each field with the
  source that set it and a list of conflicts. `parseAccessSizes` handles the brief's matrix
  (5 mm / 5mm / 5 MM, 5/10 mm, 2 mm/3 mm, 2mm/3mm, 2/3 mm, 5–12 mm, 5-12mm, 12 × 100 mm, 12mm x 100mm,
  "12 mm diameter, 100 mm length", 100 mm x 11 mm, 5x95, "up to 11 mm", reducers, pack counts).
  Priority: curated size import → GUDID structured sizes → manufacturer SKU convention → GUDID /
  curated description text → intake description; a lower source fills gaps only, disagreements
  are recorded.
- **`src/lib/match/brands.ts`** — registry of brand rules (`match`, `unless`, `assert`,
  `provenance`, `note`) and SKU-convention rules guarded by manufacturer (Ethicon Xcel/BASX,
  Medtronic VersaOne/Versaport, Applied Kii): OPTIVIEW / Kii Fios / Optical Separator / Visiport ⇒
  optical; plain Xcel, BASX, bladed, blunt, dilating ⇒ non-optical; universal / stability / Kii
  sleeves ⇒ cannula; VersaStep / Step ⇒ radially expanding system; fascial closure, dual pack,
  non-sterile bulk, handle ⇒ variant add-ons.
- **`src/lib/match/component.ts`** — component classifier (trocar, cannula, obturator,
  insufflation needle, accessory, dilating system) and compatibility.
- **`src/lib/match/constraints.ts`** — `compareAccess`: hard (component, diameter overlap) and
  soft (visualization, tip, length class, fixation, low profile, variant, instrument range) findings
  → grade cap, multiplier, coverage, attribute-only cap (Exact needs ≥ 4 of 5 decisive fields; a
  different access technique is Exact only on a curated cross).
- **`src/lib/match/bin.ts`** — trocar bins carry the profile; dimensions come from it (a range is
  `min/max instrument`, not two diameters); `binSimilarity` applies the constraints, uses the
  decisive-attribute agreement as the similarity when nothing hard contradicts, and leads its notes
  with contradictions; `BIN_VERSION` 6 → 7; the stapler sense of "Endopath" no longer tags trocars.
- **`src/lib/match/score.ts`** — curated grade = sheet grade capped by the constraints (contradicted
  rows say so and rank as the evidence allows; No Match on a hard violation); reviewer's preferred
  cross first among curated rows; floor + attributes ordering inside a grade; **confidence**
  (`base × (0.6 + 0.4·coverage) × (1 − curated contradiction)`), identity = 1; order within a grade
  by identity → preferred → confidence (access model only) → source → score → priced SKU; near ties
  named in the explanation; the model grader is bound by the constraint cap.
- **`src/lib/match/line.ts`** — per-line assembly shared by the pipeline and the offline suites.
- **`src/lib/pipeline/run.ts`** — intake description folded into the cached competitor bin per line;
  SELF_MATCH formalised (active own SKU retained; discontinued with `successorSku` → successor as
  identity with a note; without one → attribute path with a line note); pricing through
  `loadPricingContext` when the request names a known account, `priceSource` per candidate
  ("LOCAL · TROCAR - SANFORD HLTH", "LIST · HOSPITAL LIST PRICE", or the waterfall's reasons);
  `confidence` persisted.
- **`src/lib/excel/intake.ts`, `src/lib/cfn.ts`** — description column captured; TOTAL / subtotal
  rows reported as ignored; placeholders and odd characters rejected with the reason; every row
  accounted for (`accounting`); typographic dashes, NBSP, BOM normalised.
- **Schema** (`20260924000000_match_quality`): `RequestLine.description`,
  `MatchCandidate.confidence`, `MatchCandidate.priceSource`, `OwnProduct.successorSku`.
- **UI / export** — line row shows "Verify match · N%" below 0.75, the curated sheet, the first
  contradiction and the price source; candidate cards list the evidence (✗ / ≠ / =) with the curated
  row's status and "why no price"; the workbook's Confidence column is confidence, the PriceBook
  column names the applied contract, plus "Pricing Source" and "Curated Sheet" columns.

## 6. Pricing comparison (account 0001583870, HOSPITAL LIST PRICE book, `seed-sanford-benchmark.ts`)

| | PACR | Crosswalk before | Crosswalk after |
|---|---|---|---|
| proposals priced | 100/100 | 30/234 | **159/234** (141 TROCAR - SANFORD HLTH, 9 ENDO - SANFORD HLTH, 8 list, 1 VIZIENT TROCAR T1) |
| lines where both picked the same SKU and PACR priced it | 42 | 29 | 42 — contract price identical on all 42 |
| unpriced with a reason | — | none given | 75, each with the waterfall's reasons ("LOCAL SANFORD-TROCAR: no entry for this SKU; …") |

The fixture holds exactly the 54 SKU prices the PACR export states (44 TROCAR, 2 ENDO, 1 Vizient,
7 list); no price was inferred for any other SKU. Crosswalk prices more lines than PACR because it
proposes more lines and because its top picks fall on contracted SKUs more often (the tie-break
between equal-spec platforms prefers the SKU this customer has a price for).

## 7. Evaluation results (`docs/eval/after.md` vs `baseline.md`)

| metric | before | after | PACR |
|---|---|---|---|
| lines parsed / unaccounted | 244 / 0 | 244 / 0 | 244 |
| resolved | 236 | 236 | — |
| proposals | 234 (116 E / 113 C / 5 A) | 234 (156 E / 74 C / 4 A) | 100 (75 E / 25 C) |
| by source | 126 attribute / 81 curated / 27 identity | 136 / 71 / 27 | — |
| own-SKU retained | 27/27 | 27/27 | (PACR substitutes 16 of them) |
| same top SKU as PACR | 29 | 42 | — |
| PACR's pick in Crosswalk's top-3 | 69 | 61 | — |
| diameter mismatches | 55/179 | **0/179** | 3/71 |
| component mismatches | 27/190 | **0/190** | 4/74 |
| curated top-1 / top-3 | 81 / 84 of 85 | 71 / 80 | 74 / — of 77 |
| top picks flagged verify (< 0.75) | n/a | 74 | — |
| mean confidence: Exact / Close / Alt | n/a | 0.83 / 0.70 / 0.48 | — |
| PACR-win cases on top (evidence-based) | 7/20 | **20/20** | 10/20 |
| alternatives distinct / keep the top pick's diameter | 233 / 171 of 233 | 233 / 226 | — |
| wall time (local Postgres, cached resolution) | 58.8 s (cold) | 3.5 s (warm) | — |

Exact rose 116 → 156. The Exact bar did not move: score ≥ 0.82, dimension agreement ≥ 0.9, size
known on both sides, and now additionally no hard or soft contradiction and ≥ 4 of 5 decisive
attributes known. What changed is the evidence available — sizes and features that were unknown
(Ethicon records without sizes; brand-encoded optical / sleeve facts) are now read from the SKU
convention, the registry and the intake description with provenance — and the generic feature /
text overlap no longer holds a fully agreeing pair under the threshold ("linear cutter" from the
word Endopath, "sleeve" from "with stability sleeves"). All 46 lines that became Exact carry a
complete agreeing evidence list in the export's Rationale column.

Crosswalk-only proposals (the 134 lines PACR reported "Not Found"): 74 Exact, 56 Close, 4 Alternative;
54 of them flagged verify; 8 are the customer's own Medtronic codes. None crosses a component or a
diameter; the 10 lines with no proposal are 8 codes absent from GUDID and two DeRoyal
pneumoperitoneum needles whose record files under a non-surgical panel (see §12).

## 8. Curated-sheet results

85 lines have an approved curated row. After: top-1 71, top-3 80, 14 top picks outside the sheet's
SKUs — versus PACR's 74 agreeing / 3 contradicting on 77. Each of the 14, classified:

| code | line | sheet says | Crosswalk top | class |
|---|---|---|---|---|
| C0124 | 12 × 100 non-threaded Optical Separator | B12STS (bladed, preferred), 176674PF | ONB12STS optical smooth 12 × 100 | stale / weak curated row (bladed non-optical for an optical trocar) |
| B12LTH | Xcel bladeless 12 × 100 handled | 176674PF Visiport (preferred), NB12STF… | NONB12STF | ambiguous: the sheet crosses "handled" Xcel to Visiport for its pistol grip; attributes favour the bladeless 12 × 100 |
| B5XT | Xcel bladeless 5 × 150 (XT) | NONB5STF (100 mm), sleeves, VS101505 | NB5LGF 5 × 150 | source-data defect: the sheet and the item master treat B5XT as 100 mm; XT is 150 (PACR agrees: NONB5LGF) |
| B11LTH | Xcel bladeless 11 × 100 handled | ONB11STF (optical, Exact) | NONB11STF | stale (optical row for a non-optical code); PACR gives Visiport |
| D11LT / D5LT / D12LT / D12XT / D5ST | dilating tip = bladeless | B…STF / B…STS bladed, 179094F / 179096P / 179097P Versaport V2 | NONB… / NB… bladeless | matcher-correct: bladed rows are demoted to Close; the Versaport V2 Exact rows are technique-agnostic and rank second |
| FP007 | Flexipath 7 mm flexible thoracic | Thoracoport 5.5 / 10.5 / 5 / 12 mm | OMS-T10BTS (7/8 mm) Close | multiple valid; no 7 mm Thoracoport exists |
| CTB10, CTB01 | Kii shielded bladed 5 mm | ONB5LGF (optical bladeless) | 24055- (Close, verify) | ambiguous: no bladed 5 × 150 in the catalog; the sheet's optical cross contradicts tip and visualization |
| B5LT | Xcel bladeless 5 × 100 | S101005 Step (Exact), ONB5STF, sleeves | NB5STF / NONB5STF | matcher-correct: like-for-like bladeless trocar before a radially expanding system; PACR agrees |
| CFR33 | Kii Optical 11 × 100 | VS101011P VersaStep (Close), S101010 | ONB11STF optical 11 × 100 | stale / weak curated row |

No curated row was modified. Contradicted rows keep their sheet, grade and reason in the candidate's
factors (`curated.contradicted`) and in the export's "Curated Sheet" column so a reviewer can settle
them.

## 9. PACR-win regression results

| code | PACR | evidence-based | before | after |
|---|---|---|---|---|
| 2B5ST | ONB5STF | ONB5SHF (5 × 75 → short) | S100705 | **ONB5SHF** Exact 0.90 |
| 2B5LT | ONB5STF | ONB5STF | ONB5STF | **ONB5STF** Exact 0.90 |
| 2B5XT | ONB5LGF | ONB5LGF | UNVCA5SHF (sleeve) | **ONB5LGF** Exact 0.90 |
| 2B12XT | ONB12LGF | ONB12LGF | NONB12LGF | **ONB12LGF** Exact 0.90 |
| CTF04 | NONB5LGF | ONB5STF | ONB5STF | **ONB5STF** Exact 0.90 |
| CTF73 / CTF74 | NB12STF | ONB12STF | 179096PF | **ONB12STF** Close 0.90 (sheet grade) |
| CTF71 | NB12LGF | ONB12LGF | ONB11LGF | **ONB12LGF** Close 0.90 |
| CB5ST | ONB5SHF | UNVCA5SHF | ONB5SHF (trocar for a sleeve) | **UNVCA5SHF** Close 0.76 |
| CB5LT / CB11LT / CB12LT / 2CB5LT / 2CB12LT / CTB11LT | UNVCA…STF | same | 4 of 6 | **6 of 6** Exact |
| CTB12LT | UNVCA11STF | UNVCA12STF | UNVCA12LGF | **UNVCA12STF** Close 0.76 |
| 23NBL | MS101003 | MS101003 | MS101003 | **MS101003** Exact 0.72 |
| D5LT / D11LT / D12LT | B5STF / B11STF / B12STS | NONB… bladeless | 179094F / B11STF / 179096P | **NONB5STF / NONB11STF / NB12STF** Exact 0.80 |

20/20 on top (7 before); `tests/unit/pacr-regression.test.ts` pins these offline.

## 10. Regressions

- Curated top-1 81 → 71 and top-3 84 → 80 on the Sanford list (§8: 11 stale/inconsistent rows,
  3 ambiguous, 0 matcher defects).
- PACR's pick in Crosswalk's top-3: 69 → 61 — the drop is the same set of lines where PACR's
  pick is a diameter / component / tip error or the sheet's weak row.
- Exact count up 116 → 156 (explained in §7; every Exact carries a complete evidence list).
- No coverage regression (234 → 234), no identity regression (27/27), no input loss (0 → 0).
- Embedding sweep: a `BIN_VERSION` bump re-bins the catalog, which bumps `updatedAt`, so the next
  `refreshEmbeddings` sweep scans every row once (text unchanged → re-stamped, not re-embedded);
  `tests/db/tier3.test.ts` sees this as pending work on the first run after a bump.

## 11. Generalization testing (`scripts/eval.ts --no-crosses`, curated sheets, attribute path only)

| sample | before top-1 / top-3 | after top-1 / top-3 |
|---|---|---|
| all families, n = 120, seed 7 | 32 / 53 | **42 / 68** |
| Surgical Stapling Products, n = 60, seed 11 | 9 / 25 | 9 / 25 |
| Laparoscopic Instruments (Hand), n = 60 | 30 / 34 | 30 / 34 |
| Trocar Products, n = 60 | 16 / 27 | **30 / 38** |
| Hernia Mesh | no Exact/Close curated rows resolve in this catalog sample | — |

The stapling sample briefly lost 2 lines during development (the "Endopath ⇒ linear cutter" tag
had been removed and confidence ordering was applied to families without a profile); both were
reverted for non-access families before the final run.

## 12. Remaining weaknesses

1. **Confidence volume**: 74/234 top picks are below 0.75, mostly Close matches with one decisive
   attribute unknown on the competitor side. The number is honest but the review queue is long;
   the fix is more evidence (competitor size imports, richer intake descriptions), not a threshold.
2. **Curated sheets contain contradictions** (Exact rows for sleeves on trocar lines, optical rows
   for non-optical codes, 100 mm rows for XT codes). The matcher now ranks around them and labels
   them; someone should retire or correct the 11 rows in §8 through the governance UI.
3. **Tie between platforms** (VersaOne NONB… vs Versaport Plus NB…): identical specs; the priced
   SKU wins, otherwise catalog order. A "current platform" flag on `OwnProduct` would settle it.
4. **Non-access families** keep the generic bin similarity; the profile / constraint model exists
   for trocars only. Stapler reloads (length × staple height × colour) are the obvious next family.
5. **Family veto by FDA panel** still drops a laparoscopic needle filed under a non-surgical panel
   when its GMDN term is not surgical (the two DeRoyal pneumoperitoneum needles).
6. **Model mode** was not measured (no key in this workspace); the grader is now bound by the
   constraint cap, and `GRADE_PROMPT_VERSION` is unchanged, so cached verdicts replay.
7. Eight codes are absent from GUDID (ML0500D, IAS12-120LP, MD11-100/150, WA58000T, MDS0522030,
   ONB11STF-NSB, CFT03); the intake description could seed a description-only line for them, but
   that would be a low-evidence guess and is left as a Not Found with the reason.

## 13. Files changed

`prisma/schema.prisma`, `prisma/migrations/20260924000000_match_quality/migration.sql`,
`src/lib/match/{access,brands,component,constraints,line}.ts` (new), `src/lib/match/{bin,score,grading}.ts`,
`src/lib/pipeline/run.ts`, `src/lib/llm/tasks.ts`, `src/lib/excel/{intake,export}.ts`, `src/lib/cfn.ts`,
`src/lib/gudid/{enrich,library}.ts`, `src/app/api/catalog/add/route.ts`, `src/app/api/requests/route.ts`,
`src/app/requests/[id]/view.tsx`, `src/components/ui.tsx`, `src/lib/eval/benchmark.ts`,
`scripts/{eval-pacr,seed-sanford-benchmark}.ts` (new), `scripts/{eval,run-sample}.ts`,
`docs/{MATCH_QUALITY_MODEL,FEATURES,OPERATIONS}.md`, `docs/eval/*`, `tests/fixtures/trocar-benchmark.json`.

## 14. Tests added

- `tests/unit/match-quality.test.ts` (72): size-parser matrix (32 cases), brand registry and SKU
  conventions, component classification and compatibility, profile provenance order and conflicts,
  hard vs soft constraints, scoring (attribute Exact evidence, curated hard/soft contradictions,
  preferred cross, SELF_MATCH + successor, unknown size never Exact, tie note, constraint cap for
  the grader), binner integration, intake accounting and code-family normalisation.
- `tests/unit/pacr-regression.test.ts` (31): the 20 PACR-win cases and adversarial cases (no
  cannula Exact/Close for a trocar line and vice-versa, 5 mm never a 12 mm Exact, needles never
  trocars, seals only accessories, no-size records never Exact, intake cannot override a SKU
  convention, SELF_MATCH first, Exact needs 4 decisive attributes, PACR's 7 → 5 mm and 5 → 12 mm
  crosses not reproduced, distinct explained alternatives), judged from an offline fixture the way
  the pipeline judges a line.
- Full suite: 299 tests (13 files) pass; `tsc` and `next build` clean.

## 15. Reproduce

```
# fixture + run (writes docs/eval/<label>.json)
npx tsx scripts/eval-pacr.ts run <SSXrefReport_REQ-7628.xlsx> --label after --rebin
# metrics, before/after
npx tsx scripts/eval-pacr.ts report docs/eval/after.json --before docs/eval/baseline.json --out docs/eval/after.md --json
# generalisation
npx tsx scripts/eval.ts --n 120 --seed 7 --no-crosses --no-llm
npx tsx scripts/eval.ts --n 60 --seed 11 --no-crosses --no-llm --family "Surgical Stapling Products"
# offline gates
npx vitest run tests/unit/match-quality.test.ts tests/unit/pacr-regression.test.ts
```

## 16. Recommendations

1. Retire or correct the 11 stale curated rows listed in §8 through the cross governance UI; the
   export's "Curated Sheet" column marks every contradicted row on every run.
2. Import competitor sizes for the Ethicon Xcel / BASX and Applied Kii families (Catalog →
   Competitor sizes); it lifts confidence above 0.75 on most of the 74 flagged lines without any
   matcher change.
3. Add a "current platform" flag to the catalog so equal-spec ties resolve to VersaOne by policy
   rather than by price availability.
4. Extend the profile / constraint model to stapler reloads (length, staple height, colour,
   articulation) — the same registry and constraint machinery applies.
5. Run the model-mode evaluation (`--llm`) once a key is configured; the grader is bound by the
   constraint cap, so it can refine but not overturn a hard finding.

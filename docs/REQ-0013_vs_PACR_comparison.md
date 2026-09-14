# REQ-0013 vs legacy PACR — comparison and debug findings

Run: `CRACR_XrefReport_REQ-0013_20260914_1218.csv` (model-assisted, sibling grading + verdict cache active). Reference: Medtronic PACR `SSXrefReport_REQ-7604` for the same MSK usage list (30 lines after duplicate merge).

## Scorecard

| | PACR | CRACR REQ-0013 |
| --- | --- | --- |
| Competitor codes identified | 13 / 30 | 29 / 30 (`3583SPDB1000` not in GUDID for either tool) |
| Lines with a Medtronic product proposed | 10 | 29 (6 of them are Medtronic's own SKUs already on the list → Exact / retain) |
| Rationale per line | none | every line, incl. clinical caveat |

## Line-by-line

| Competitor code | PACR | CRACR REQ-0013 | Verdict |
| --- | --- | --- | --- |
| 3583SPDB1000 | Not Found | Not Found | Agree |
| 3583BSTACK30 | Not Found | ABSTACK30X Exact (identity) | CRACR better — customer already buys it from us |
| 3583174006 / 174006 | Not Found | 174006 Exact (identity) | CRACR better |
| 35830PCO9X / 3583PCO2015X / 3583PCO2520X | Not Found | own SKU, Exact (identity) | CRACR better |
| 1DLMC03 (10×15 ePTFE DUALMESH) | PPDS1510 Close | PPDS1510 Alternative | Same product; CRACR more conservative (ePTFE→PP+barrier is a construction change) |
| 1DLMC05 (7.5×10 DUALMESH) | PPDS12 Close | PPDS1510 Alternative, NB PPDS12 | Defensible difference: model chose the oversize rectangle; PACR chose the 12 cm round. Both in top 3 |
| SPMII (Prolene, no size in GUDID) | PPM1510X3 Exact | PPM1106X3 Close, NB PPM1510X3 | Known limitation: Ethicon records carry no sizes → smallest Parietene wins the tie; PACR had Ethicon catalog sizes |
| SPMXXL | PPM4530 Close | PPM1106X3 Close, NB PPM4530 | Same limitation |
| UPA31015 (Ultrapro Advanced) | PPM1510X3 Close | PPM1106X3 Alternative, NB PPM1510X3 | Same limitation + partially-absorbable cap |
| 1410015010 (Gore-Tex patch 10×15) | PPM1510X3 Close | PPM1510X3 Alternative | Same product; tier differs on ePTFE vs polypropylene |
| 1315020020 (15×20×2 mm) | PPDS2015 Close | PPDS2015 Alternative | Same product |
| 1405010010 / 1305010020 (5×10) | PPM1106X3 Close | PPM1106X3 Alternative | Same product |
| 112660 Bard Mesh 26×36 | Not Found | PPM4530 Close | CRACR better |
| 113700 Bard Mesh pre-shaped | Not Found | PPM1510X3 Close | CRACR better |
| 112650 Bard Mesh 5×10 | Not Found | PPM1106X3 Close | CRACR better |
| 112680 Bard Mesh 7.6×15 | Not Found | PPM1510X3 Close | CRACR better |
| 1190500 Phasix 25.4×30.5 | Not Found | PPM4530 Alternative | CRACR better |
| 1190400 Phasix 20.3×25.4 | Not Found | PCO2520X Alternative | CRACR better (see platform note) |
| 1190300 Phasix 15.2×20.3 | Not Found | PPDS2015 Alternative | CRACR better |
| 1190816 Phasix 8×16 | Not Found | PPM1510X3 Alternative | CRACR better |
| 1190820 Phasix 8×20 | Not Found | PPDS2015 Alternative | CRACR better — was No Match in REQ-0012, fixed by sibling floor |
| 1202025 / 1201520 / 1200710 Phasix ST | Not Found | PCO2520X / PPDS2015 / PPDS1510 Alternative | CRACR better |
| 112770 / 112760 PerFix plug | Not Found | PPM1106X3 Alternative (flat-mesh alternative, plug caveat) | CRACR better |

Agreement on the 10 lines PACR could match: 8 same product (2 differ on Ethicon size-less codes, 1 on 1DLMC05). Tier is one step more conservative on 7 of them because CRACR caps ePTFE→polypropylene at Alternative. Nothing in REQ-0013 is wrong in a way PACR got right; CRACR remains more complete and more accurate on this list.

## Defects found in REQ-0013 and fixed

1. **Sibling groups were too coarse.** `siblingKey` used the first word of the brand, so `GORE DUALMESH` and `GORE-TEX Soft Tissue Patch` were graded as one "same construction" group, and plain Phasix (flat) with Phasix ST (barrier). The model pushed back in its caveats ("This is GORE-TEX Soft Tissue Patch, not DUALMESH") — proof the consistency rule was wrong for that group. Fix: groups now key on manufacturer + full normalised brand + family + construction signature (materials + barrier / absorbability / plug / self-gripping tags). The MSK list now forms 9 groups instead of 6.
2. **"Soft tissue" tagged as macroporous.** The feature regex matched `soft` in "Soft Tissue Patch", so microporous ePTFE patches carried a `macroporous` tag (the model's caveat "do not rely on the supplied 'macroporous' tag" was reacting to this). Fix: `soft` only counts when not followed by "tissue".
3. **Duplicate dimensions sent to the model.** Dual-unit labels (`10" x 14" (26 cm x 36 cm)`) and GUDID `height 1 mm` next to regex `thickness 1 mm` produced 4–6 dimensions per mesh. Fix: `normaliseDimensions` collapses cross-unit duplicates (12% tolerance for rounded inch labels) and maps sheet `height` to `thickness` (plug heights > 10 mm stay `height`).
4. **Identity lines missing width.** `3583PCO2015X`'s rationale said "the source record omits width" because the competitor-side bin was built from the GUDID record only. Fix: when a competitor code is our own SKU, the competitor bin also gets the size the catalog-number convention encodes (`sizeFromSku`).
5. **Float noise in CSV.** `112760` exported `381.65999999999997`. Fix: all extended prices and totals are rounded to cents in both exports.
6. **Model bins never refreshed after heuristic fixes.** Model bins were pinned at `v = 9999`, so fixes 2–3 would never have reached REQ-0013's cached bins. Fix: model bins record the heuristic version they corrected (`hv`); `BIN_VERSION` is now 5, so the next run re-bins competitor and candidate products once (≈40 model calls on this list), then caches again.
7. **bestSku guidance.** The grading prompt now tells the model how to pick the quoted SKU within a tier: fewest construction differences first, then closest size, same platform across siblings where sizes allow. This targets the Phasix split (PPM for some sizes, PCO/PPDS for others) and the 1DLMC05 round-vs-rectangle call. `GRADE_PROMPT_VERSION` → 3, so cached verdicts are refreshed on the next run.

Verification: `tsc` clean, `next build` clean, curated eval unchanged at 100% resolution / 23% top-1 / 39% top-3 on the fixed seed (no regression), headless heuristic run on the MSK list produced the expected bins and 9 sibling groups.

## Still open (data, not code)

* Ethicon Prolene / Ultrapro codes have no dimensions in GUDID. Until a competitor size table is imported (or the model supplies sizes from product knowledge — the prompt allows it, the model is declining), these lines tie to the smallest Parietene. A 3-row "competitor sizes" sheet would resolve SPMII, SPMXXL and UPA31015 to PACR's choices.
* "Item Product Category" shows `Synthetic Mesh` for legacy-report SKUs and `Hernia Mesh` for the Parietex SKUs seeded from GUDID; cosmetic, comes from the catalog's category column.

## To pick up the fixes

The six changed files are already in your CRACR folder. Restart `npm run dev`, open REQ-0013 and click **Re-run** (the version bumps will re-bin and re-grade automatically; **Re-grade fresh** is not required).

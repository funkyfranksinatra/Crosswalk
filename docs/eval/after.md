# Evaluation: after @ ea820a0 — REQ-0380, 3.5 s, heuristic mode (vs baseline @ ea820a0)

## Input
- PACR data rows: 244; parsed lines: 244 (was 244, +0); skipped: 0; merged duplicates: 0; unaccounted: **0**

## Identification
- resolved 236/244 (96.7%) (was 236, +0); not found 8; errors 0; via local GUDID library 102; low-confidence resolutions 0
- by source: openfda 236, not-found 8

## Matching
- Crosswalk proposals: 234/244 (95.9%) (was 234, +0) — Exact Match 156, Close Match 74, Alternative Match 4
- PACR proposals: 100/244 (41.0%) — Exact Match 75, Close Match 25
- by source: attribute 136, known-cross 71, identity 27; no-match 10; not found 8
- own-SKU (identity) lines: 27, preserved as SELF 27 (was 27, +0)
- mean score by grade: Exact Match 0.973, Close Match 0.843, Alternative Match 0.575

## Confidence (separate from score and grade)
- top picks flagged "verify" (confidence < 0.75): 74/234; bands: 0.75–0.9 98, ≥0.9 62, 0.6–0.75 60, <0.6 14; mean by grade: Exact Match 0.83, Close Match 0.698, Alternative Match 0.48

## Agreement with PACR (top pick)
- same SKU 42 (was 29, +13) (same grade 38); PACR pick is Crosswalk's next-best (rank 2–3) 19 (was 40, -21); rank 4+ 6; different / not proposed 33 (was 21, +12)
- Crosswalk-only proposals 134 (was 134, +0) (by score: ≥0.9 72, 0.8–0.9 35, 0.7–0.8 17, <0.7 10); PACR-only 0 (was 0, +0); neither 10
- grade calibration on the same SKU: PACR Exact Match / CW Close Match 4

## Curated cross-reference sheet
- lines with a curated cross: 85; Crosswalk top-1 71/85 (83.5%) (was 81, -10); top-3 80/85 (94.1%) (was 84, -4); top pick contradicts the sheet 14 (was 4, +10)
- Exact/Close curated lines: 85, top-1 71/85 (83.5%)
- PACR on the same lines: proposed 77, agrees 74, contradicts 3

## Mismatches (same measurement for both systems; identity lines excluded)
- diameter: Crosswalk 0/179 checked (was 55, -55); PACR 3/71
- component / device type: Crosswalk 0/190 checked (was 27, -27); PACR 4/74
- PACR diameter mismatches: FP007 (7 mm) → 179308 (5 mm); CTB12LT (12 mm) → UNVCA11STF (11 mm); C0Q20 (5 mm) → 176626P (12 mm)
- PACR component mismatches: CFS01 [cannula] → ONB5LGF [trocar]; CB5ST [cannula] → ONB5SHF [trocar]; CTF03 [trocar] → 177092 [cannula]; CFS03 [cannula] → ONB5SHF [trocar]

## Pricing (account 0001583870)
- proposals priced by the run: 159/234 (67.9%) (was 30, +129); priceable under the account's contracts: 159/234 (67.9%) — LOCAL:TROCAR - SANFORD HLTH 141, LOCAL:ENDO - SANFORD HLTH 9, LIST:list 8, GPO:VIZIENT TROCAR T1 1
- PACR priced 100/100 (100.0%) — TROCAR - SANFORD HLTH 80, HOSPITAL LIST PRICE 13, ENDO - SANFORD HLTH 6, VIZIENT TROCAR T1 1
- same SKU as PACR and PACR priced it: 42; contract price identical: 42

## Next-best
- lines with alternatives: 233; all distinct SKUs 233; alternatives keep the top pick's diameter 226

## PACR-win cases (REQ-7628)
| code | PACR's pick | evidence-based answer | Crosswalk top | expected rank | PACR pick rank | note |
|---|---|---|---|---|---|---|
| 2B5ST | ONB5STF | ONB5SHF | ONB5SHF (Exact Match, conf 0.90, known-cross) | 1 | — | OPTIVIEW optical 5 mm × 75 mm → the 70 mm short optical trocar (PACR gives the 100 mm) |
| 2B5LT | ONB5STF | ONB5STF | ONB5STF (Exact Match, conf 0.90, known-cross) | 1 | 1 | OPTIVIEW optical 5 × 100 |
| 2B5XT | ONB5LGF | ONB5LGF | ONB5LGF (Exact Match, conf 0.90, known-cross) | 1 | 1 | OPTIVIEW optical 5 × 150 (XT), despite the item master's '100 mm' |
| 2B12XT | ONB12LGF | ONB12LGF | ONB12LGF (Exact Match, conf 0.90, known-cross) | 1 | 1 | OPTIVIEW optical 12 × 150 |
| CTF04 | NONB5LGF | ONB5STF | ONB5STF (Exact Match, conf 0.90, known-cross) | 1 | — | Kii Fios optical 5 × 100 (PACR: non-optical, 150 mm) |
| CTF73 | NB12STF | ONB12STF | ONB12STF (Close Match, conf 0.90, known-cross) | 1 | 2 | Kii Fios optical 12 × 100 (PACR: non-optical bladeless) |
| CTF74 | NB12STF | ONB12STF | ONB12STF (Close Match, conf 0.90, known-cross) | 1 | 2 | Kii Fios optical 12 × 100 |
| CTF71 | NB12LGF | ONB12LGF | ONB12LGF (Close Match, conf 0.90, known-cross) | 1 | 4 | Kii Fios optical 12 × 150 |
| CB5ST | ONB5SHF | UNVCA5SHF | UNVCA5SHF (Close Match, conf 0.76, known-cross) | 1 | — | universal sleeve 5 × 75 → cannula only (PACR gives a complete trocar) |
| CB5LT | UNVCA5STF | UNVCA5STF | UNVCA5STF (Exact Match, conf 0.76, known-cross) | 1 | 1 | universal sleeve 5 × 100 |
| CB11LT | UNVCA11STF | UNVCA11STF | UNVCA11STF (Exact Match, conf 0.76, known-cross) | 1 | 1 | universal sleeve 11 × 100 |
| CB12LT | UNVCA12STF | UNVCA12STF | UNVCA12STF (Exact Match, conf 0.76, known-cross) | 1 | 1 | universal sleeve 12 × 100 |
| 2CB5LT | UNVCA5STF | UNVCA5STF | UNVCA5STF (Exact Match, conf 0.79, known-cross) | 1 | 1 | OPTIVIEW universal sleeve 5 × 100 |
| 2CB12LT | UNVCA12STF | UNVCA12STF | UNVCA12STF (Exact Match, conf 0.79, known-cross) | 1 | 1 | OPTIVIEW universal sleeve 12 × 100 |
| CTB11LT | UNVCA11STF | UNVCA11STF | UNVCA11STF (Exact Match, conf 0.76, known-cross) | 1 | 1 | BASX universal sleeve 11 × 100 |
| CTB12LT | UNVCA11STF | UNVCA12STF | UNVCA12STF (Close Match, conf 0.76, known-cross) | 1 | — | BASX universal sleeve 12 × 100 (PACR gives the 11 mm) |
| 23NBL | MS101003 | MS101003 | MS101003 (Exact Match, conf 0.72, known-cross) | 1 | 1 | 2 mm/3 mm mini trocar → the 2/3 mm Mini Step |
| D5LT | B5STF | NONB5STF / NB5STF | NONB5STF (Exact Match, conf 0.80, attribute) | 1 | 4 | dilating tip = bladeless 5 × 100 (PACR: bladed) |
| D11LT | B11STF | NONB11STF / NB11STF | NONB11STF (Exact Match, conf 0.80, attribute) | 1 | 3 | dilating tip = bladeless 11 × 100 (PACR: bladed) |
| D12LT | B12STS | NONB12STF / NB12STF / NONB12STS / NB12STS | NB12STF (Exact Match, conf 0.80, attribute) | 1 | — | dilating tip = bladeless 12 × 100 (PACR: bladed) |

- Crosswalk top pick is the evidence-based answer: 20/20 (was 7); in top-3: 20; same SKU as PACR: 10; PACR's own pick is the evidence-based answer in 10

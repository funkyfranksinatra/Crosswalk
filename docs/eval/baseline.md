# Evaluation: baseline @ ea820a0 — REQ-0367, 58.8 s, heuristic mode

## Input
- PACR data rows: 244; parsed lines: 244; skipped: 0; merged duplicates: 0; unaccounted: **0**

## Identification
- resolved 236/244 (96.7%); not found 8; errors 0; via local GUDID library 102; low-confidence resolutions 0
- by source: openfda 236, not-found 8

## Matching
- Crosswalk proposals: 234/244 (95.9%) — Exact Match 116, Close Match 113, Alternative Match 5
- PACR proposals: 100/244 (41.0%) — Exact Match 75, Close Match 25
- by source: attribute 126, known-cross 81, identity 27; no-match 10; not found 8
- own-SKU (identity) lines: 27, preserved as SELF 27
- mean score by grade: Exact Match 0.95, Close Match 0.769, Alternative Match 0.488

## Confidence (separate from score and grade)
- top picks flagged "verify" (confidence < 0.75): 0/234; bands: n/a 234; mean by grade: not recorded at this commit

## Agreement with PACR (top pick)
- same SKU 29 (same grade 25); PACR pick is Crosswalk's next-best (rank 2–3) 40; rank 4+ 10; different / not proposed 21
- Crosswalk-only proposals 134 (by score: 0.7–0.8 48, 0.8–0.9 44, <0.7 24, ≥0.9 18); PACR-only 0; neither 10
- grade calibration on the same SKU: PACR Exact Match / CW Close Match 4

## Curated cross-reference sheet
- lines with a curated cross: 85; Crosswalk top-1 81/85 (95.3%); top-3 84/85 (98.8%); top pick contradicts the sheet 4
- Exact/Close curated lines: 85, top-1 81/85 (95.3%)
- PACR on the same lines: proposed 77, agrees 74, contradicts 3

## Mismatches (same measurement for both systems; identity lines excluded)
- diameter: Crosswalk 55/176 checked; PACR 3/71
- component / device type: Crosswalk 27/183 checked; PACR 4/74
- Crosswalk diameter mismatches: B12XT (12 mm) → ONB11LGF (11 mm); MD10-100 (10 mm) → OMS-T10BT (7/8 mm); CFF01 (5 mm) → 179077P (10 mm); C0Q19 (8 mm) → ONB5STF (5 mm); CFB01 (5 mm) → B12LGS (12 mm); TB5LT (5 mm) → 176626P (12 mm); FP007 (7 mm) → 179308 (5 mm); MDO15-150 (15 mm) → ONB12LGF (12 mm); MDK10-100 (10 mm) → B11STF (11 mm); CFF10 (5 mm) → 179077P (10 mm); CFF34 (11 mm) → 179076P (10 mm); 40811R (8 mm) → UNVCA5STF (5 mm); CFF71 (12 mm) → 179077P (10 mm); CFF73 (12 mm) → 179076P (10 mm); CFB33 (11 mm) → B5STS (5 mm); CFF33 (11 mm) → 179076P (10 mm); CTF35 (11 mm) → 179076P (10 mm); C0R83 (12 mm) → OMS-T12BTNL (7/8 mm); CTB75 (12 mm) → B5STS (5 mm); MD5-150 (5 mm) → 176626P (12 mm); CFB73 (12 mm) → B5STS (5 mm); H12LP (12 mm) → OMS-T10BT (7/8 mm); CTF71 (12 mm) → ONB11LGF (11 mm); CFF12 (5 mm) → 179076P (10 mm); CFF74 (12 mm) → 179076P (10 mm); CFF04 (5 mm) → 179076P (10 mm); CTB35 (11 mm) → B5STS (5 mm); CTF33 (11 mm) → 179076P (10 mm); CFR73 (12 mm) → ONB5STF (5 mm); MDO10-100 (10 mm) → ONB12STF (12 mm); YA03VSS01 (3 mm) → 171313 (2 mm); MDO15-100 (15 mm) → ONB12STF (12 mm); 52203-10/11 (11/10 mm) → UNVCA5STB (5 mm); MDO10-150 (10 mm) → ONB11LGF (11 mm); MD15-100 (15 mm) → NONB5STF (5 mm); MD5-100 (5 mm) → 176626P (12 mm); CFS21 (12 mm) → 179077P (10 mm); CFS22 (12 mm) → 179076P (10 mm); CFR74 (12 mm) → ONB5STF (5 mm); CFR39 (15 mm) → ONB5LGF (5 mm); CTF75 (12 mm) → 179076P (10 mm); B11LP (11 mm) → S101010 (10 mm); MD10-150 (10 mm) → OMS-T10BT (7/8 mm); CTF34 (11 mm) → 179076P (10 mm); TB11LT (11 mm) → 176626P (12 mm); CFS12 (11 mm) → 179076P (10 mm); CFR33 (11 mm) → S101010 (10 mm); CTF12 (5 mm) → 179076P (10 mm); C0Q20 (5 mm) → BPT12STS (12 mm); CFR71 (12 mm) → ONB5LGF (5 mm); C0Q61 (8 mm) → B5STS (5 mm); CTS21 (12 mm) → 179077P (10 mm); CFF03 (5 mm) → 179076P (10 mm); CFS02 (5 mm) → 179076P (10 mm); TB5ST (5 mm) → 176626P (12 mm)
- Crosswalk component mismatches: YA05VSS01 [accessory] → 24055- [trocar]; B5XT [trocar] → UNVCA5LGF [cannula]; EA10HS05 [accessory] → 179076P [trocar]; 900-844 [cannula] → 24055- [trocar]; 900-800 [cannula] → 24055- [trocar]; 40811R [trocar] → UNVCA5STF [cannula]; 900-846 [cannula] → 24055- [trocar]; CTB5LT [cannula] → VS101000 [dilating-system]; CFF75 [trocar] → 175772P [accessory]; 900-820 [cannula] → 24055- [trocar]; YC0509512 [trocar] → UNVCA5STB [cannula]; 2B5XT [trocar] → UNVCA5SHF [cannula]; 52203-10/11 [trocar] → UNVCA5STB [cannula]; CFS21 [cannula] → 179077P [trocar]; CFS22 [cannula] → 179076P [trocar]; CTB5ST [cannula] → VS101000 [dilating-system]; CB5ST [cannula] → ONB5SHF [trocar]; YA05VSS02 [accessory] → 24055- [trocar]; CD650 [accessory] → 24055- [trocar]; 900-802 [cannula] → 24055- [trocar]; CFS12 [cannula] → 179076P [trocar]; 35LNS [trocar] → UNVCA5STB [cannula]; C35-SEAL-1 [accessory] → 24055- [trocar]; CFS03 [cannula] → ONB5SHF [trocar]; 355NS [trocar] → UNVCA5STB [cannula]; CTS21 [cannula] → 179077P [trocar]; CFS02 [cannula] → 179076P [trocar]
- PACR diameter mismatches: FP007 (7 mm) → 179308 (5 mm); CTB12LT (12 mm) → UNVCA11STF (11 mm); C0Q20 (5 mm) → 176626P (12 mm)
- PACR component mismatches: CFS01 [cannula] → ONB5LGF [trocar]; CB5ST [cannula] → ONB5SHF [trocar]; CTF03 [trocar] → 177092 [cannula]; CFS03 [cannula] → ONB5SHF [trocar]

## Pricing (account 0001583870)
- proposals priced by the run: 30/234 (12.8%); priceable under the account's contracts: 115/234 (49.1%) — LOCAL:TROCAR - SANFORD HLTH 92, GPO:VIZIENT TROCAR T1 10, LOCAL:ENDO - SANFORD HLTH 7, LIST:list 6
- PACR priced 100/100 (100.0%) — TROCAR - SANFORD HLTH 80, HOSPITAL LIST PRICE 13, ENDO - SANFORD HLTH 6, VIZIENT TROCAR T1 1
- same SKU as PACR and PACR priced it: 29; contract price identical: 29

## Next-best
- lines with alternatives: 233; all distinct SKUs 233; alternatives keep the top pick's diameter 122

## PACR-win cases (REQ-7628)
| code | PACR's pick | evidence-based answer | Crosswalk top | expected rank | PACR pick rank | note |
|---|---|---|---|---|---|---|
| 2B5ST | ONB5STF | ONB5SHF | S100705 (Exact Match, conf 0.95, known-cross) | 2 | — | OPTIVIEW optical 5 mm × 75 mm → the 70 mm short optical trocar (PACR gives the 100 mm) |
| 2B5LT | ONB5STF | ONB5STF | ONB5STF (Exact Match, conf 0.97, known-cross) | 1 | 1 | OPTIVIEW optical 5 × 100 |
| 2B5XT | ONB5LGF | ONB5LGF | UNVCA5SHF (Exact Match, conf 0.95, known-cross) | 2 | 2 | OPTIVIEW optical 5 × 150 (XT), despite the item master's '100 mm' |
| 2B12XT | ONB12LGF | ONB12LGF | NONB12LGF (Exact Match, conf 0.95, known-cross) | 2 | 2 | OPTIVIEW optical 12 × 150 |
| CTF04 | NONB5LGF | ONB5STF | ONB5STF (Exact Match, conf 0.97, known-cross) | 1 | 2 | Kii Fios optical 5 × 100 (PACR: non-optical, 150 mm) |
| CTF73 | NB12STF | ONB12STF | 179096PF (Exact Match, conf 0.83, attribute) | 2 | 3 | Kii Fios optical 12 × 100 (PACR: non-optical bladeless) |
| CTF74 | NB12STF | ONB12STF | 179096PF (Exact Match, conf 0.83, attribute) | 2 | 3 | Kii Fios optical 12 × 100 |
| CTF71 | NB12LGF | ONB12LGF | ONB11LGF (Exact Match, conf 0.83, attribute) | 2 | 3 | Kii Fios optical 12 × 150 |
| CB5ST | ONB5SHF | UNVCA5SHF | ONB5SHF (Close Match, conf 0.80, known-cross) | 2 | 1 | universal sleeve 5 × 75 → cannula only (PACR gives a complete trocar) |
| CB5LT | UNVCA5STF | UNVCA5STF | UNVCA5STF (Exact Match, conf 0.95, known-cross) | 1 | 1 | universal sleeve 5 × 100 |
| CB11LT | UNVCA11STF | UNVCA11STF | UNVCA11STF (Exact Match, conf 0.95, known-cross) | 1 | 1 | universal sleeve 11 × 100 |
| CB12LT | UNVCA12STF | UNVCA12STF | 177091P (Exact Match, conf 0.95, known-cross) | 3 | 3 | universal sleeve 12 × 100 |
| 2CB5LT | UNVCA5STF | UNVCA5STF | UNVCA5STF (Exact Match, conf 0.95, known-cross) | 1 | 1 | OPTIVIEW universal sleeve 5 × 100 |
| 2CB12LT | UNVCA12STF | UNVCA12STF | 177091P (Exact Match, conf 0.95, known-cross) | 3 | 3 | OPTIVIEW universal sleeve 12 × 100 |
| CTB11LT | UNVCA11STF | UNVCA11STF | UNVCA11STF (Exact Match, conf 0.95, known-cross) | 1 | 1 | BASX universal sleeve 11 × 100 |
| CTB12LT | UNVCA11STF | UNVCA12STF | UNVCA12LGF (Exact Match, conf 0.95, known-cross) | 4 | 3 | BASX universal sleeve 12 × 100 (PACR gives the 11 mm) |
| 23NBL | MS101003 | MS101003 | MS101003 (Exact Match, conf 0.95, known-cross) | 1 | 1 | 2 mm/3 mm mini trocar → the 2/3 mm Mini Step |
| D5LT | B5STF | NONB5STF / NB5STF | 179094F (Exact Match, conf 0.95, known-cross) | — | 2 | dilating tip = bladeless 5 × 100 (PACR: bladed) |
| D11LT | B11STF | NONB11STF / NB11STF | B11STF (Exact Match, conf 0.95, known-cross) | — | 1 | dilating tip = bladeless 11 × 100 (PACR: bladed) |
| D12LT | B12STS | NONB12STF / NB12STF / NONB12STS / NB12STS | 179096P (Exact Match, conf 0.95, known-cross) | — | 3 | dilating tip = bladeless 12 × 100 (PACR: bladed) |

- Crosswalk top pick is the evidence-based answer: 7/20; in top-3: 16; same SKU as PACR: 8; PACR's own pick is the evidence-based answer in 10

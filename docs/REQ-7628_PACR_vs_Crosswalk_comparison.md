# PACR vs Crosswalk — Sanford Medical Center trocar list (Sept 23, 2026)

Inputs: the legacy PACR export `SSXrefReport_REQ-7628_SEP-22-2026_TIME-14-47.xlsx` (account
0001583870 Sanford Medical Center, 245 lines, run Sept 22) and the Crosswalk workbook
`Crosswalk_XrefReport_REQ-0002_20260923_1654.xlsx` produced from that same file as intake (run
Sept 23, heuristic mode, List price, no account selected). Both were compared line by line on the
competitor code; Crosswalk's *All Candidates* sheet was used to see where PACR's pick sits in its
ranking. No ground truth exists for this list, so "accuracy" below means: internal consistency
(diameter, product type), agreement with Medtronic's own curated cross-reference sheet, and how
each tool handled the codes the other could not.

## Headline numbers

| | PACR | Crosswalk |
| --- | --- | --- |
| Lines | 245 | 241 (3 dropped at intake — fixed, see §5) |
| Competitor code identified | 101 (41%) | 233 of 241 resolved in GUDID (97%) |
| Lines with a Medtronic match | **100** (75 Exact, 25 Close) | **219** (77 Exact, 83 Close, 59 Alternative) |
| "Not found" / no match | 144 Not Found (59%) | 8 not in GUDID + 14 resolved with no candidate (9%) |
| Medtronic's own codes on the list | 23, all mapped to a *different* Medtronic SKU | 27, all kept as identity (customer already buys them) |
| Next-best alternatives | none | 2 per line + full candidate list with rationale |
| Priced lines | 101 (Sanford trocar / endo pricebooks + Vizient tier) | 18 (List price only — see §4) |

Crosswalk proposes on 2.2× as many lines. 119 of those are lines PACR could not identify at all:
23 Exact, 42 Close, 54 Alternative; 105 came from the attribute matcher (not a curated cross), 64 of
them at confidence ≥ 0.80 and 34 below 0.70 — the low-confidence ones are correctly labelled
*Alternative* and belong in a rep review before they go in a quote.

## 1. Where both tools proposed something (100 lines)

| Relationship | Lines |
| --- | --- |
| Same top pick | 34 |
| PACR's pick is Crosswalk's next-best (rank 2–3) | 22 |
| PACR's pick is in Crosswalk's candidate list (rank 4+) | 14 |
| Different, PACR's pick not among Crosswalk's candidates | 30 — 12 are Medtronic's own codes (identity vs substitute), 11 are lines where Crosswalk followed the curated sheet and PACR contradicts it, 7 attribute-matcher disagreements |

So on 70 of 100 lines Crosswalk either agrees with PACR or lists PACR's answer as an alternative.

**Tier calibration.** On the 34 identical picks PACR says *Exact* nine times where Crosswalk says
*Close*, never the reverse. Crosswalk is the more conservative grader; PACR's "Exact" means "our
substitute", not "same product" (e.g. a 12 mm bladeless trocar → a 5–11 mm optical trocar is
"Exact" in PACR).

**Against Medtronic's curated cross-reference sheet.** 57 of Crosswalk's picks are curated crosses.
PACR agrees with the sheet on 32 (56%), has the sheet's answer as Crosswalk's next-best on 10, and
contradicts it outright on 15. Where the two disagree, the sheet is the company's own position.

**Diameter consistency** (competitor description mm vs proposed SKU description mm, 60 comparable
lines): PACR 4 mismatches, Crosswalk 5 — statistically the same. Both inherit `FP007 → 179308`
(7 mm vs 5 mm) from the curated sheet.

## 2. Where PACR is better

These are real findings against Crosswalk's heuristics, all on Ethicon / Applied Medical families:

- **Optical trocars named by brand, not by the word "optical".** Ethicon *OPTIVIEW* and Applied
  *Kii Optical / Fios first-entry* codes (2B5ST, 2B5LT, 2B5XT, 2B12XT, CTF04, CTF73/74, CTF71):
  PACR maps them to VersaOne *optical* (ONB…) SKUs; Crosswalk's attribute matcher reads
  "Bladeless" in the GUDID text and prefers bladeless (NB/NONB…) SKUs, or ranks the optical SKU
  as Alternative. (On 2B5ST the curated sheet itself says NONB5SHF, so that one is the sheet's call.)
- **Universal sleeves / cannula-only products** (CB5ST, CB5LT, CB11LT, CB12LT, 2CB5LT, 2CB12LT,
  CTB11LT, CTB12LT): PACR picks the VersaOne *Universal Fixation Cannula* (UNVCA…), the right
  product type; Crosswalk picks Step / VersaStep sleeves at 0.66–0.72 confidence — same family,
  wrong sub-type, and it says so with the low confidence.
- **Mini/micro trocars**: 23NBL ("2 mm/3 mm") → Crosswalk NONB15STF (15 mm) at 0.74; PACR's
  MS101003 (2/3 mm Mini Step) is right. The "2 mm/3 mm" size form is not parsed.
- **Dilating-tip trocars** (D5LT, D11LT, D12LT): PACR maps to bladed B…STF; Crosswalk's pick
  (179303 thoracic trocar, 0.62) is weak and correctly flagged Alternative/low.

## 3. Where Crosswalk is better

- **Coverage**: 119 additional proposals on lines PACR left blank (Applied Medical 53, "Unknown"
  manufacturer 43 — codes PACR could not even identify, Crosswalk resolved in GUDID).
- **Medtronic's own products**: PACR re-maps every one of the 23 Medtronic codes to a sibling SKU
  (S100710 10 mm → VS100711P 11 mm; VS101512P → NONB12LGF; NB15LGF → ONB15STF). The customer
  already buys these from Medtronic; Crosswalk keeps them as identity and prices them as-is.
- **One-to-many collapse**: PACR sends five different 12 mm / optical competitor codes (C0124,
  B12LTH, B12LPH, C0R47, …) to the single SKU 176674PF and five more to ONB11STF; Crosswalk
  distinguishes fixation vs smooth, optical vs bladeless, standard vs long where the sheet does.
- **Explainability**: confidence, source (curated / attribute / identity), rationale, two
  next-best options and the GUDID DI on every line; PACR gives a SKU and a tier.
- **Honest tiers**: 59 *Alternative* labels where PACR would have said Exact or nothing.

## 4. Pricing — not an engine difference, a run-setup difference

PACR priced 101 lines from the account's contract pricebooks (TROCAR – SANFORD HLTH, ENDO –
SANFORD HLTH, Vizient Trocar T1). The Crosswalk run had no account selected and used *List price*,
so only 18 lines priced. Re-run with account 0001583870 and the Sanford pricebooks loaded (Contracts
→ import, or the ERP price feed) and the waterfall will price every matched line.

## 5. Fixed as a result of this comparison

- **Intake dropped `IN-12`, `IN-15-4`, `IN-12-4`** (PACR lines 70/90/216): `looksLikeCfn` required
  three *consecutive* alphanumerics, which hyphenated short-segment codes never have. It now
  requires three alphanumerics in total. The three codes are PACR "Not Found" as well, so no
  proposal was lost — but they are now resolved rather than silently skipped.

## 6. Recommended next matcher work (not done — needs an eval run against the curated sheet)

1. Brand-level feature tags: OPTIVIEW, Kii Optical, Fios, Visiport → `optical`; Universal Sleeve /
   cannula / "sleeve only" → product type `cannula`; Dilating Tip → `dilating`. These are token
   rules in `src/lib/match/bin.ts` and would flip the §2 lines.
2. Size parsing for "2 mm/3 mm" and "2/3 mm" forms.
3. Review the 15 lines where PACR contradicts the curated sheet with product marketing — either
   the sheet is stale (Optiview → optical) or PACR was wrong; the sheet is what Crosswalk trusts.
4. Ship the 54 *Alternative* proposals through the review queue before they reach a quote.

## Appendix — every line both tools proposed on

| Competitor code | Manufacturer | PACR pick | PACR type | Crosswalk pick | Crosswalk type | Conf. | Source | Relationship |
|---|---|---|---|---|---|---|---|---|
| 176673P | Medtronic | ONB11STF | Close Match | 176673P | Exact Match | 1 | identity | PACR pick in CW candidates (rank 4+) |
| 23NBL | Ethicon - SterilMed | MS101003 | Exact Match | NONB15STF | Close Match | 0.74 | attribute | PACR pick in CW candidates (rank 4+) |
| 2B12XT | Ethicon - SterilMed | ONB12LGF | Exact Match | NB12STS | Close Match | 0.81 | attribute | PACR pick in CW candidates (rank 4+) |
| 2CB12LT | Ethicon - SterilMed | UNVCA12STF | Exact Match | 179097PF | Close Match | 0.67 | attribute | PACR pick in CW candidates (rank 4+) |
| CB12LT | Ethicon - SterilMed | UNVCA12STF | Exact Match | 179076P | Close Match | 0.72 | attribute | PACR pick in CW candidates (rank 4+) |
| CB5LT | Ethicon - SterilMed | UNVCA5STF | Exact Match | VS101005 | Close Match | 0.66 | attribute | PACR pick in CW candidates (rank 4+) |
| CTB11LT | Ethicon - SterilMed | UNVCA11STF | Exact Match | VSR100812P | Close Match | 0.67 | attribute | PACR pick in CW candidates (rank 4+) |
| CTF04 | Applied Medical | NONB5LGF | Exact Match | ONB5STF | Close Match | 0.97 | known-cross | PACR pick in CW candidates (rank 4+) |
| CTF71 | Applied Medical | NB12LGF | Close Match | ONB12LGF | Alternative Match | 0.9 | known-cross | PACR pick in CW candidates (rank 4+) |
| CTF74 | Applied Medical | NB12STF | Close Match | ONB12STF | Alternative Match | 0.88 | known-cross | PACR pick in CW candidates (rank 4+) |
| D12LT | Ethicon - SterilMed | B12STS | Exact Match | 179303 | Close Match | 0.62 | attribute | PACR pick in CW candidates (rank 4+) |
| LLVN12012 | Conmed / Buffalo Filter | VS070000 | Exact Match | 172015 | Exact Match | 0.95 | known-cross | PACR pick in CW candidates (rank 4+) |
| S100712 | Medtronic | VS100712P | Close Match | S100712 | Exact Match | 1 | identity | PACR pick in CW candidates (rank 4+) |
| S101005 | Medtronic | VS101005 | Close Match | S101005 | Exact Match | 1 | identity | PACR pick in CW candidates (rank 4+) |
| 176674P | Medtronic | 176674PF | Close Match | 176674P | Exact Match | 1 | identity | PACR pick is CW next-best (top-3) |
| 176674PF | Medtronic | 176674P | Close Match | 176674PF | Exact Match | 1 | identity | PACR pick is CW next-best (top-3) |
| 2CB5LT | Ethicon - SterilMed | UNVCA5STF | Exact Match | VS101005 | Close Match | 0.66 | attribute | PACR pick is CW next-best (top-3) |
| B12SRT | Ethicon - SterilMed | NONB12SHF | Exact Match | NB12SHF | Close Match | 0.8 | known-cross | PACR pick is CW next-best (top-3) |
| B12XT | Ethicon - SterilMed | NONB12LGF | Exact Match | ONB12LGF | Exact Match | 0.95 | known-cross | PACR pick is CW next-best (top-3) |
| B15LT | Ethicon - SterilMed | NONB15STF | Exact Match | NB15STF | Close Match | 0.95 | known-cross | PACR pick is CW next-best (top-3) |
| B5ST | Ethicon - SterilMed | NONB5SHF | Exact Match | NONB5STF | Close Match | 0.81 | known-cross | PACR pick is CW next-best (top-3) |
| C0124 | Applied Medical | 176674PF | Exact Match | ONB12STF | Exact Match | 0.93 | attribute | PACR pick is CW next-best (top-3) |
| C2201 | Applied Medical | VS070000 | Exact Match | 172015 | Exact Match | 0.95 | known-cross | PACR pick is CW next-best (top-3) |
| CB11LT | Ethicon - SterilMed | UNVCA11STF | Exact Match | S101000 | Close Match | 0.67 | attribute | PACR pick is CW next-best (top-3) |
| CB5ST | Ethicon - SterilMed | ONB5SHF | Exact Match | S101005 | Close Match | 0.66 | attribute | PACR pick is CW next-best (top-3) |
| CFB73 | Applied Medical | B12STF | Exact Match | B12STS | Close Match | 0.84 | attribute | PACR pick is CW next-best (top-3) |
| CFS03 | Applied Medical | ONB5SHF | Exact Match | UNVCA5SHF | Close Match | 0.8 | known-cross | PACR pick is CW next-best (top-3) |
| CTB01 | Applied Medical | ONB5LGF | Exact Match | B5STF | Alternative Match | 0.79 | attribute | PACR pick is CW next-best (top-3) |
| CTB71 | Applied Medical | 179097P | Exact Match | B12LGF | Exact Match | 0.95 | known-cross | PACR pick is CW next-best (top-3) |
| CTB73 | Applied Medical | 179096P | Exact Match | B12STF | Exact Match | 0.95 | known-cross | PACR pick is CW next-best (top-3) |
| CTF73 | Applied Medical | NB12STF | Close Match | ONB12STF | Close Match | 0.88 | known-cross | PACR pick is CW next-best (top-3) |
| D11LT | Ethicon - SterilMed | B11STF | Exact Match | 179303 | Close Match | 0.62 | attribute | PACR pick is CW next-best (top-3) |
| D5LT | Ethicon - SterilMed | B5STF | Exact Match | NONB5LGF | Alternative Match | 0.66 | attribute | PACR pick is CW next-best (top-3) |
| TT012 | Ethicon - SterilMed | 179307 | Exact Match | 179303 | Close Match | 0.95 | known-cross | PACR pick is CW next-best (top-3) |
| VS101500 | Medtronic | VS101000 | Close Match | VS101500 | Exact Match | 1 | identity | PACR pick is CW next-best (top-3) |
| VSR100005 | Medtronic | VSR100812P | Close Match | VSR100005 | Exact Match | 1 | identity | PACR pick is CW next-best (top-3) |
| 179094F | Medtronic | B5STS | Close Match | 179094F | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| 179096PF | Medtronic | B12STS | Close Match | 179096PF | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| 23NBS | Ethicon - SterilMed | MS101003 | Exact Match | NB3SHFLP | Close Match | 0.95 | known-cross | different, PACR pick not among CW candidates |
| 2B5LT | Ethicon - SterilMed | ONB5STF | Exact Match | NB5STF | Close Match | 0.81 | attribute | different, PACR pick not among CW candidates |
| 2B5ST | Ethicon - SterilMed | ONB5STF | Exact Match | NONB5SHF | Close Match | 0.81 | known-cross | different, PACR pick not among CW candidates |
| 2B5XT | Ethicon - SterilMed | ONB5LGF | Exact Match | NB5STF | Close Match | 0.81 | attribute | different, PACR pick not among CW candidates |
| 2H12LP | Ethicon - SterilMed | BPT12STS | Exact Match | NB12STS | Close Match | 0.81 | attribute | different, PACR pick not among CW candidates |
| B11LP | Ethicon - SterilMed | ONB11STF | Exact Match | NONB11STF | Close Match | 0.81 | known-cross | different, PACR pick not among CW candidates |
| B11LPH | Ethicon - SterilMed | 176673P | Exact Match | NONB11STF | Close Match | 0.81 | known-cross | different, PACR pick not among CW candidates |
| B11LTH | Ethicon - SterilMed | 176673P | Exact Match | ONB11STF | Exact Match | 0.95 | known-cross | different, PACR pick not among CW candidates |
| B12LPH | Ethicon - SterilMed | 176674PF | Exact Match | NONB12STS | Exact Match | 0.95 | known-cross | different, PACR pick not among CW candidates |
| B12LTH | Ethicon - SterilMed | 176674PF | Exact Match | ONB12STF | Exact Match | 0.97 | known-cross | different, PACR pick not among CW candidates |
| B5XT | Ethicon - SterilMed | NONB5LGF | Exact Match | NONB5STF | Exact Match | 0.81 | known-cross | different, PACR pick not among CW candidates |
| C0Q20 | Applied Medical | 176626P | Exact Match | NONB5STF | Alternative Match | 0.82 | attribute | different, PACR pick not among CW candidates |
| C0R39 | Applied Medical | NB15LGF | Close Match | ONB15STF | Close Match | 0.78 | attribute | different, PACR pick not among CW candidates |
| C0R47 | Applied Medical | 176674PF | Exact Match | OMST12BT | Exact Match | 0.95 | known-cross | different, PACR pick not among CW candidates |
| CTB12LT | Ethicon - SterilMed | UNVCA11STF | Exact Match | S101000 | Close Match | 0.67 | attribute | different, PACR pick not among CW candidates |
| CTS01 | Applied Medical | UNVCA5LGF | Close Match | 177092 | Close Match | 0.84 | attribute | different, PACR pick not among CW candidates |
| D12XT | Ethicon - SterilMed | B12LGF | Exact Match | 179096PF | Close Match | 0.8 | known-cross | different, PACR pick not among CW candidates |
| D5ST | Ethicon - SterilMed | B5SHF | Exact Match | 179093F | Close Match | 0.8 | known-cross | different, PACR pick not among CW candidates |
| MS101005 | Medtronic | MS100705 | Close Match | MS101005 | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| NB12STF | Medtronic | ONB12STF | Close Match | NB12STF | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| NB15LGF | Medtronic | ONB15STF | Close Match | NB15LGF | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| S100705 | Medtronic | ONB5STF | Close Match | S100705 | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| S100710 | Medtronic | VS100711P | Close Match | S100710 | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| S101010 | Medtronic | ONB11STF | Close Match | S101010 | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| S101012 | Medtronic | ONB12STF | Close Match | S101012 | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| VS100705 | Medtronic | ONB5SHF | Close Match | VS100705 | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| VS101512P | Medtronic | NONB12LGF | Close Match | VS101512P | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| VSR100812P | Medtronic | VSR100005 | Close Match | VSR100812P | Exact Match | 1 | identity | different, PACR pick not among CW candidates |
| 2B12LT | Ethicon - SterilMed | NB12STF | Close Match | NB12STF | Close Match | 0.8 | known-cross | same top pick |
| 606050001 | Conmed / Buffalo Filter | 172015 | Exact Match | 172015 | Exact Match | 0.95 | known-cross | same top pick |
| 606050002 | Conmed / Buffalo Filter | 172016 | Exact Match | 172016 | Exact Match | 0.95 | known-cross | same top pick |
| B11LT | Ethicon - SterilMed | NONB11STF | Exact Match | NONB11STF | Close Match | 0.95 | known-cross | same top pick |
| B12LP | Ethicon - SterilMed | NONB12STS | Exact Match | NONB12STS | Exact Match | 0.82 | known-cross | same top pick |
| B12LT | Ethicon - SterilMed | NONB12STF | Exact Match | NONB12STF | Exact Match | 0.95 | known-cross | same top pick |
| B5LT | Ethicon - SterilMed | NONB5STF | Exact Match | NONB5STF | Close Match | 0.81 | known-cross | same top pick |
| B8LT | Ethicon - SterilMed | NONB8STF | Exact Match | NONB8STF | Close Match | 0.95 | known-cross | same top pick |
| C0R37 | Applied Medical | ONB15STF | Exact Match | ONB15STF | Exact Match | 0.95 | known-cross | same top pick |
| C0R83 | Applied Medical | ONB12SHF | Exact Match | ONB12SHF | Close Match | 0.83 | known-cross | same top pick |
| C2202 | Applied Medical | 172016 | Exact Match | 172016 | Exact Match | 0.95 | known-cross | same top pick |
| CFB12 | Applied Medical | B5STF | Exact Match | B5STF | Close Match | 0.82 | attribute | same top pick |
| CFB71 | Applied Medical | B12LGF | Exact Match | B12LGF | Exact Match | 0.8 | attribute | same top pick |
| CFS01 | Applied Medical | ONB5LGF | Exact Match | ONB5LGF | Close Match | 0.8 | known-cross | same top pick |
| CNGL3 | Applied Medical | VSR100005 | Exact Match | VSR100005 | Exact Match | 0.95 | known-cross | same top pick |
| CTB03 | Applied Medical | B5STF | Exact Match | B5STF | Exact Match | 0.95 | known-cross | same top pick |
| CTB33 | Applied Medical | B11STF | Exact Match | B11STF | Exact Match | 0.95 | known-cross | same top pick |
| CTF01 | Applied Medical | ONB5LGF | Exact Match | ONB5LGF | Close Match | 0.8 | known-cross | same top pick |
| CTF03 | Applied Medical | 177092 | Exact Match | 177092 | Exact Match | 0.95 | known-cross | same top pick |
| CTR01 | Applied Medical | ONB5LGF | Exact Match | ONB5LGF | Exact Match | 0.95 | known-cross | same top pick |
| CTR03 | Applied Medical | ONB5STF | Exact Match | ONB5STF | Exact Match | 0.95 | known-cross | same top pick |
| CTR05 | Applied Medical | ONB5SHF | Exact Match | ONB5SHF | Close Match | 0.95 | known-cross | same top pick |
| CTR33 | Applied Medical | ONB11STF | Exact Match | ONB11STF | Exact Match | 0.95 | known-cross | same top pick |
| CTR34 | Applied Medical | ONB11STF | Exact Match | ONB11STF | Exact Match | 0.95 | known-cross | same top pick |
| CTR71 | Applied Medical | ONB12LGF | Exact Match | ONB12LGF | Exact Match | 0.95 | known-cross | same top pick |
| CTR72 | Applied Medical | ONB12LGF | Exact Match | ONB12LGF | Exact Match | 0.95 | known-cross | same top pick |
| CTR73 | Applied Medical | ONB12STF | Exact Match | ONB12STF | Exact Match | 0.97 | known-cross | same top pick |
| CTR74 | Applied Medical | ONB12STF | Exact Match | ONB12STF | Exact Match | 0.97 | known-cross | same top pick |
| FP007 | Ethicon - SterilMed | 179308 | Exact Match | 179308 | Exact Match | 0.95 | known-cross | same top pick |
| FP015 | Ethicon - SterilMed | 179310 | Exact Match | 179310 | Exact Match | 0.95 | known-cross | same top pick |
| H12LP | Ethicon - SterilMed | BPT12STS | Exact Match | BPT12STS | Close Match | 0.81 | known-cross | same top pick |
| PN120 | Ethicon - SterilMed | 172015 | Exact Match | 172015 | Exact Match | 0.95 | known-cross | same top pick |
| PN150 | Ethicon - SterilMed | 172016 | Exact Match | 172016 | Exact Match | 0.95 | known-cross | same top pick |
| UV120 | Ethicon - SterilMed | 172015 | Exact Match | 172015 | Exact Match | 0.95 | known-cross | same top pick |
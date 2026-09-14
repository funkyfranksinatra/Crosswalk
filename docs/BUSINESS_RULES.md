# Crosswalk — commercial business rules

Every rule below has one implementation (the file named) and a test in
`scripts/check-enterprise.ts` or `scripts/test-enterprise.ts`. If a rule changes,
change it there; the UI never computes money.

## Money and time
* All monetary values are decimals (`src/lib/money.ts`, decimal.js) with an explicit currency. Rounding is banker's rounding to the currency's minor unit and happens only when a figure is presented or persisted as a price.
* Nothing converts currency implicitly. `catalog/fx.ts` converts on request and returns the rate row used; a contract or entry in another currency is simply "not applicable" to a pricing question in this currency, and the explanation says so.
* Every pricing question has an `asOf` date. Contracts, entries, memberships, costs, policies and crosswalk versions are effective-dated; historical questions get historical answers.

## Price waterfall (`contracts/resolve.ts`)
1. **List** — the catalog list price, else the legacy price-list entry.
2. **National** — a NATIONAL contract (no account/GPO scope).
3. **GPO tier** — a GPO contract for a GPO the account is an active member of on the date; a contract tier must match the membership tier when both are set.
4. **IDN / parent** — an IDN contract on the account's parent.
5. **Local** — an account contract.

Higher level wins. `Contract.precedence > 0` overrides the natural order (a GPO agreement that contractually beats local pricing). Equal precedence → lowest price applies and the explanation says so. A contract applies only when ACTIVE, in force on the date, in the requested currency, and in scope (no scope rows = whole catalog). Inside a contract the entry must be ACTIVE + APPROVED, effective, and its quantity band must contain the quantity; the narrowest band wins, then the latest effective date. Every step — including losers and why — is returned.

## Cost (`catalog/cost.ts`)
Most specific effective `StandardCost` in the pricing currency: plant > region > global; a plant-specific cost for another plant never applies. Fallback: legacy `OwnProduct.cogs` (same currency). Otherwise cost is unknown and margin is reported as unknown, never zero. The basis used is stored on every proposal line.

## Competitive intelligence (`intelligence/summarize.ts`)
* Observations are append-only; only verification fields change.
* Current confidence = raw × verification factor (verified 1.0 / unverified 0.85 / disputed 0.4) × age factor (half-life by source: invoice & PO 365 d, bid file 270 d, GPO file 540 d, win/loss 365 d, internal 270 d, rep-observed 180 d, anecdotal 120 d). Raw confidence is never modified.
* Relevance to the pricing context: same account 1.0, same GPO 0.85, same region 0.7, market 0.55. Weight = current confidence × relevance.
* Basis: **KNOWN_ACCOUNT** when a same-account observation has current confidence ≥ 0.4; **MARKET_ESTIMATE** when the weight sum ≥ 0.4 (reference = weighted median); **WEAK** when observations exist but are stale/thin; **NONE** otherwise. Observations that decayed below 0.05 are ignored.

## Recommendation (`pricing/recommend.ts`)
* Floor = cost / (1 − min margin) by default (policy may use % of list or a fixed floor). Target = cost / (1 − target margin).
* Reference (what the customer pays today from us) = applicable contract price, else list.
* Competitor ceiling is used only when the basis is KNOWN_ACCOUNT or the confidence ≥ 0.4.
* Strategies: MATCH, UNDERCUT_PCT (default 2.5 %), UNDERCUT_AMOUNT, HOLD_PREMIUM (default +5 %, needs a justification), PRESERVE_CONTRACT, STRATEGIC_DISCOUNT (default 15 %), PENETRATION (floor + 2 %). With no usable competitor price, MATCH/UNDERCUT fall back to the target-margin price.
* The recommendation is clamped to [floor, reference] (HOLD_PREMIUM may go up to list). It never recommends below floor; a person may, and that is what approvals are for.
* The explanation is built from the actual numbers (price, margin, distance to floor, discounts, required authority).

## Authority and approvals (`pricing/recommend.ts` → `economicsAt`, `approvals/rules.ts`)
* Discount authority per role lives in the pricing policy (`authorityJson`, fraction). It is measured **incrementally**: below the currently applicable contract price when one exists, otherwise below list. Quoting the contract price the customer already has never needs approval by itself.
* Policy approval rules add conditions (below floor, margin below X, line/deal value over X, strategic account, contract months over X). The highest role demanded wins. Default: below floor → pricing committee.
* On submission, lines within the submitter's own authority are approved on the spot (audited); the rest create an `ApprovalRequest` with a snapshot (price, recommendation, floor, margin, discounts, policy version, deal revenue). Nobody approves their own request.
* Proposal status derives from its live requests: any rejected → REJECTED; any changes requested → CHANGES_REQUESTED (unlocks editing); all decided → APPROVED; some → PARTIALLY_APPROVED; none → SUBMITTED.
* Export / CRM push / marking won are blocked until every included line is priced and approved (`canFinalize`).

## Proposals (`proposals/service.ts`)
* A proposal snapshots, per line: competitor item, approved cross + crosswalk version, SKU, quantity, list, contract price + full waterfall, competitor price + basis + confidence + summary, cost + basis, floor/target/ceiling, recommendation, policy id. Later changes to contracts, costs, observations or the crosswalk do not alter it.
* Only a **published** crosswalk entry may be shown as an equivalence. A pairing the engine produced that is not published is flagged "unapproved" with equivalence NONE.
* Editable only in DRAFT / CHANGES_REQUESTED and not locked. Submission locks. Closed proposals get a **new version** (all snapshots copied) rather than edits.
* Scenarios store their own prices; economics can be computed for any scenario; applying a scenario copies prices into an unlocked proposal, audited per line.
* Deal economics (`proposals/economics.ts`): revenue, list value, current-contract value, competitor spend, customer savings (priced lines with both prices), gross profit and blended margin (lines with cost), discount from list / from contract, share of wallet (competitor spend of priced lines ÷ all included lines), per-family rollups, approval counts.

## Contracts (`contracts/*`)
* Volume tiers are quantity-banded price entries. Commitments track units/value per period; performance is computed from purchase records.
* Rebates: tiers by units/value/compliance/growth; the highest threshold met applies; effective net = invoice spend − rebate. Invoice price never changes.
* Bundles: a condition on one family/SKU (min units/value or award) grants a benefit on another; evaluated over a proposal's lines, surfaced on the affected lines, never stored as price rows.
* Clauses (renewal, price protection, escalation) are structured and validated; `protectedCeiling` computes the maximum permitted price under a protection clause.
* Renewal pipeline: active contracts expiring within N days, with compliance flags.

## Crosswalk governance (`xref/governance.ts`)
* Curated sheet crosses are APPROVED with an equivalence derived from the match type (Exact → EXACT, Close → FUNCTIONAL, Alternative → CLOSEST_ALTERNATIVE, Downsell → PARTIAL_SUBSTITUTE).
* Rep-proposed crosses enter as DRAFT with clinical and marketing review PENDING; approval requires both reviews; only publishing freezes approved crosses into a numbered version. Proposals pin the version they were created with.

## Outcomes and compliance (`proposals/outcome.ts`, `compliance/index.ts`)
* WON: the approved prices become a LOCAL contract (effective today, term N months) with per-SKU commitments, so the waterfall now resolves to them. LOST: competitor + reasons recorded; the competitor's winning prices become WIN_LOSS_RECORD observations.
* Conversion = actual units shipped since the decision ÷ pro-rated committed units, per line and per family. Commitment status: MET / ON_TRACK / AT_RISK (behind pace by > 20 % of elapsed share) / MISSED / NOT_STARTED.

## Analytics (`analytics/index.ts`)
* **Rep acceptance rate** = `MatchDecision.acceptedTop`; **validated accuracy** = `groundTruth` set by reviewers. They are different columns and are reported side by side.

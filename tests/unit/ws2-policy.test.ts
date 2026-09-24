/**
 * WS2 — pricing policy model and the recommendation engine (pure). Expected values are written
 * out from the documented rules (docs/BUILD_NOTES.md §14, docs/BUSINESS_RULES.md), never derived by
 * calling the function under test.
 */
import { describe, test, expect } from "vitest";
import { Decimal, D } from "@/lib/money";
import { recommend, floorFor, authorityForDiscount, approvalRequirements, economicsAt, type RecommendInput } from "@/lib/pricing/recommend";
import { DEFAULT_POLICY, PolicyInputSchema, policyProblems, STRATEGIES, type Policy } from "@/lib/pricing/policy-model";
import { requiredRoleFor } from "@/lib/approvals/rules";

const policy = (over: Partial<Policy> = {}): Policy => ({ id: "pol-1", productFamily: "Trocar Products", version: 3, status: "ACTIVE", ...DEFAULT_POLICY, ...over });
const input = (over: Partial<RecommendInput> = {}): RecommendInput => ({ currency: "USD", quantity: D(10), listPrice: D("1000"), contractPrice: null, contractSource: null, cost: D("400"), competitorPrice: null, competitorConfidence: 0, competitorBasis: "NONE", policy: policy(), ...over });
// Sentinel figures that must never appear in a customer-visible explanation.
const COST = D("123.4567"), FLOOR_SENTINEL = D("12345.6789");

describe("WS2 policy — validation", () => {
  test("policyProblems: target < minimum, malformed floors, unknown roles, shrinking authority, missing below-floor rule", () => {
    const pp = (over: Partial<Policy>) => policyProblems({ productFamily: "*", ...DEFAULT_POLICY, ...over });
    expect(pp({})).toEqual([]);
    expect(pp({ targetMarginPct: 0.2, minMarginPct: 0.3 })).toEqual(["minimum margin 0.3 is above target margin 0.2"]);
    expect(pp({ floorMethod: "PCT_OF_LIST" })).toEqual(["PCT_OF_LIST floor needs floorParams.pctOfList"]);
    expect(pp({ floorMethod: "FIXED" })).toEqual(["FIXED floor needs floorParams.fixed"]);
    expect(pp({ authority: { ...DEFAULT_POLICY.authority, CFO: 0.5 } })).toEqual(["authority names unknown role CFO"]);
    expect(pp({ authority: { SALES_REP: 0.3, REGIONAL_MANAGER: 0.25, CONTRACTING_MANAGER: 0.3, PRICING_DIRECTOR: 0.4, PRICING_COMMITTEE: 1 } })).toEqual(["REGIONAL_MANAGER authority (0.25) is below SALES_REP (0.3); authority must not shrink up the chain"]);
    expect(pp({ approvalRules: [{ when: { belowFloor: true }, require: "CFO" }] })).toEqual(["approval rule requires unknown role CFO"]);
    expect(pp({ approvalRules: [{ when: { lineValueOver: 1 }, require: "PRICING_DIRECTOR" }] })).toEqual(["no approval rule covers pricing below floor"]);
    expect(pp({ approvalRules: [] })).toEqual(["no approval rule covers pricing below floor"]);
  });
  test("PolicyInputSchema bounds every field: margins < 0.99, pctOfList ≤ 1, fixed ≥ 0, importance 1–5 integer, ≤ 50 rules, authority in [0,1]", () => {
    const ok = PolicyInputSchema.safeParse({ productFamily: "Mesh", targetMarginPct: 0.5, minMarginPct: 0.3, floorMethod: "PCT_OF_LIST", floorParams: { pctOfList: 0.6 }, strategicImportance: 4 });
    expect(ok.success).toBe(true);
    const bad = [
      { productFamily: "" },
      { productFamily: "Mesh", targetMarginPct: 1 },
      { productFamily: "Mesh", minMarginPct: -0.1 },
      { productFamily: "Mesh", floorParams: { pctOfList: 1.5 } },
      { productFamily: "Mesh", floorParams: { fixed: -1 } },
      { productFamily: "Mesh", strategicImportance: 0 },
      { productFamily: "Mesh", strategicImportance: 2.5 },
      { productFamily: "Mesh", authority: { SALES_REP: 1.5 } },
      { productFamily: "Mesh", defaultStrategy: "GUESS" },
      { productFamily: "Mesh", approvalRules: [{ when: { marginBelow: 2 }, require: "PRICING_DIRECTOR" }] },
      { productFamily: "Mesh", approvalRules: Array.from({ length: 51 }, () => ({ when: { belowFloor: true }, require: "PRICING_COMMITTEE" })) },
    ];
    for (const b of bad) expect(PolicyInputSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});

describe("WS2 recommendation — floors, authority, rules", () => {
  test("floorFor: COST_PLUS_MIN_MARGIN = cost/(1−minMargin); PCT_OF_LIST; FIXED; null when the input is missing", () => {
    expect(floorFor(policy(), D("400"), D("1000"))!.toString()).toBe("571.4285714285714285714285714"); // 400 / 0.7
    expect(floorFor(policy({ floorParams: { minMarginPct: 0.5 } }), D("400"), null)!.toString()).toBe("800"); // floorParams override the policy minimum
    expect(floorFor(policy(), null, D("1000"))).toBeNull();
    expect(floorFor(policy({ floorMethod: "PCT_OF_LIST", floorParams: { pctOfList: 0.6 } }), null, D("1000"))!.toString()).toBe("600");
    expect(floorFor(policy({ floorMethod: "PCT_OF_LIST", floorParams: { pctOfList: 0.6 } }), D("400"), null)).toBeNull();
    expect(floorFor(policy({ floorMethod: "PCT_OF_LIST", floorParams: {} }), D("400"), D("1000"))).toBeNull();
    expect(floorFor(policy({ floorMethod: "FIXED", floorParams: { fixed: 550 } }), null, null)!.toString()).toBe("550");
    expect(floorFor(policy({ floorMethod: "FIXED", floorParams: {} }), D("400"), D("1000"))).toBeNull();
    expect(floorFor(policy({ minMarginPct: 1 }), D("400"), D("1000"))).toBeNull(); // 100 % minimum margin: no finite floor
  });

  test("authorityForDiscount: the lowest role whose allowance covers the discount; SALES_REP → null; none → committee; ≤ 0 → null", () => {
    const p = policy();
    expect(authorityForDiscount(p, null)).toBeNull();
    expect(authorityForDiscount(p, D("0"))).toBeNull();
    expect(authorityForDiscount(p, D("-0.1"))).toBeNull(); // above reference: no discount
    expect(authorityForDiscount(p, D("0.15"))).toBeNull(); // exactly the rep allowance
    expect(authorityForDiscount(p, D("0.150000001"))).toBeNull(); // inside the 1e-9 float tolerance the comparison allows
    expect(authorityForDiscount(p, D("0.15001"))).toBe("REGIONAL_MANAGER");
    expect(authorityForDiscount(p, D("0.25"))).toBe("REGIONAL_MANAGER");
    expect(authorityForDiscount(p, D("0.3"))).toBe("CONTRACTING_MANAGER");
    expect(authorityForDiscount(p, D("0.4"))).toBe("PRICING_DIRECTOR");
    expect(authorityForDiscount(p, D("0.41"))).toBe("PRICING_COMMITTEE");
    expect(authorityForDiscount(p, D("1"))).toBe("PRICING_COMMITTEE");
    expect(authorityForDiscount(policy({ authority: { PRICING_DIRECTOR: 0.4 } }), D("0.1"))).toBe("PRICING_DIRECTOR"); // no rep allowance configured → first configured role
    expect(authorityForDiscount(policy({ authority: {} }), D("0.01"))).toBe("PRICING_COMMITTEE");
  });

  test("approvalRequirements: each `when` condition, the highest role wins, negation-only rules never fire, lineValueOver is distinct from dealValueOver", () => {
    const facts = { belowFloor: false, belowTargetMargin: false, marginPct: D("0.35"), discountFromList: D("0.2"), discountFromContract: null, dealValue: D("100000"), lineValue: D("300000"), strategicAccount: false, contractMonths: null as number | null };
    // Default policy: lineValueOver 250,000 → PRICING_DIRECTOR (line value, not deal value).
    expect(approvalRequirements(policy(), facts)).toEqual({ role: "PRICING_DIRECTOR", reasons: ["line value over 250k"] });
    expect(approvalRequirements(policy(), { ...facts, lineValue: D("250000") })).toEqual({ role: null, reasons: [] }); // "over" is strict
    expect(approvalRequirements(policy(), { ...facts, lineValue: D("1000"), dealValue: D("10000000") })).toEqual({ role: null, reasons: [] }); // a huge deal value does not trip the LINE rule
    const rules: Policy["approvalRules"] = [
      { when: { belowFloor: true }, require: "PRICING_COMMITTEE", reason: "below floor" },
      { when: { belowTargetMargin: true }, require: "REGIONAL_MANAGER", reason: "below target" },
      { when: { marginBelow: 0.2 }, require: "CONTRACTING_MANAGER", reason: "thin margin" },
      { when: { discountFromListOver: 0.5 }, require: "PRICING_DIRECTOR", reason: "deep list discount" },
      { when: { discountFromContractOver: 0.1 }, require: "CONTRACTING_MANAGER", reason: "off contract" },
      { when: { dealValueOver: 1000000 }, require: "PRICING_DIRECTOR", reason: "big deal" },
      { when: { lineValueOver: 250000 }, require: "PRICING_DIRECTOR", reason: "big line" },
      { when: { strategicAccount: true }, require: "REGIONAL_MANAGER", reason: "strategic" },
      { when: { contractMonthsOver: 36 }, require: "CONTRACTING_MANAGER", reason: "long term" },
      { when: { belowFloor: false, strategicAccount: false }, require: "PRICING_COMMITTEE", reason: "must never fire" },
    ];
    const p = policy({ approvalRules: rules });
    const quiet = { ...facts, lineValue: D("1"), marginPct: D("0.5"), discountFromList: D("0.1") };
    expect(approvalRequirements(p, quiet)).toEqual({ role: null, reasons: [] });
    expect(approvalRequirements(p, { ...quiet, belowFloor: true }).role).toBe("PRICING_COMMITTEE");
    expect(approvalRequirements(p, { ...quiet, belowTargetMargin: true }).role).toBe("REGIONAL_MANAGER");
    expect(approvalRequirements(p, { ...quiet, marginPct: D("0.19") })).toEqual({ role: "CONTRACTING_MANAGER", reasons: ["thin margin"] });
    expect(approvalRequirements(p, { ...quiet, marginPct: null }).role).toBeNull(); // unknown margin never trips a margin rule
    expect(approvalRequirements(p, { ...quiet, discountFromList: D("0.51") }).role).toBe("PRICING_DIRECTOR");
    expect(approvalRequirements(p, { ...quiet, discountFromContract: D("0.11") }).role).toBe("CONTRACTING_MANAGER");
    expect(approvalRequirements(p, { ...quiet, dealValue: D("1000001") }).role).toBe("PRICING_DIRECTOR");
    expect(approvalRequirements(p, { ...quiet, strategicAccount: true }).role).toBe("REGIONAL_MANAGER");
    expect(approvalRequirements(p, { ...quiet, contractMonths: 37 }).role).toBe("CONTRACTING_MANAGER");
    expect(approvalRequirements(p, { ...quiet, contractMonths: 36 }).role).toBeNull();
    // Several rules: the highest wins and every reason is kept in rule order.
    const many = approvalRequirements(p, { ...quiet, belowTargetMargin: true, marginPct: D("0.1"), strategicAccount: true, belowFloor: true });
    expect(many.role).toBe("PRICING_COMMITTEE");
    expect(many.reasons).toEqual(["below floor", "below target", "thin margin", "strategic"]);
  });

  test("required authority = max(discount authority, rule authority); discount is measured incrementally below the contract price when there is one", () => {
    const p = policy();
    const facts = { belowFloor: false, marginPct: D("0.5"), lineValue: D("1"), dealValue: null, strategicAccount: false, contractMonths: null };
    expect(requiredRoleFor(p, { ...facts, discountFromList: D("0.2"), discountFromContract: null })).toBe("REGIONAL_MANAGER");
    // 20 % off list but only 2 % below the contract the customer already has → within rep authority.
    expect(requiredRoleFor(p, { ...facts, discountFromList: D("0.2"), discountFromContract: D("0.02") })).toBeNull();
    // Rule authority (director, line value) beats a manager-level discount.
    expect(requiredRoleFor(p, { ...facts, discountFromList: D("0.2"), discountFromContract: null, lineValue: D("300000") })).toBe("PRICING_DIRECTOR");
    // Discount authority (committee) beats a rule (director).
    expect(requiredRoleFor(p, { ...facts, discountFromList: D("0.6"), discountFromContract: null, lineValue: D("300000") })).toBe("PRICING_COMMITTEE");
    expect(requiredRoleFor(p, { ...facts, discountFromList: D("0.6"), discountFromContract: null, belowFloor: true })).toBe("PRICING_COMMITTEE");
  });

  test("economicsAt: zero/missing denominators → null margins and discounts; belowFloor and lineValue", () => {
    const e = economicsAt(D("0"), { listPrice: D("0"), contractPrice: null, cost: D("10"), quantity: D(1), policy: policy(), strategicAccount: false, dealValue: null, contractMonths: null }, D("5"));
    expect(e.marginPct).toBeNull();
    expect(e.discountFromListPct).toBeNull();
    expect(e.marginAmount!.toString()).toBe("-10");
    expect(e.belowFloor).toBe(true);
    expect(e.lineValue!.toString()).toBe("0");
    const none = economicsAt(null, { listPrice: D("100"), contractPrice: null, cost: null, quantity: D(1), policy: policy(), strategicAccount: false, dealValue: null, contractMonths: null }, null);
    expect(none).toMatchObject({ marginPct: null, marginAmount: null, discountFromListPct: null, discountFromContractPct: null, belowFloor: false, lineValue: null, requiredAuthority: null, approvalReasons: [] });
    const belowTarget = economicsAt(D("500"), { listPrice: D("1000"), contractPrice: D("600"), cost: D("400"), quantity: D(100), policy: policy(), strategicAccount: false, dealValue: null, contractMonths: null }, D("571.43"));
    expect(belowTarget.belowFloor).toBe(true);
    expect(belowTarget.belowTargetMargin).toBe(true); // 20 % < 45 %
    expect(belowTarget.discountFromContractPct!.toString()).toBe("0.1666666666666666666666666667");
    expect(belowTarget.requiredAuthority).toBe("PRICING_COMMITTEE");
    expect(belowTarget.approvalReasons[0]).toBe("16.7% below the current contract price exceeds rep authority");
    expect(belowTarget.approvalReasons).toContain("below floor");
  });
});

describe("WS2 recommendation — strategies", () => {
  // list 1000, cost 400 → floor 571.43, target 727.27; competitor 900 KNOWN_ACCOUNT.
  const known = input({ competitorPrice: D("900"), competitorConfidence: 0.9, competitorBasis: "KNOWN_ACCOUNT" });
  const tab: [string, RecommendInput, string, string][] = [
    ["MATCH with a usable competitor price → the competitor price", { ...known, strategy: "MATCH" }, "900", "matches the competitor reference $900.00"],
    ["MATCH with no competitor price → target margin price", input({ strategy: "MATCH" }), "727.27", "no competitor price; priced at target margin"],
    ["MATCH with a weak competitor price (0.3 < 0.4, not KNOWN_ACCOUNT) → target margin", input({ strategy: "MATCH", competitorPrice: D("500"), competitorConfidence: 0.3, competitorBasis: "WEAK" }), "727.27", "competitor price too weak to anchor on; priced at target margin"],
    ["MATCH: MARKET_ESTIMATE at exactly 0.4 is usable", input({ strategy: "MATCH", competitorPrice: D("850"), competitorConfidence: 0.4, competitorBasis: "MARKET_ESTIMATE" }), "850", "matches the competitor reference $850.00"],
    ["MATCH: KNOWN_ACCOUNT is usable whatever its confidence", input({ strategy: "MATCH", competitorPrice: D("850"), competitorConfidence: 0.1, competitorBasis: "KNOWN_ACCOUNT" }), "850", "matches the competitor reference $850.00"],
    ["UNDERCUT_PCT default 2.5 %: 900 × 0.975 = 877.5", { ...known, strategy: "UNDERCUT_PCT" }, "877.5", "2.5% below the competitor reference $900.00"],
    ["UNDERCUT_PCT with adjustment 5 % (sign ignored)", { ...known, strategy: "UNDERCUT_PCT", adjustmentPct: -0.05 }, "855", "5.0% below the competitor reference $900.00"],
    ["UNDERCUT_PCT without a usable competitor price → target", input({ strategy: "UNDERCUT_PCT" }), "727.27", "no usable competitor price to undercut; priced at target margin"],
    ["UNDERCUT_AMOUNT 25 → 875", { ...known, strategy: "UNDERCUT_AMOUNT", adjustmentAmount: 25 }, "875", "$25.00 below the competitor reference $900.00"],
    ["UNDERCUT_AMOUNT with no amount → the competitor price itself", { ...known, strategy: "UNDERCUT_AMOUNT" }, "900", "$0.00 below the competitor reference $900.00"],
    ["HOLD_PREMIUM default 5 %: 900 × 1.05 = 945 (below list)", { ...known, strategy: "HOLD_PREMIUM" }, "945", "5.0% premium over the competitor reference $900.00 — add a clinical/product justification"],
    ["HOLD_PREMIUM never above list: 990 × 1.05 = 1039.5 → capped at list 1000", { ...known, competitorPrice: D("990"), strategy: "HOLD_PREMIUM", justification: "Tri-Staple" }, "1000", "capped at list $1000.00"],
    ["HOLD_PREMIUM without a competitor price → the reference (contract, else list)", input({ strategy: "HOLD_PREMIUM", contractPrice: D("800"), contractSource: "GPO" }), "800", "no competitor price; premium held at current price"],
    ["PRESERVE_CONTRACT → the contract price", input({ strategy: "PRESERVE_CONTRACT", contractPrice: D("800"), contractSource: "GPO" }), "800", "holds the current GPO price"],
    ["PRESERVE_CONTRACT with no contract → list", input({ strategy: "PRESERVE_CONTRACT" }), "1000", "holds the current list price"],
    ["STRATEGIC_DISCOUNT default 15 % from list → 850", input({ strategy: "STRATEGIC_DISCOUNT" }), "850", "strategic 15% discount from list"],
    ["STRATEGIC_DISCOUNT 15 % from the contract price 800 → 680", input({ strategy: "STRATEGIC_DISCOUNT", contractPrice: D("800"), contractSource: "LOCAL" }), "680", "strategic 15% discount from current contract"],
    ["PENETRATION = floor × 1.02 = 571.43 × 1.02 → 582.86", input({ strategy: "PENETRATION" }), "582.86", "commodity penetration price just above floor"],
    ["PENETRATION without a cost (no floor) → target… which needs a cost too → list", input({ strategy: "PENETRATION", cost: null }), "1000", "no current price"],
    ["policy default strategy applies when none is given (UNDERCUT_PCT policy)", { ...known, policy: policy({ defaultStrategy: "UNDERCUT_PCT" }) }, "877.5", "2.5% below"],
    ["policy default adjustment applies (UNDERCUT_PCT 4 %)", { ...known, policy: policy({ defaultStrategy: "UNDERCUT_PCT", defaultAdjustmentPct: 0.04 }) }, "864", "4.0% below"],
  ];
  for (const [name, inp, price, note] of tab) {
    test(name, () => {
      const r = recommend(inp);
      if (name.startsWith("PENETRATION without a cost")) { expect(r.recommendedPrice).toBeNull(); expect(r.explanation).toMatch(/No recommendation/); return; }
      expect(r.recommendedPrice!.toString()).toBe(price);
      expect(r.explanation).toContain(note);
      expect(r.strategy).toBe(inp.strategy ?? inp.policy.defaultStrategy);
    });
  }
  test("every documented strategy is in STRATEGIES", () => {
    expect([...STRATEGIES].sort()).toEqual(["HOLD_PREMIUM", "MATCH", "PENETRATION", "PRESERVE_CONTRACT", "STRATEGIC_DISCOUNT", "UNDERCUT_AMOUNT", "UNDERCUT_PCT"]);
  });
});

describe("WS2 recommendation — clamping, confidence, explanations", () => {
  test("clamp to [floor, reference]: a competitor price below floor is raised to the floor; above the reference is capped", () => {
    const low = recommend(input({ strategy: "MATCH", competitorPrice: D("300"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT" }));
    expect(low.recommendedPrice!.toString()).toBe("571.43");
    expect(low.belowFloor).toBe(false);
    expect(low.explanation).toContain("raised to the floor $571.43");
    const high = recommend(input({ strategy: "MATCH", competitorPrice: D("1200"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT", contractPrice: D("800"), contractSource: "GPO" }));
    expect(high.recommendedPrice!.toString()).toBe("800");
    expect(high.explanation).toContain("capped at the current price $800.00");
    expect(high.ceilingPrice!.toString()).toBe("1200");
    expect(high.referencePrice!.toString()).toBe("800");
  });

  test("inconsistent inputs: floor above the reference — the reference wins, the line is flagged below floor for the committee, and the explanation says why", () => {
    // cost 800 → floor 1142.86 > list 1000.
    const r = recommend(input({ strategy: "MATCH", cost: D("800") }));
    expect(r.recommendedPrice!.toString()).toBe("1000");
    expect(r.floorPrice!.toString()).toBe("1142.86");
    expect(r.belowFloor).toBe(true);
    expect(r.requiredAuthority).toBe("PRICING_COMMITTEE");
    expect(r.explanation).toMatch(/floor \$1142\.86 is above list \$1000\.00; capped at list and flagged below floor/);
    expect(r.explanation).not.toMatch(/raised to the floor/);
  });

  test("rounding to the currency's minor unit: USD 2 dp half-even, JPY 0 dp", () => {
    // UNDERCUT_PCT 2.5 % on 1234.5 → 1203.6375 → 1203.64
    const usd = recommend(input({ strategy: "UNDERCUT_PCT", competitorPrice: D("1234.5"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT", listPrice: D("5000") }));
    expect(usd.recommendedPrice!.toString()).toBe("1203.64");
    const jpy = recommend(input({ currency: "JPY", strategy: "UNDERCUT_PCT", competitorPrice: D("1234.5"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT", listPrice: D("5000") }));
    expect(jpy.recommendedPrice!.toString()).toBe("1204");
    expect(jpy.floorPrice!.toString()).toBe("571");
  });

  test("confidence = 0.35 + 0.2[cost] + (0.25·compConf + 0.1)[usable] + 0.1[contract], capped at 1; 0 when there is no price", () => {
    expect(recommend(input({ cost: null, listPrice: D("1000") })).confidence).toBeCloseTo(0.35, 10);
    expect(recommend(input()).confidence).toBeCloseTo(0.55, 10);
    expect(recommend(input({ competitorPrice: D("900"), competitorConfidence: 0.8, competitorBasis: "MARKET_ESTIMATE" })).confidence).toBeCloseTo(0.35 + 0.2 + 0.25 * 0.8 + 0.1, 10);
    expect(recommend(input({ competitorPrice: D("900"), competitorConfidence: 0.3, competitorBasis: "WEAK" })).confidence).toBeCloseTo(0.55, 10); // not usable
    expect(recommend(input({ contractPrice: D("800"), contractSource: "GPO" })).confidence).toBeCloseTo(0.65, 10);
    expect(recommend(input({ contractPrice: D("800"), contractSource: "GPO", competitorPrice: D("900"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT" })).confidence).toBeCloseTo(1, 10);
    expect(recommend(input({ cost: null, listPrice: null })).confidence).toBe(0);
    expect(recommend(input({ cost: null, listPrice: null })).recommendedPrice).toBeNull();
  });

  test("explanationPublic never contains cost, floor or margin figures (sentinel values), while the internal explanation does", () => {
    const cases: RecommendInput[] = [
      input({ cost: COST }),
      input({ cost: COST, strategy: "MATCH", competitorPrice: D("100"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT" }), // raised to the floor
      input({ cost: COST, strategy: "PENETRATION" }),
      input({ cost: null, policy: policy({ floorMethod: "FIXED", floorParams: { fixed: FLOOR_SENTINEL.toNumber() } }), strategy: "MATCH", competitorPrice: D("100"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT", listPrice: D("20000") }),
      input({ cost: D("800"), strategy: "MATCH" }), // floor above list
      input({ cost: COST, strategy: "STRATEGIC_DISCOUNT", contractPrice: D("500"), contractSource: "LOCAL", competitorBasis: "WEAK", competitorPrice: D("450"), competitorConfidence: 0.3 }),
    ];
    for (const c of cases) {
      const r = recommend(c);
      const floor = floorFor(c.policy, c.cost, c.listPrice);
      // The recommended price itself may legitimately BE the floor (raised to it); everything after
      // "Recommend $X: " must still be free of cost / floor / margin figures.
      const pub = r.explanationPublic.replace(/^Recommend \$[\d.]+: /, "");
      expect(pub, pub).not.toContain("123.4567");
      expect(pub, pub).not.toContain("123.46");
      expect(pub, pub).not.toContain("12345.68");
      expect(pub, pub).not.toContain("12,345.68");
      expect(pub, pub).not.toMatch(/gross margin|margin \d|\d% margin|margin unknown/i); // "priced at target margin" names the strategy, not a figure
      if (floor && r.recommendedPrice && !r.recommendedPrice.eq(new Decimal(floor.toFixed(2)))) expect(pub, pub).not.toContain(`$${floor.toFixed(2)}`);
      expect(pub, pub).not.toMatch(/floor \$/); // a floor may be mentioned, never priced
      expect(pub, pub).not.toMatch(/\$[\d,.]+ (above|BELOW)/);
      if (c.cost) expect(r.explanation).toMatch(/Gross margin|Margin unknown/);
    }
    const internal = recommend(input({ cost: COST }));
    expect(internal.explanation).toMatch(/Gross margin \d+\.\d% \(\$\d+\.\d\d\/unit\)/);
    expect(internal.explanation).toMatch(/above the Trocar Products floor \$/);
  });

  test("required authority in the recommendation: below-floor → committee; deep list discount → director; contract-relative discount within authority → none", () => {
    const committee = recommend(input({ policy: policy({ floorMethod: "FIXED", floorParams: { fixed: 900 } }), strategy: "STRATEGIC_DISCOUNT" }));
    expect(committee.recommendedPrice!.toString()).toBe("900"); // clamped up to the fixed floor, so within authority (10 % off list)
    expect(committee.requiredAuthority).toBeNull();
    const director = recommend(input({ strategy: "STRATEGIC_DISCOUNT", adjustmentPct: 0.35 })); // 650: 35 % off list, above floor 571.43
    expect(director.recommendedPrice!.toString()).toBe("650");
    expect(director.requiredAuthority).toBe("PRICING_DIRECTOR");
    expect(director.approvalReasons).toEqual(["35.0% below list exceeds rep authority"]);
    const withContract = recommend(input({ strategy: "UNDERCUT_PCT", contractPrice: D("700"), contractSource: "LOCAL", competitorPrice: D("690"), competitorConfidence: 1, competitorBasis: "KNOWN_ACCOUNT" }));
    expect(withContract.recommendedPrice!.toString()).toBe("672.75"); // 690 × 0.975; 3.9 % below contract → rep authority
    expect(withContract.requiredAuthority).toBeNull();
    expect(withContract.discountFromListPct!.toString()).toBe("0.32725");
    expect(withContract.explanationPublic).toContain("32.7% off list, 3.9% below the current LOCAL price");
    expect(withContract.explanationPublic).toContain("Within sales-rep authority.");
  });

  test("bundle benefit adjusts the price before clamping; WEAK intelligence adds a warning", () => {
    const r = recommend(input({ strategy: "PRESERVE_CONTRACT", contractPrice: D("800"), contractSource: "LOCAL", bundleBenefitPct: -0.1 }));
    expect(r.recommendedPrice!.toString()).toBe("720");
    expect(r.explanation).toContain("bundle term adjusts by -10.0%");
    const weak = recommend(input({ competitorPrice: D("450"), competitorConfidence: 0.3, competitorBasis: "WEAK" }));
    expect(weak.explanationPublic).toContain("Competitor price intelligence is weak — verify before quoting.");
  });
});

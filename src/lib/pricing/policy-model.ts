/**
 * Pricing policy model (pure — no I/O). Versioned per product family; "*" is the
 * default. The repository side (activate, draft) lives in ./policy.ts.
 */
import { z } from "zod";
import { money } from "@/lib/money";

export const AuthoritySchema = z.record(z.string(), z.number().min(0).max(1)); // role → max discount from list (fraction)
export const ApprovalRuleSchema = z.object({
  when: z.object({
    belowFloor: z.boolean().optional(),
    belowTargetMargin: z.boolean().optional(),
    marginBelow: z.number().min(0).max(1).optional(),
    discountFromListOver: z.number().min(0).max(1).optional(),
    discountFromContractOver: z.number().min(0).max(1).optional(),
    dealValueOver: z.number().nonnegative().optional(),
    lineValueOver: z.number().nonnegative().optional(),
    strategicAccount: z.boolean().optional(),
    contractMonthsOver: z.number().positive().optional(),
  }),
  require: z.string(),
  reason: z.string().optional(),
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const STRATEGIES = ["MATCH", "UNDERCUT_AMOUNT", "UNDERCUT_PCT", "HOLD_PREMIUM", "PRESERVE_CONTRACT", "STRATEGIC_DISCOUNT", "PENETRATION"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type Policy = {
  id: string;
  productFamily: string;
  version: number;
  status: string;
  targetMarginPct: number;
  minMarginPct: number;
  floorMethod: "COST_PLUS_MIN_MARGIN" | "PCT_OF_LIST" | "FIXED";
  floorParams: { pctOfList?: number; fixed?: number; minMarginPct?: number };
  defaultStrategy: Strategy;
  defaultAdjustmentPct: number;
  classification: "COMMODITY" | "DIFFERENTIATED";
  strategicImportance: number;
  authority: Record<string, number>;
  approvalRules: ApprovalRule[];
};

export const DEFAULT_POLICY: Omit<Policy, "id" | "version" | "status" | "productFamily"> = {
  targetMarginPct: 0.45,
  minMarginPct: 0.3,
  floorMethod: "COST_PLUS_MIN_MARGIN",
  floorParams: {},
  defaultStrategy: "MATCH",
  defaultAdjustmentPct: 0,
  classification: "DIFFERENTIATED",
  strategicImportance: 3,
  authority: { SALES_REP: 0.15, REGIONAL_MANAGER: 0.25, CONTRACTING_MANAGER: 0.3, PRICING_DIRECTOR: 0.4, PRICING_COMMITTEE: 1 },
  approvalRules: [
    { when: { belowFloor: true }, require: "PRICING_COMMITTEE", reason: "below floor" },
    { when: { lineValueOver: 250000 }, require: "PRICING_DIRECTOR", reason: "line value over 250k" },
  ],
};

export function toPolicy(row: { id: string; productFamily: string; version: number; status: string; targetMarginPct: unknown; minMarginPct: unknown; floorMethod: string; floorParamsJson: string; defaultStrategy: string; defaultAdjustmentPct: unknown; classification: string; strategicImportance: number; authorityJson: string; approvalRulesJson: string }): Policy {
  const parse = <T,>(s: string, schema: z.ZodType<T>, fallback: T): T => { try { const r = schema.safeParse(JSON.parse(s)); return r.success ? r.data : fallback; } catch { return fallback; } };
  return {
    id: row.id,
    productFamily: row.productFamily,
    version: row.version,
    status: row.status,
    targetMarginPct: money(row.targetMarginPct as never)!.toNumber(),
    minMarginPct: money(row.minMarginPct as never)!.toNumber(),
    floorMethod: row.floorMethod as Policy["floorMethod"],
    floorParams: parse(row.floorParamsJson, z.object({ pctOfList: z.number().optional(), fixed: z.number().optional(), minMarginPct: z.number().optional() }), {}),
    defaultStrategy: (STRATEGIES.includes(row.defaultStrategy as Strategy) ? row.defaultStrategy : "MATCH") as Strategy,
    defaultAdjustmentPct: money(row.defaultAdjustmentPct as never)!.toNumber(),
    classification: row.classification as Policy["classification"],
    strategicImportance: row.strategicImportance,
    authority: parse(row.authorityJson, AuthoritySchema, DEFAULT_POLICY.authority),
    approvalRules: parse(row.approvalRulesJson, z.array(ApprovalRuleSchema), DEFAULT_POLICY.approvalRules),
  };
}


export type PolicyInput = Partial<Omit<Policy, "id" | "version" | "status">> & { productFamily: string; name?: string };

/** What an administrator may submit as a policy draft — a bad policy silently disables floors, so everything is checked. */
export const PolicyInputSchema = z.object({
  productFamily: z.string().trim().min(1).max(80),
  name: z.string().max(120).optional().nullable(),
  targetMarginPct: z.number().min(0).max(0.99).optional(),
  minMarginPct: z.number().min(0).max(0.99).optional(),
  floorMethod: z.enum(["COST_PLUS_MIN_MARGIN", "PCT_OF_LIST", "FIXED"]).optional(),
  floorParams: z.object({ pctOfList: z.number().min(0).max(1).optional(), fixed: z.number().nonnegative().optional(), minMarginPct: z.number().min(0).max(0.99).optional() }).optional(),
  defaultStrategy: z.enum(STRATEGIES).optional(),
  defaultAdjustmentPct: z.number().min(-1).max(1).optional(),
  classification: z.enum(["COMMODITY", "DIFFERENTIATED"]).optional(),
  strategicImportance: z.number().int().min(1).max(5).optional(),
  authority: AuthoritySchema.optional(),
  approvalRules: z.array(ApprovalRuleSchema).max(50).optional(),
});

/** Cross-field rules a merged policy must satisfy. Returns the problems (empty = valid). */
export function policyProblems(p: Omit<Policy, "id" | "version" | "status">): string[] {
  const out: string[] = [];
  if (p.minMarginPct > p.targetMarginPct) out.push(`minimum margin ${p.minMarginPct} is above target margin ${p.targetMarginPct}`);
  if (p.floorMethod === "PCT_OF_LIST" && p.floorParams.pctOfList === undefined) out.push("PCT_OF_LIST floor needs floorParams.pctOfList");
  if (p.floorMethod === "FIXED" && p.floorParams.fixed === undefined) out.push("FIXED floor needs floorParams.fixed");
  const ranks = ["SALES_REP", "REGIONAL_MANAGER", "CONTRACTING_MANAGER", "PRICING_DIRECTOR", "PRICING_COMMITTEE"];
  for (const [role] of Object.entries(p.authority)) if (!ranks.includes(role)) out.push(`authority names unknown role ${role}`);
  for (let i = 1; i < ranks.length; i++) {
    const lo = p.authority[ranks[i - 1]], hi = p.authority[ranks[i]];
    if (lo !== undefined && hi !== undefined && hi < lo) out.push(`${ranks[i]} authority (${hi}) is below ${ranks[i - 1]} (${lo}); authority must not shrink up the chain`);
  }
  for (const r of p.approvalRules) if (!ranks.includes(r.require)) out.push(`approval rule requires unknown role ${r.require}`);
  if (!p.approvalRules.some((r) => r.when.belowFloor)) out.push("no approval rule covers pricing below floor");
  return out;
}

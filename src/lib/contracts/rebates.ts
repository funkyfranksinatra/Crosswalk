/**
 * Rebates: invoice price stays what the contract says; the *effective net price*
 * subtracts the rebate earned at the volume/value/compliance level reached.
 * Tiers are [{ threshold, rebatePct? | rebateAmount? }] sorted ascending; the
 * highest threshold met applies (non-cumulative, the common medical-device form).
 */
import { z } from "zod";
import { Decimal, money, type Money, ZERO } from "@/lib/money";

export const TiersSchema = z.array(z.object({ threshold: z.number().nonnegative(), rebatePct: z.number().min(0).max(1).optional(), rebateAmount: z.number().nonnegative().optional() }));
export type RebateTier = z.infer<typeof TiersSchema>[number];

export type RebateInput = { id: string; type: string; basis: string; productFamily: string | null; tiersJson: string; periodMonths: number };

export function parseTiers(json: string): RebateTier[] {
  try { const r = TiersSchema.safeParse(JSON.parse(json)); return r.success ? [...r.data].sort((a, b) => a.threshold - b.threshold) : []; } catch { return []; }
}

/** The tier reached for a measured basis value (units, value, compliance %, growth %). */
export function tierReached(tiers: RebateTier[], measured: Money): { tier: RebateTier | null; next: RebateTier | null } {
  let reached: RebateTier | null = null;
  let next: RebateTier | null = null;
  for (const t of tiers) {
    if (measured.gte(t.threshold)) reached = t;
    else { next = t; break; }
  }
  return { tier: reached, next };
}

/** Rebate earned on a spend amount at a tier. */
export function rebateOn(spend: Money, units: Money, tier: RebateTier | null): Money {
  if (!tier) return ZERO;
  if (tier.rebatePct != null) return spend.times(tier.rebatePct);
  if (tier.rebateAmount != null) return units.times(tier.rebateAmount);
  return ZERO;
}

/**
 * Effective net price for a family or whole contract given expected volume and spend.
 * `measured` is the basis value (units for UNITS, spend for VALUE, fraction for the % bases).
 */
export function effectiveNet(input: { invoiceSpend: Money; units: Money; rebate: RebateInput; measured: Money }): { rebate: Money; net: Money; tier: RebateTier | null; next: RebateTier | null; toNext: Money | null } {
  const tiers = parseTiers(input.rebate.tiersJson);
  const { tier, next } = tierReached(tiers, input.measured);
  const rebate = rebateOn(input.invoiceSpend, input.units, tier);
  return { rebate, net: input.invoiceSpend.minus(rebate), tier, next, toNext: next ? new Decimal(next.threshold).minus(input.measured) : null };
}

export const rebateBasisValue = (basis: string, units: Money, spend: Money, compliancePct: Money | null, growthPct: Money | null): Money =>
  basis === "UNITS" ? units : basis === "VALUE" ? spend : basis === "COMPLIANCE_PCT" ? (compliancePct ?? ZERO) : (growthPct ?? ZERO);

export { money };

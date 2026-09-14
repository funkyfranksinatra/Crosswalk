/**
 * Bundle terms: a benefit on one family/SKU conditional on volume or award elsewhere.
 * Evaluated against a set of lines (a proposal or a purchase history), never stored
 * as per-SKU price rows.
 */
import { z } from "zod";
import { Decimal, money, type Money, ZERO } from "@/lib/money";

export const ConditionSchema = z.object({ productFamily: z.string().optional(), productId: z.string().optional(), minUnits: z.number().nonnegative().optional(), minValue: z.number().nonnegative().optional(), awarded: z.boolean().optional() });
export const BenefitSchema = z.object({ productFamily: z.string().optional(), productId: z.string().optional(), pricePct: z.number().min(-1).max(1).optional(), priceAmount: z.number().optional(), rebatePct: z.number().min(0).max(1).optional() });
export type BundleCondition = z.infer<typeof ConditionSchema>;
export type BundleBenefit = z.infer<typeof BenefitSchema>;

export type BundleLine = { productId: string | null; productFamily: string | null; quantity: Money; extended: Money; included: boolean };

export function parseBundle(conditionJson: string, benefitJson: string): { condition: BundleCondition; benefit: BundleBenefit } | null {
  try {
    const c = ConditionSchema.safeParse(JSON.parse(conditionJson));
    const b = BenefitSchema.safeParse(JSON.parse(benefitJson));
    return c.success && b.success ? { condition: c.data, benefit: b.data } : null;
  } catch { return null; }
}

const matches = (l: BundleLine, sel: { productFamily?: string; productId?: string }) =>
  (sel.productId ? l.productId === sel.productId : true) && (sel.productFamily ? (l.productFamily ?? "").toLowerCase() === sel.productFamily.toLowerCase() : true);

/** Is the condition met by these lines? Returns the measured units/value for explanation. */
export function conditionMet(lines: BundleLine[], c: BundleCondition): { met: boolean; units: Money; value: Money; reason: string } {
  const inc = lines.filter((l) => l.included && matches(l, c));
  const units = inc.reduce((a, l) => a.plus(l.quantity), ZERO);
  const value = inc.reduce((a, l) => a.plus(l.extended), ZERO);
  if (c.awarded && inc.length === 0) return { met: false, units, value, reason: "condition family/SKU not on the proposal" };
  if (c.minUnits != null && units.lt(c.minUnits)) return { met: false, units, value, reason: `${units} units < ${c.minUnits} required` };
  if (c.minValue != null && value.lt(c.minValue)) return { met: false, units, value, reason: `${value} value < ${c.minValue} required` };
  return { met: true, units, value, reason: "condition met" };
}

/** Benefit price for a line if the bundle applies: adjusts the given base price. */
export function applyBenefit(base: Money, b: BundleBenefit): Money {
  let v = base;
  if (b.pricePct != null) v = v.times(new Decimal(1).plus(b.pricePct));
  if (b.priceAmount != null) v = v.plus(b.priceAmount);
  return v;
}

export function benefitApplies(line: BundleLine, b: BundleBenefit): boolean {
  return matches(line, b);
}

export { money };

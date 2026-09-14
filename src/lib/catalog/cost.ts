/**
 * Cost selection by operational context. Most specific effective StandardCost wins:
 * plant > region > global; then latest effectiveFrom. `OwnProduct.cogs` is the last
 * resort. Margin is never computed from a cost in another currency.
 */
import { money, type Money } from "@/lib/money";

export type CostInput = {
  id: string;
  plant: string | null;
  region: string | null;
  currency: string;
  costType: string;
  cost: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
};

export type CostResolution = {
  cost: Money | null;
  currency: string;
  basis: { kind: "STANDARD_COST" | "LEGACY_COGS" | "NONE"; costId?: string; plant?: string | null; region?: string | null; costType?: string; effectiveFrom?: string; source?: string; specificity?: string; considered: number; note: string };
};

export function resolveCostFromInputs(input: { productId: string; fallbackCogs: unknown; fallbackCurrency: string; costs: CostInput[]; asOf: Date; currency: string; region: string | null; plant: string | null }): CostResolution {
  const live = input.costs.filter((c) => c.effectiveFrom.getTime() <= input.asOf.getTime() && (c.effectiveTo === null || input.asOf.getTime() < c.effectiveTo.getTime()) && c.currency === input.currency);
  const score = (c: CostInput) => {
    if (c.plant && input.plant && c.plant === input.plant) return 3;
    if (c.plant) return -1; // a plant-specific cost for another plant never applies
    if (c.region && input.region && c.region.toLowerCase() === input.region.toLowerCase()) return 2;
    if (c.region) return -1;
    return 1; // global
  };
  const ranked = live.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.c.effectiveFrom.getTime() - a.c.effectiveFrom.getTime());
  const best = ranked[0];
  if (best) {
    const spec = best.s === 3 ? "plant" : best.s === 2 ? "region" : "global";
    return {
      cost: money(best.c.cost as never),
      currency: input.currency,
      basis: { kind: "STANDARD_COST", costId: best.c.id, plant: best.c.plant, region: best.c.region, costType: best.c.costType, effectiveFrom: best.c.effectiveFrom.toISOString(), source: best.c.source, specificity: spec, considered: input.costs.length, note: `${best.c.costType} cost (${spec}) effective ${best.c.effectiveFrom.toISOString().slice(0, 10)} from ${best.c.source}` },
    };
  }
  const legacy = money(input.fallbackCogs as never);
  if (legacy !== null && input.fallbackCurrency === input.currency) {
    return { cost: legacy, currency: input.currency, basis: { kind: "LEGACY_COGS", considered: input.costs.length, note: "catalog COGS (no dated standard cost on file)" } };
  }
  return { cost: null, currency: input.currency, basis: { kind: "NONE", considered: input.costs.length, note: legacy !== null ? `cost only known in ${input.fallbackCurrency}` : "no cost on file — margin unknown" } };
}

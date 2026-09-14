/**
 * Structured contract clauses. Stored as JSON on Contract but validated here so
 * renewal, price protection and escalation are data the system can reason about,
 * not free text. Unknown shapes are rejected on write.
 */
import { z } from "zod";
import { Decimal, type Money } from "@/lib/money";

export const RenewalSchema = z.object({
  kind: z.enum(["NONE", "AUTO", "NEGOTIATED", "EVERGREEN"]).default("NEGOTIATED"),
  termMonths: z.number().int().positive().optional(),
  noticeDays: z.number().int().nonnegative().optional(),
  increasePct: z.number().min(-1).max(1).optional(), // renewal increase as fraction
  notes: z.string().optional(),
});
export type Renewal = z.infer<typeof RenewalSchema>;

export const PriceProtectionSchema = z.object({
  kind: z.enum(["NONE", "FIXED_YEARS", "MAX_ANNUAL_PCT", "CPI", "SCHEDULED", "PRICE_MATCH"]),
  years: z.number().positive().optional(),
  maxAnnualPct: z.number().min(0).max(1).optional(),
  cpiIndex: z.string().optional(),
  cpiCapPct: z.number().min(0).max(1).optional(),
  schedule: z.array(z.object({ effectiveFrom: z.string(), pct: z.number() })).optional(),
  notes: z.string().optional(),
});
export type PriceProtection = z.infer<typeof PriceProtectionSchema>;

export const EscalationSchema = z.object({
  kind: z.enum(["NONE", "FIXED_ANNUAL_PCT", "CPI", "SCHEDULED"]),
  annualPct: z.number().min(-1).max(1).optional(),
  cpiIndex: z.string().optional(),
  schedule: z.array(z.object({ effectiveFrom: z.string(), pct: z.number() })).optional(),
  notes: z.string().optional(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export function parseClause<T>(schema: z.ZodType<T>, json: string | null | undefined): T | null {
  if (!json) return null;
  try { const r = schema.safeParse(JSON.parse(json)); return r.success ? r.data : null; } catch { return null; }
}

/**
 * Maximum price allowed at `asOf` under the protection clause, given the contract's
 * starting price and start date. Returns null when the clause does not cap.
 */
export function protectedCeiling(base: Money, start: Date, asOf: Date, p: PriceProtection | null): Money | null {
  if (!p || p.kind === "NONE" || p.kind === "PRICE_MATCH") return null;
  const years = Math.max(0, (asOf.getTime() - start.getTime()) / (365.25 * 24 * 3600 * 1000));
  if (p.kind === "FIXED_YEARS") return years < (p.years ?? 0) ? base : null;
  if (p.kind === "MAX_ANNUAL_PCT") return base.times(new Decimal(1).plus(p.maxAnnualPct ?? 0).pow(Math.floor(years)));
  if (p.kind === "CPI") return p.cpiCapPct != null ? base.times(new Decimal(1).plus(p.cpiCapPct).pow(Math.floor(years))) : null;
  if (p.kind === "SCHEDULED") {
    let v = base;
    for (const s of p.schedule ?? []) if (new Date(s.effectiveFrom) <= asOf) v = v.times(new Decimal(1).plus(s.pct));
    return v;
  }
  return null;
}

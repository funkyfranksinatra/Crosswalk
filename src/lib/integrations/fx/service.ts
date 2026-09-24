/**
 * FX service. Rates are stored in ExchangeRate with their provider and fetch time; every
 * conversion the application performs records which stored rate it used (src/lib/catalog/fx.ts
 * returns the rate id, callers persist it). When a date has no stored rate the provider is
 * asked for that exact date; if it has none, the fallback policy decides — `fail` (default),
 * `previous-business-day` (walk back up to N days, and say so), never a silent live rate.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { toDb, money, type Money } from "@/lib/money";
import type { FxRateProvider } from "../core/contracts";
import type { FxRateRecord } from "../types";
import { ConfigurationError, IntegrationError } from "../core/errors";
import { assertCurrency } from "./providers";

export type FxPolicy = { fallback: "fail" | "previous-business-day"; maxLookbackDays: number };

/**
 * CANONICAL missing-rate policy (docs/INTEGRATION_SETUP.md § FX). One definition, read by the
 * registry's field defaults and by every conversion:
 *   fallback          `fail` — a date with no rate is an error, never a substituted current rate.
 *   maxLookbackDays   5 — when `previous-business-day` is chosen, walk back at most 5 calendar days:
 *                     a weekend (2) plus a holiday on either side of it (Fri or Mon) with one to spare,
 *                     e.g. Tue 29 Dec → Mon 28 (holiday) → weekend → Thu 24 (holiday) → Wed 23.
 * Anything an operator sets under Settings → Integrations → FX overrides it (`fxPolicyFrom`);
 * the value is clamped to 0–30 days because a longer walk is no longer "the previous business day".
 */
export const FX_MAX_LOOKBACK_DEFAULT = 5;
export const FX_MAX_LOOKBACK_CAP = 30;
export const DEFAULT_FX_POLICY: FxPolicy = { fallback: "fail", maxLookbackDays: FX_MAX_LOOKBACK_DEFAULT };

/** The policy from an FX IntegrationConfig's non-secret settings (missing or malformed values → the canonical default). */
export function fxPolicyFrom(config: Record<string, unknown> | null | undefined): FxPolicy {
  const fb = String(config?.fallback ?? "").trim();
  const raw = config?.maxLookbackDays;
  const n = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
  const days = Number.isFinite(n) ? Math.min(FX_MAX_LOOKBACK_CAP, Math.max(0, Math.floor(n))) : FX_MAX_LOOKBACK_DEFAULT;
  return { fallback: fb === "previous-business-day" ? "previous-business-day" : "fail", maxLookbackDays: days };
}

/** The policy the deployment has configured (Settings → Integrations → FX), or the canonical default when there is none. */
export async function configuredFxPolicy(): Promise<FxPolicy> {
  const { readConfig } = await import("../core/config");
  // An unreadable FX configuration (wrong encryption key, corrupt row) must not quietly become
  // the default policy (review REV-11): it is logged as an error and the default is used with that on record.
  const cfg = await readConfig("fx").catch((e: unknown) => { log.error("fx.config_unreadable", { error: e instanceof Error ? e.message : String(e) }); return null; });
  return fxPolicyFrom(cfg?.config);
}

export async function storeRate(r: FxRateRecord, syncJobId: string | null = null, enteredByUserId: string | null = null) {
  const asOf = new Date(`${r.date}T00:00:00.000Z`);
  const rate = toDb(money(r.rate)!)!;
  const where = { fromCurrency_toCurrency_asOf_source: { fromCurrency: r.base, toCurrency: r.quote, asOf, source: r.provider } };
  const existing = await prisma.exchangeRate.findUnique({ where });
  if (existing) {
    // A historical rate is never overwritten: a provider restating a past day's rate is logged, not applied.
    if (existing.rate.toString() !== rate.toString()) { log.warn("fx.rate_restated_ignored", { base: r.base, quote: r.quote, date: r.date, provider: r.provider, stored: existing.rate.toString(), offered: rate.toString() }); return existing; }
    return prisma.exchangeRate.update({ where, data: { fetchedAt: new Date(r.fetchedAt), syncJobId: syncJobId ?? existing.syncJobId } });
  }
  return prisma.exchangeRate.create({ data: { fromCurrency: r.base, toCurrency: r.quote, asOf, source: r.provider, rate, fetchedAt: new Date(r.fetchedAt), syncJobId, enteredByUserId } });
}

export type RateLookup = { rateId: string; rate: string; base: string; quote: string; date: string; provider: string; note: string | null };

/** The rate for a date: stored first, then the provider for that exact date, then the policy. Throws when none applies. */
export async function rateFor(provider: FxRateProvider | null, base: string, quote: string, date: string, policy: FxPolicy = DEFAULT_FX_POLICY): Promise<RateLookup> {
  const b = assertCurrency(base, "source currency"), q = assertCurrency(quote, "destination currency");
  if (b === q) throw new ConfigurationError("rateFor called for the same currency");
  const days = policy.fallback === "previous-business-day" ? Math.max(0, policy.maxLookbackDays) : 0;
  for (let i = 0; i <= days; i++) {
    const d = shift(date, -i);
    const stored = await prisma.exchangeRate.findFirst({ where: { fromCurrency: b, toCurrency: q, asOf: new Date(`${d}T00:00:00.000Z`) }, orderBy: [{ source: "asc" }, { createdAt: "desc" }] });
    if (stored) return { rateId: stored.id, rate: stored.rate.toString(), base: b, quote: q, date: d, provider: stored.source, note: i ? `no ${b}/${q} rate on ${date}; used ${d} (${i} day${i > 1 ? "s" : ""} earlier) per the fallback policy` : null };
    if (provider && provider.provider !== "manual") {
      let fetched: FxRateRecord | null = null;
      try { fetched = await provider.getRate(b, q, d); } catch (e) { if (i === days) throw e instanceof IntegrationError ? e : new IntegrationError("PROVIDER_UNAVAILABLE", `FX provider failed: ${(e as Error).message}`); log.warn("fx.provider_error", { provider: provider.provider, error: (e as Error).message }); }
      if (fetched) { const row = await storeRate(fetched); return { rateId: row.id, rate: fetched.rate, base: b, quote: q, date: d, provider: fetched.provider, note: i ? `no ${b}/${q} rate on ${date}; used ${d} (${i} day${i > 1 ? "s" : ""} earlier) per the fallback policy` : null }; }
    }
  }
  throw new IntegrationError("NOT_FOUND", `No ${b}→${q} exchange rate for ${date}${days ? ` or the ${days} days before it` : ""}. ${provider && provider.provider !== "manual" ? `The ${provider.provider} provider has none for that date` : "Enter one under Settings → Exchange rates or configure an FX provider"}; a current rate is never substituted for a historical one.`, { retryable: false });
}

/** Convert with a recorded rate. Same-currency is the identity and records no rate. */
export async function convertWithProvider(provider: FxRateProvider | null, amount: Money, from: string, to: string, date: string, policy?: FxPolicy): Promise<{ amount: Money; rateId: string | null; rate: string; from: string; to: string; date: string; provider: string | null; note: string | null }> {
  if (from.toUpperCase() === to.toUpperCase()) return { amount, rateId: null, rate: "1", from: from.toUpperCase(), to: to.toUpperCase(), date, provider: null, note: null };
  const r = await rateFor(provider, from, to, date, policy);
  return { amount: amount.times(money(r.rate)!), rateId: r.rateId, rate: r.rate, from: r.base, to: r.quote, date: r.date, provider: r.provider, note: r.note };
}

/** Scheduled pull: store the day's rates for the configured pairs (each recorded with its provider). */
export async function pullRates(provider: FxRateProvider, pairs: { base: string; quote: string }[], date: string, syncJobId: string | null): Promise<{ stored: number; missing: string[] }> {
  let stored = 0; const missing: string[] = [];
  for (const p of pairs) {
    const r = await provider.getRate(p.base, p.quote, date);
    if (r) { await storeRate(r, syncJobId); stored++; } else missing.push(`${p.base}/${p.quote}`);
  }
  return { stored, missing };
}

function shift(date: string, days: number): string { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

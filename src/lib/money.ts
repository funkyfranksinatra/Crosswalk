/**
 * Money — the only place monetary arithmetic happens.
 *
 * Every monetary value is a decimal.js `Decimal` paired with an explicit currency.
 * Prisma returns its own Decimal class; `money()` converts anything (Prisma Decimal,
 * string, number, null) into ours at the boundary, and `toDb()` converts back.
 * Floats never touch contractual figures. `num()` exists only for display and for the
 * cross-reference ranker, whose scores are not contractual.
 */
import Decimal from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type Money = Decimal;
export type MoneyLike = Decimal | { toString(): string } | string | number | null | undefined;

const MINOR_UNITS: Record<string, number> = { JPY: 0, KRW: 0, HUF: 0, KWD: 3, BHD: 3, JOD: 3 };

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

/** Convert anything money-like to a Decimal; null stays null. */
export function money(v: MoneyLike): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Decimal) return v;
  if (typeof v === "number") { if (!Number.isFinite(v)) return null; return new Decimal(v); }
  const s = String(v).trim();
  if (!s) return null;
  try { return new Decimal(s); } catch { return null; }
}

/** Like money() but throws on missing values — for figures that must exist. */
export function D(v: MoneyLike): Decimal {
  const d = money(v);
  if (d === null) throw new Error(`money required, got ${String(v)}`);
  return d;
}

export const ZERO = new Decimal(0);

export function num(v: MoneyLike): number | null {
  const d = money(v);
  return d === null ? null : d.toNumber();
}

/** Round to the currency's minor unit (banker's rounding). */
export function round(v: Decimal, currency = "USD"): Decimal {
  return v.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_EVEN);
}

export function times(price: MoneyLike, qty: MoneyLike): Decimal | null {
  const p = money(price), q = money(qty);
  return p === null || q === null ? null : p.times(q);
}

export function sum(values: MoneyLike[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v) ?? ZERO), ZERO);
}

/** part / whole as a fraction (0.25 = 25 %); null when whole is 0 or missing. */
export function ratio(part: MoneyLike, whole: MoneyLike): Decimal | null {
  const p = money(part), w = money(whole);
  if (p === null || w === null || w.isZero()) return null;
  return p.div(w);
}

/** Gross margin fraction = (price − cost) / price. */
export function marginPct(price: MoneyLike, cost: MoneyLike): Decimal | null {
  const p = money(price), c = money(cost);
  if (p === null || c === null || p.isZero()) return null;
  return p.minus(c).div(p);
}

export function marginAmount(price: MoneyLike, cost: MoneyLike): Decimal | null {
  const p = money(price), c = money(cost);
  return p === null || c === null ? null : p.minus(c);
}

/** Discount fraction from a reference: (ref − price) / ref. Positive = cheaper than reference. */
export function discountPct(price: MoneyLike, reference: MoneyLike): Decimal | null {
  const p = money(price), r = money(reference);
  if (p === null || r === null || r.isZero()) return null;
  return r.minus(p).div(r);
}

/** Price that yields a target margin fraction on a cost: cost / (1 − m). */
export function priceForMargin(cost: MoneyLike, margin: MoneyLike): Decimal | null {
  const c = money(cost), m = money(margin);
  if (c === null || m === null || m.gte(1)) return null;
  return c.div(new Decimal(1).minus(m));
}

export function applyPct(v: MoneyLike, pct: MoneyLike): Decimal | null {
  const a = money(v), p = money(pct);
  return a === null || p === null ? null : a.times(new Decimal(1).plus(p));
}

export function max(...vs: MoneyLike[]): Decimal | null {
  const ds = vs.map(money).filter((d): d is Decimal => d !== null);
  return ds.length ? ds.reduce((a, b) => (a.gte(b) ? a : b)) : null;
}
export function min(...vs: MoneyLike[]): Decimal | null {
  const ds = vs.map(money).filter((d): d is Decimal => d !== null);
  return ds.length ? ds.reduce((a, b) => (a.lte(b) ? a : b)) : null;
}

/** Clamp v into [lo, hi]; missing bounds are ignored. */
export function clamp(v: Decimal, lo: MoneyLike, hi: MoneyLike): Decimal {
  const l = money(lo), h = money(hi);
  let out = v;
  if (l !== null && out.lt(l)) out = l;
  if (h !== null && out.gt(h)) out = h;
  return out;
}

/** Serialize for Prisma (string keeps full precision). */
export function toDb(v: MoneyLike): string | null {
  const d = money(v);
  return d === null ? null : d.toFixed(4);
}

/** JSON-safe representation (string) for API responses. */
export function toJson(v: MoneyLike): string | null {
  const d = money(v);
  return d === null ? null : d.toString();
}

export function fmt(v: MoneyLike, currency = "USD", opts: { compact?: boolean } = {}): string {
  const d = money(v);
  if (d === null) return "—";
  const n = d.toNumber();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: minorUnits(currency), maximumFractionDigits: minorUnits(currency), ...(opts.compact ? { notation: "compact" } : {}) }).format(n);
  } catch {
    return `${currency} ${d.toFixed(minorUnits(currency))}`;
  }
}

export function fmtPct(v: MoneyLike, digits = 1): string {
  const d = money(v);
  return d === null ? "—" : `${d.times(100).toFixed(digits)}%`;
}

export { Decimal };

/**
 * FX rate providers. `manual` reads the ExchangeRate table (entered under Settings);
 * `ecb` reads the European Central Bank's public daily reference rates (no credential; EUR
 * base, cross-rated for other pairs); `http` is a configurable JSON endpoint for a commercial
 * feed. A provider returns the rate for the exact date asked or null — never a substitute.
 */
import type { FxRateProvider, ConnectionTestResult } from "../core/contracts";
import type { FxRateRecord } from "../types";
import { httpJson } from "../core/http";
import { getPath } from "../core/mapping";
import { ValidationError } from "../core/errors";
import { prisma } from "@/lib/db";

const ISO = /^[A-Z]{3}$/;
export function assertCurrency(c: string, what = "currency"): string { const u = c.trim().toUpperCase(); if (!ISO.test(u)) throw new ValidationError(`${what} "${c}" is not an ISO 4217 code`, { retryable: false }); return u; }

export class ManualFxProvider implements FxRateProvider {
  readonly provider = "manual";
  async testConnection(): Promise<ConnectionTestResult> { const n = await prisma.exchangeRate.count({ where: { source: "manual" } }); return { ok: true, message: `Manual rates: ${n} on file` }; }
  async getRate(base: string, quote: string, date: string): Promise<FxRateRecord | null> {
    const row = await prisma.exchangeRate.findFirst({ where: { fromCurrency: assertCurrency(base), toCurrency: assertCurrency(quote), asOf: new Date(`${date}T00:00:00.000Z`) }, orderBy: { createdAt: "desc" } });
    return row ? { base, quote, rate: row.rate.toString(), date, provider: row.source, fetchedAt: row.createdAt.toISOString() } : null;
  }
}

/** ECB daily reference rates via the public data API (EUR base). Cross rates are derived and marked as such. */
export class EcbFxProvider implements FxRateProvider {
  readonly provider = "ecb";
  constructor(private cfg: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {}
  private get base() { return (this.cfg.baseUrl ?? "https://data-api.ecb.europa.eu/service/data/EXR").replace(/\/$/, ""); }
  async testConnection(): Promise<ConnectionTestResult> {
    const r = await this.eurRate("USD", new Date().toISOString().slice(0, 10), true);
    return r ? { ok: true, message: `ECB reachable: EUR/USD ${r.rate} on ${r.date}` } : { ok: true, message: "ECB reachable (no rate published for today yet — weekends and holidays have none)" };
  }
  private async eurRate(ccy: string, date: string, latest = false): Promise<{ rate: string; date: string } | null> {
    const url = `${this.base}/D.${ccy}.EUR.SP00.A?${latest ? "lastNObservations=1" : `startPeriod=${date}&endPeriod=${date}`}&format=csvdata`;
    const r = await httpJson<string>(url, { headers: { accept: "text/csv" } }, { provider: "fx-ecb", operation: "rate", fetchImpl: this.cfg.fetchImpl, notFoundOk: true });
    if (r.status === 404 || !r.body || typeof r.body !== "string") return null;
    const lines = r.body.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const head = lines[0].split(","); const iT = head.indexOf("TIME_PERIOD"), iV = head.indexOf("OBS_VALUE");
    const last = lines[lines.length - 1].split(",");
    const v = last[iV], d = last[iT];
    return v && d ? { rate: v, date: d } : null;
  }
  async getRate(base: string, quote: string, date: string): Promise<FxRateRecord | null> {
    const b = assertCurrency(base), q = assertCurrency(quote);
    if (b === q) return { base: b, quote: q, rate: "1", date, provider: this.provider, fetchedAt: new Date().toISOString() };
    const fetchedAt = new Date().toISOString();
    if (b === "EUR") { const r = await this.eurRate(q, date); return r && r.date === date ? { base: b, quote: q, rate: r.rate, date, provider: this.provider, fetchedAt } : null; }
    if (q === "EUR") { const r = await this.eurRate(b, date); return r && r.date === date ? { base: b, quote: q, rate: (1 / Number(r.rate)).toFixed(8), date, provider: this.provider, fetchedAt } : null; }
    const [rb, rq] = await Promise.all([this.eurRate(b, date), this.eurRate(q, date)]);
    if (!rb || !rq || rb.date !== date || rq.date !== date) return null;
    return { base: b, quote: q, rate: (Number(rq.rate) / Number(rb.rate)).toFixed(8), date, provider: `${this.provider}-cross`, fetchedAt };
  }
}

/** A configurable JSON endpoint: {endpoint} with {base}/{quote}/{date} placeholders, and a JSON path to the rate. */
export class HttpFxProvider implements FxRateProvider {
  readonly provider = "http";
  constructor(private cfg: { endpoint: string; ratePath: string; datePath?: string | null; auth: { mode: "bearer"; token: string } | { mode: "api-key"; header: string; key: string } | { mode: "query"; param: string; key: string } | { mode: "none" }; fetchImpl?: typeof fetch }) {}
  private url(base: string, quote: string, date: string): string {
    const u = new URL(this.cfg.endpoint.replace("{base}", base).replace("{quote}", quote).replace("{date}", date));
    if (this.cfg.auth.mode === "query") u.searchParams.set(this.cfg.auth.param, this.cfg.auth.key);
    return u.toString();
  }
  private headers(): Record<string, string> { const a = this.cfg.auth; return a.mode === "bearer" ? { authorization: `Bearer ${a.token}` } : a.mode === "api-key" ? { [a.header]: a.key } : {}; }
  async testConnection(): Promise<ConnectionTestResult> {
    const r = await this.getRate("USD", "EUR", new Date(Date.now() - 86_400_000 * 3).toISOString().slice(0, 10));
    return { ok: true, message: r ? `Provider answered: USD/EUR ${r.rate} on ${r.date}` : "Provider reachable but returned no rate for the probe date; check ratePath / datePath" };
  }
  async getRate(base: string, quote: string, date: string): Promise<FxRateRecord | null> {
    const b = assertCurrency(base), q = assertCurrency(quote);
    const r = await httpJson<unknown>(this.url(b, q, date), { headers: this.headers() }, { provider: "fx-http", operation: "rate", fetchImpl: this.cfg.fetchImpl, notFoundOk: true });
    if (r.status === 404) return null;
    const rate = getPath(r.body, this.cfg.ratePath.replace("{quote}", q).replace("{base}", b));
    const n = Number(rate);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = this.cfg.datePath ? String(getPath(r.body, this.cfg.datePath) ?? "") : date;
    if (d.slice(0, 10) !== date) return null; // a rate for another day is not this day's rate
    return { base: b, quote: q, rate: String(n), date, provider: this.provider, fetchedAt: new Date().toISOString() };
  }
}

export class MockFxProvider implements FxRateProvider {
  readonly provider = "mock";
  constructor(private scenario: import("../core/mock").MockScenario = "ok", private table: Record<string, string> = { "USD/EUR": "0.92150000", "EUR/USD": "1.08520000", "USD/GBP": "0.78400000", "USD/CAD": "1.36100000", "USD/JPY": "151.20000000" }) {}
  async testConnection(): Promise<ConnectionTestResult> { const { scenarioGate } = await import("../core/mock"); scenarioGate(this.scenario, "FX"); return { ok: true, message: `MOCK FX: ${Object.keys(this.table).length} pairs (no real feed)` }; }
  async getRate(base: string, quote: string, date: string): Promise<FxRateRecord | null> {
    const { scenarioGate, malformed } = await import("../core/mock");
    scenarioGate(this.scenario, "FX");
    if (this.scenario === "malformed") malformed("FX");
    if (this.scenario === "empty") return null;
    const b = assertCurrency(base), q = assertCurrency(quote);
    if (b === q) return { base: b, quote: q, rate: "1", date, provider: "mock", fetchedAt: new Date().toISOString() };
    const r = this.table[`${b}/${q}`] ?? (this.table[`${q}/${b}`] ? (1 / Number(this.table[`${q}/${b}`])).toFixed(8) : null);
    // weekends have no rate — like a real feed
    if (!r || [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return null;
    return { base: b, quote: q, rate: r, date, provider: "mock", fetchedAt: new Date().toISOString() };
  }
}

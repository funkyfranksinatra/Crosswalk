/**
 * The one HTTP path every live adapter uses: timeouts, retries with exponential backoff and
 * Retry-After, status → error category, and a structured log line per call that records the
 * provider, operation, status, duration and attempt — never headers or bodies. Tests replace
 * `fetch` per provider with `setIntegrationFetchForTests`.
 */
import { log } from "@/lib/log";
import { AuthenticationError, AuthorizationError, IntegrationError, ProviderUnavailableError, RateLimitError, TimeoutError, ValidationError, asIntegrationError, redactMessage } from "./errors";

export type HttpOptions = {
  provider: string;
  operation: string;
  timeoutMs?: number;
  /** retries on RATE_LIMIT / PROVIDER_UNAVAILABLE / TIMEOUT (default 2 → three attempts) */
  retries?: number;
  /** statuses that count as retryable besides 429 and 5xx */
  retryStatuses?: number[];
  /** treat a 404 as an empty result rather than an error */
  notFoundOk?: boolean;
  fetchImpl?: typeof fetch;
};

export type HttpResult<T> = { status: number; headers: Headers; body: T; providerRef: string | null; attempts: number; ms: number };

const fetches = new Map<string, typeof fetch>();
/** Test seam: route one provider's calls to an in-memory server. */
export function setIntegrationFetchForTests(provider: string, f: typeof fetch | null) {
  if (!process.env.VITEST) throw new Error("test seam");
  if (f) fetches.set(provider, f); else fetches.delete(provider);
}
export function fetchFor(provider: string, override?: typeof fetch): typeof fetch {
  return override ?? fetches.get(provider) ?? ((...a) => fetch(...a));
}

const DEFAULT_TIMEOUT = 20_000;

/** Fetch JSON (or text) with the policy above. Throws IntegrationError; never returns a non-2xx. */
export async function httpJson<T = unknown>(url: string | URL, init: RequestInit, opts: HttpOptions): Promise<HttpResult<T>> {
  const f = fetchFor(opts.provider, opts.fetchImpl);
  const retries = opts.retries ?? 2;
  const t0 = Date.now();
  let attempt = 0;
  let last: IntegrationError | null = null;
  const urlStr = typeof url === "string" ? url : url.toString();
  const safeUrl = urlStr.replace(/\?.*$/, "").replace(/(:\/\/[^/\s:@]+:)[^@\s]+@/, "$1[redacted]@");
  while (attempt <= retries) {
    attempt++;
    const started = Date.now();
    try {
      const res = await f(urlStr, { ...init, signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT) });
      const providerRef = res.headers.get("x-request-id") ?? res.headers.get("x-correlation-id") ?? res.headers.get("sfdc-request-id") ?? null;
      const ms = Date.now() - started;
      if (res.ok || (opts.notFoundOk && res.status === 404)) {
        const body = await parseBody<T>(res);
        log.info("integration.http", { provider: opts.provider, operation: opts.operation, url: safeUrl, status: res.status, ms, attempt });
        return { status: res.status, headers: res.headers, body, providerRef, attempts: attempt, ms: Date.now() - t0 };
      }
      const err = await classify(res, opts, providerRef);
      log.warn("integration.http_error", { provider: opts.provider, operation: opts.operation, url: safeUrl, status: res.status, ms, attempt, category: err.category, providerRef });
      last = err;
      if (!err.retryable || attempt > retries) throw err;
      await sleep(backoff(attempt, err instanceof RateLimitError ? err.retryAfterMs : null));
    } catch (e) {
      const err = e instanceof IntegrationError ? e : asIntegrationError(e);
      if (!(e instanceof IntegrationError)) log.warn("integration.http_failed", { provider: opts.provider, operation: opts.operation, url: safeUrl, ms: Date.now() - started, attempt, category: err.category });
      last = err;
      if (!err.retryable || attempt > retries) throw err;
      await sleep(backoff(attempt, null));
    }
  }
  throw last ?? new ProviderUnavailableError("request failed");
}

async function parseBody<T>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  if (/json/i.test(ct) || /^\s*[[{]/.test(text)) {
    try { return JSON.parse(text) as T; } catch { throw new ValidationError("The provider answered with malformed JSON", { retryable: false }); }
  }
  return text as unknown as T;
}

async function classify(res: Response, opts: HttpOptions, providerRef: string | null): Promise<IntegrationError> {
  const detail = await providerMessage(res);
  const suffix = detail ? ` — ${detail}` : "";
  const base = { providerRef, status: res.status };
  if (res.status === 401) return new AuthenticationError(`${opts.provider} rejected the credentials (401)${suffix}`, base);
  if (res.status === 403) return new AuthorizationError(`${opts.provider} refused the request (403): the credential lacks a permission or scope${suffix}`, base);
  if (res.status === 404) return new IntegrationError("NOT_FOUND", `${opts.provider}: ${opts.operation} was not found (404) — check the base URL, service name or object name${suffix}`, { ...base, retryable: false });
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    const ms = ra ? (Number(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : null;
    return new RateLimitError(`${opts.provider} is rate limiting (429)${suffix}`, ms, base);
  }
  if (res.status === 408 || res.status === 504) return new TimeoutError(`${opts.provider} timed out (${res.status})${suffix}`, base);
  if (res.status >= 500 || (opts.retryStatuses ?? []).includes(res.status)) return new ProviderUnavailableError(`${opts.provider} is unavailable (${res.status})${suffix}`, base);
  if (res.status === 400 || res.status === 422) return new ValidationError(`${opts.provider} rejected the request (${res.status})${suffix}`, { ...base, retryable: false });
  return new IntegrationError("UNKNOWN", `${opts.provider} answered ${res.status}${suffix}`, { ...base, retryable: false });
}

/** A short, redacted message from an error body — Salesforce, SAP and most REST APIs put one in JSON. */
async function providerMessage(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).slice(0, 2000);
    let msg: string | null = null;
    try {
      const j = JSON.parse(text) as unknown;
      const pick = (o: unknown): string | null => {
        if (!o) return null;
        if (Array.isArray(o)) return pick(o[0]);
        if (typeof o === "object") { const r = o as Record<string, unknown>; for (const k of ["message", "error_description", "errorCode", "error", "Message"]) { const v = r[k]; if (typeof v === "string") return v; if (v && typeof v === "object") { const inner = pick(v); if (inner) return inner; } } }
        return null;
      };
      msg = pick(j);
    } catch { msg = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null; }
    return msg ? redactMessage(msg).slice(0, 300) : null;
  } catch { return null; }
}

export function backoff(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) return Math.min(retryAfterMs, 60_000);
  const base = 400 * 2 ** (attempt - 1);
  return Math.min(15_000, base / 2 + Math.random() * base / 2); // equal jitter
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

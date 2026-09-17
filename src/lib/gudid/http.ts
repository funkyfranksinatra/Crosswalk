/**
 * The one HTTP path to openFDA. Two protections every caller gets for free:
 *
 *  1. A per-process token bucket sized to openFDA's published limits — 240 requests/min
 *     without a key, 1,000/min with `OPENFDA_API_KEY` — run at 80 % so bursts from a
 *     whole-labeler import never trip the limit in the first place. `OPENFDA_RPM`
 *     overrides it (lower it when several processes share one key).
 *  2. Exponential backoff with jitter on 429 and 5xx, honouring `Retry-After` when
 *     openFDA sends one, up to `OPENFDA_MAX_ATTEMPTS` (default 5). 4xx other than 429
 *     (and 404, which openFDA uses for "no results") are not retried.
 *
 * Every call is counted for /api/metrics. Test hook: `setFetchForTests` replaces fetch
 * so the recorded-fixture suite runs without the network.
 */
import { openFdaRequests, openFdaWait } from "@/lib/observability/metrics";
import { log } from "@/lib/log";

export type OpenFdaResponse = { status: number; json: unknown; attempts: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  /** Nobody in this process calls openFDA before this time (a 429's Retry-After applies to everyone). */
  pausedUntil = 0;
  constructor(private capacity: number, private perMs: number) { this.tokens = capacity; }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
  }
  /** Resolves when a token is available and no pause is in force; returns the wait in ms. */
  async take(): Promise<number> {
    const t0 = Date.now();
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) { await sleep(Math.min(this.pausedUntil - now, 1000)); continue; }
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return Date.now() - t0; }
      const wait = Math.max(5, Math.ceil((1 - this.tokens) / this.perMs));
      await sleep(Math.min(wait, 1000));
    }
  }
  /** Externally observed throttling: empty the bucket and hold every caller for `ms`. */
  drain(ms = 0) { this.tokens = 0; this.last = Date.now(); this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
  get available() { this.refill(); return this.tokens; }
}

export function rpmLimit(): number {
  const env = Number(process.env.OPENFDA_RPM);
  if (Number.isFinite(env) && env > 0) return env;
  return Math.floor((process.env.OPENFDA_API_KEY ? 1000 : 240) * 0.8);
}

let bucket: TokenBucket | null = null;
let bucketRpm = 0;
function getBucket() {
  const rpm = rpmLimit();
  if (!bucket || bucketRpm !== rpm) { bucket = new TokenBucket(Math.max(1, Math.round(rpm / 6)), rpm / 60_000); bucketRpm = rpm; }
  return bucket;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
export function setFetchForTests(f: FetchLike | null) { fetchImpl = f ?? ((url, init) => fetch(url, init)); }

function withKey(url: string) {
  const key = process.env.OPENFDA_API_KEY;
  if (!key || url.includes("api_key=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export class OpenFdaError extends Error {
  constructor(public status: number, message: string, public attempts: number) { super(message); this.name = "OpenFdaError"; }
}

/**
 * GET an openFDA URL (without the api key — it is appended here so it never appears in
 * logs or in callers). Returns the parsed body; 404 is returned as status 404 with
 * `json: null` because openFDA answers 404 for an empty result set.
 */
export async function openFdaGet(url: string, opts: { maxAttempts?: number } = {}): Promise<OpenFdaResponse> {
  const maxAttempts = opts.maxAttempts ?? Number(process.env.OPENFDA_MAX_ATTEMPTS ?? 5);
  const baseDelay = Number(process.env.OPENFDA_RETRY_BASE_MS ?? 1000);
  let lastErr: string = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const waited = await getBucket().take();
    if (waited > 0) openFdaWait.observe({}, waited / 1000);
    let res: Response;
    try {
      res = await fetchImpl(withKey(url), { headers: { accept: "application/json" }, cache: "no-store" });
    } catch (e) {
      // Network failure: retry like a 5xx.
      lastErr = e instanceof Error ? e.message : String(e);
      openFdaRequests.inc({ outcome: "error" });
      if (attempt < maxAttempts) { await sleep(backoff(baseDelay, attempt)); continue; }
      throw new OpenFdaError(0, `openFDA unreachable: ${lastErr}`, attempt);
    }
    if (res.status === 404) { openFdaRequests.inc({ outcome: "ok" }); return { status: 404, json: null, attempts: attempt }; }
    if (res.status === 429 || res.status >= 500) {
      openFdaRequests.inc({ outcome: res.status === 429 ? "rate_limited" : "server_error" });
      lastErr = `openFDA ${res.status}`;
      const ra = retryAfterMs(res);
      // A 429 pauses the whole process for the Retry-After window (or a floor), not just this caller.
      if (res.status === 429) getBucket().drain(Math.min(ra ?? Math.max(5_000, backoff(baseDelay, attempt)), 120_000));
      if (attempt < maxAttempts) {
        const delay = Math.min(ra ?? backoff(baseDelay, attempt), 120_000);
        log.warn("openfda.retry", { status: res.status, attempt, delayMs: Math.round(delay), retryAfter: ra !== null });
        await sleep(delay);
        continue;
      }
      throw new OpenFdaError(res.status, `${lastErr} after ${attempt} attempts`, attempt);
    }
    if (!res.ok) {
      openFdaRequests.inc({ outcome: "client_error" });
      throw new OpenFdaError(res.status, `openFDA ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, attempt);
    }
    openFdaRequests.inc({ outcome: "ok" });
    try {
      return { status: res.status, json: await res.json(), attempts: attempt };
    } catch (e) {
      // A 200 that is not JSON (an HTML error page from a proxy) is a server-side fault: retry like a 5xx.
      lastErr = `openFDA returned a non-JSON body: ${e instanceof Error ? e.message : String(e)}`;
      openFdaRequests.inc({ outcome: "server_error" });
      if (attempt < maxAttempts) { await sleep(Math.min(backoff(baseDelay, attempt), 120_000)); continue; }
      throw new OpenFdaError(res.status, lastErr, attempt);
    }
  }
  throw new OpenFdaError(0, lastErr || "openFDA: no attempts made", 0);
}

/** Equal jitter: random in [max/2, max] with max = base * 2^(attempt-1), capped — never an instant retry. */
export function backoff(baseMs: number, attempt: number, capMs = 60_000): number {
  const max = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return max / 2 + Math.random() * (max / 2);
}

/** For the health endpoint / tests. */
export function bucketState() {
  const b = getBucket();
  return { rpm: bucketRpm, available: Math.floor(b.available), pausedForMs: Math.max(0, b.pausedUntil - Date.now()) };
}

/**
 * Integration errors carry a category the UI and the sync runner act on, a message that
 * names what to fix, and never a credential, header or payload. `retryable` tells the runner
 * whether a repeat attempt makes sense; `providerRef` is the provider's own request id when
 * it gives one (safe to show, useful to their support).
 */
export const ERROR_CATEGORIES = ["AUTHENTICATION", "AUTHORIZATION", "CONFIGURATION", "MAPPING", "VALIDATION", "RATE_LIMIT", "PROVIDER_UNAVAILABLE", "TIMEOUT", "DATA_CONFLICT", "NOT_FOUND", "UNKNOWN"] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export class IntegrationError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly providerRef: string | null;
  readonly status: number | null;
  readonly details: Record<string, unknown> | null;
  constructor(category: ErrorCategory, message: string, opts: { retryable?: boolean; providerRef?: string | null; status?: number | null; details?: Record<string, unknown> | null; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = `IntegrationError:${category}`;
    this.category = category;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(category);
    this.providerRef = opts.providerRef ?? null;
    this.status = opts.status ?? null;
    this.details = opts.details ?? null;
  }
  toJSON() { return { category: this.category, message: this.message, retryable: this.retryable, providerRef: this.providerRef, status: this.status, details: this.details }; }
}

const RETRYABLE_BY_DEFAULT = new Set<ErrorCategory>(["RATE_LIMIT", "PROVIDER_UNAVAILABLE", "TIMEOUT"]);

export class AuthenticationError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("AUTHENTICATION", message, opts); } }
export class AuthorizationError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("AUTHORIZATION", message, opts); } }
export class ConfigurationError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("CONFIGURATION", message, opts); } }
export class MappingError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("MAPPING", message, opts); } }
export class ValidationError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("VALIDATION", message, opts); } }
export class RateLimitError extends IntegrationError { retryAfterMs: number | null; constructor(message: string, retryAfterMs: number | null = null, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("RATE_LIMIT", message, opts); this.retryAfterMs = retryAfterMs; } }
export class ProviderUnavailableError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("PROVIDER_UNAVAILABLE", message, opts); } }
export class TimeoutError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("TIMEOUT", message, opts); } }
export class DataConflictError extends IntegrationError { constructor(message: string, opts?: ConstructorParameters<typeof IntegrationError>[2]) { super("DATA_CONFLICT", message, opts); } }

/** Anything → IntegrationError, so callers can rely on a category. */
export function asIntegrationError(e: unknown, fallback: ErrorCategory = "UNKNOWN"): IntegrationError {
  if (e instanceof IntegrationError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return new TimeoutError("The provider did not answer in time", { cause: e });
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed/i.test(msg)) return new ProviderUnavailableError(`The provider could not be reached (${msg.replace(/^.*?(E[A-Z_]+).*$/, "$1")})`, { cause: e });
  return new IntegrationError(fallback, redactMessage(msg), { cause: e, retryable: false });
}

/** Strip anything that looks like a credential from free text before it reaches a log, a job row or a user. */
export function redactMessage(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/(basic\s+)[A-Za-z0-9+/=]{8,}/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|client[_-]?secret|password|passwd|secret|token|private[_-]?key|authorization)\s*[=:]\s*)["']?[^\s"'&,;]{4,}/gi, "$1[redacted]")
    .replace(/\b(sk|npg|xox[a-z]|ghp)_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/(:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[redacted]@");
}

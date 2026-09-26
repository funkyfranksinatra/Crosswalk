/**
 * Redaction for rows that leave the server as operational data (the NDJSON export, job detail,
 * failure lists). Stored error strings can carry whatever an upstream system put in them — a
 * provider's message quoting the credential it rejected, a connection string in a driver error —
 * so every string value is passed through the same scrubber the integration layer applies to
 * its own messages, and any key that names a secret is masked whatever its value.
 */
import { redactMessage } from "@/lib/integrations/core/errors";

const SECRET_KEY = /(password|passwd|secret|(^|[_-])token$|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|cookie|connection[_-]?string|database[_-]?url|webhook[_-]?url|smtp[_-]?url|private[_-]?key)/i;
/** Values that look like credentials even under an innocent key. */
const SECRET_VALUE = /^(sk-[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\/\S+:\S+@|Bearer\s+\S+|smtps?:\/\/\S+:\S+@)/i;

export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return SECRET_VALUE.test(v) ? "[redacted]" : redactMessage(v);
  if (depth >= 6 || v === null || typeof v !== "object") return v;
  if (v instanceof Date) return v;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (typeof (v as { toString?: unknown }).toString === "function" && (v as object).constructor?.name === "Decimal") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? (x ? "[redacted]" : x) : redactValue(x, depth + 1);
  return out;
}

/** One exported row (LlmCall, SyncLog, FeedRun, Alert, Request, job failure) with nothing secret-shaped left in it. */
export function redactRecord<T extends Record<string, unknown>>(row: T): T {
  return redactValue(row) as T;
}

/**
 * Make Prisma results safe to send to client components / JSON: Decimal → number
 * (display only — never do arithmetic on these), Date → ISO string.
 * Contractual figures are computed server-side in src/lib/money.ts before they get here.
 */
export function plain<T>(value: T): T {
  return walk(value) as T;
}

function isDecimalLike(v: unknown): v is { toNumber(): number } {
  return typeof v === "object" && v !== null && typeof (v as { toNumber?: unknown }).toNumber === "function" && typeof (v as { toFixed?: unknown }).toFixed === "function";
}

function walk(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (isDecimalLike(v)) return v.toNumber();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(walk);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
    return out;
  }
  return v;
}

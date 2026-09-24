import { outboundUrlProblem } from "@/lib/security/urls";
/**
 * How a provider describes its configuration. The registry lists FieldSpecs per provider;
 * the Settings UI renders them, the API validates against them, and `secret: true` fields are
 * stored encrypted and never echoed back. Nothing else in the application needs to know a
 * provider's settings by name.
 */
export type FieldType = "text" | "url" | "secret" | "select" | "number" | "boolean" | "json" | "cron" | "textarea" | "multiline-secret";

export type FieldSpec = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  secret?: boolean;
  /** shown under the field */
  help?: string;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  /** groups fields in the UI */
  group?: string;
  /** validate a value; return a message to reject it */
  validate?: (value: unknown) => string | null;
};

export type ValidationResult = { ok: boolean; errors: { field: string; message: string }[] };

/** Validate non-secret config values against the specs (secrets are validated on presence only). */
export function validateConfig(values: Record<string, unknown>, specs: FieldSpec[], secretsPresent: Set<string>): ValidationResult {
  const errors: { field: string; message: string }[] = [];
  for (const f of specs) {
    const v = f.secret ? undefined : values[f.name];
    const present = f.secret ? secretsPresent.has(f.name) : v !== undefined && v !== null && String(v).trim() !== "";
    if (f.required && !present) { errors.push({ field: f.name, message: `${f.label} is required` }); continue; }
    if (!present || f.secret) continue;
    switch (f.type) {
      case "url": { const p = outboundUrlProblem(String(v)); if (p) errors.push({ field: f.name, message: { scheme: `${f.label} must be an http(s) URL`, credentials: `${f.label} must not embed credentials`, host: `${f.label} has no host`, private: `${f.label} must not point at a loopback, link-local, private or metadata address`, unparsable: `${f.label} is not a valid URL` }[p] }); break; }
      case "number": if (!Number.isFinite(Number(v))) errors.push({ field: f.name, message: `${f.label} must be a number` }); break;
      case "boolean": if (typeof v !== "boolean" && !/^(true|false)$/i.test(String(v))) errors.push({ field: f.name, message: `${f.label} must be true or false` }); break;
      case "select": if (f.options && !f.options.some((o) => o.value === String(v))) errors.push({ field: f.name, message: `${f.label} must be one of ${f.options.map((o) => o.value).join(", ")}` }); break;
      case "json": if (typeof v === "string") { try { JSON.parse(v); } catch { errors.push({ field: f.name, message: `${f.label} must be valid JSON` }); } } break;
      case "cron": if (String(v) !== "off" && !/^(\S+\s+){4}\S+$/.test(String(v).trim())) errors.push({ field: f.name, message: `${f.label} must be a 5-field cron expression or "off"` }); break;
      default: break;
    }
    if (f.validate) { const m = f.validate(v); if (m) errors.push({ field: f.name, message: m }); }
  }
  return { ok: errors.length === 0, errors };
}

/** Keep only known non-secret fields, coerced to their declared type; a blank field takes its declared default (what the form showed). */
export function normalizeConfig(values: Record<string, unknown>, specs: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of specs) {
    if (f.secret) continue;
    let v = values[f.name];
    if (v === undefined || v === null || v === "") v = f.default;
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "number") out[f.name] = Number(v);
    else if (f.type === "boolean") out[f.name] = typeof v === "boolean" ? v : /^true$/i.test(String(v));
    else if (f.type === "json") out[f.name] = typeof v === "string" ? JSON.parse(v) : v;
    else out[f.name] = String(v).trim();
  }
  return out;
}

/** The public shape of a spec (no validators) for the UI. */
export function publicFieldSpec(f: FieldSpec) {
  const { validate: _v, ...rest } = f; void _v;
  return rest;
}

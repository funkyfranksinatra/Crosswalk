/**
 * The mapping engine. A provider hands over raw records (Salesforce sObjects, OData entities,
 * spreadsheet rows); a FieldMap — stored per company in IntegrationConfig.mappingJson — says
 * which source path feeds which canonical field and how to transform it. The MappingSpec of
 * a canonical entity says which fields exist, which are required and what type they are, so
 * a mapping can be validated before the first sync (and against the provider's own field
 * list when the adapter can describe it).
 *
 *   { "accountNumber": { "source": "AccountNumber" },
 *     "gpoName":       { "source": "GPO__c" },
 *     "isStrategic":   { "source": "Strategic_Account__c", "transform": "bool" },
 *     "type":          { "source": "Type", "valueMap": { "Hospital": "SOLD_TO", "IDN": "IDN" }, "default": "SOLD_TO" },
 *     "territory":     { "source": "Owner.Territory__c" } }
 *
 * Source paths are dotted; a missing path is `undefined` (not an error unless required).
 * A `constant` entry supplies a fixed value. Transforms are a closed list — no expressions.
 */

export type Transform = "trim" | "upper" | "lower" | "number" | "money" | "bool" | "date" | "datetime" | "int" | "split" | "first" | "join" | "digits";

export type FieldRule = {
  source?: string;
  constant?: string | number | boolean | null;
  transform?: Transform | Transform[];
  valueMap?: Record<string, string | number | boolean | null>;
  /** what to do when the source value is not in valueMap: keep it (default), drop it, or fail */
  unmapped?: "keep" | "null" | "error";
  default?: string | number | boolean | null;
  required?: boolean;
  /** for split/join */
  separator?: string;
};
export type FieldMap = Record<string, FieldRule>;

export type CanonicalFieldType = "string" | "number" | "money" | "boolean" | "date" | "datetime" | "string[]" | "enum";
export type CanonicalField = { name: string; type: CanonicalFieldType; required?: boolean; description: string; values?: readonly string[]; example?: string };
export type MappingSpec = { entity: string; fields: CanonicalField[] };

export type MappingIssue = { field: string; level: "error" | "warning"; message: string };
export type Mapped<T> = { record: T; issues: MappingIssue[] };

export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj as object, path)) return (obj as Record<string, unknown>)[path];
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    const rec = cur as Record<string, unknown>;
    // case-insensitive fallback for spreadsheet headers
    cur = seg in rec ? rec[seg] : rec[Object.keys(rec).find((k) => k.toLowerCase() === seg.toLowerCase()) ?? seg];
  }
  return cur;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function applyTransform(value: unknown, t: Transform, sep = ","): unknown {
  if (value === undefined || value === null) return value;
  const s = typeof value === "string" ? value : Array.isArray(value) ? value : String(value);
  switch (t) {
    case "trim": return typeof s === "string" ? s.trim() : s;
    case "upper": return typeof s === "string" ? s.trim().toUpperCase() : s;
    case "lower": return typeof s === "string" ? s.trim().toLowerCase() : s;
    case "digits": return typeof s === "string" ? s.replace(/\D+/g, "") : s;
    case "number": case "money": {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const n = Number(String(s).replace(/[^0-9.+-]/g, "").replace(/(?!^)-/g, ""));
      return Number.isFinite(n) && String(s).trim() !== "" ? n : null;
    }
    case "int": { const n = applyTransform(value, "number"); return n === null ? null : Math.trunc(n as number); }
    case "bool": { if (typeof value === "boolean") return value; const v = String(s).trim().toLowerCase(); if (["true", "yes", "y", "1", "x", "active"].includes(v)) return true; if (["false", "no", "n", "0", "", "inactive"].includes(v)) return false; return null; }
    case "date": case "datetime": {
      if (value instanceof Date) return value.toISOString().slice(0, t === "date" ? 10 : 24);
      if (typeof value === "number") { const d = new Date(EXCEL_EPOCH + value * 86_400_000); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, t === "date" ? 10 : 24) : null; }
      const str = String(s).trim();
      if (!str) return null;
      // /Date(1700000000000)/ (OData v2), yyyymmdd (SAP), ISO, m/d/yyyy
      const od = str.match(/^\/Date\((-?\d+)\)\/$/); if (od) return new Date(Number(od[1])).toISOString().slice(0, t === "date" ? 10 : 24);
      const sap = str.match(/^(\d{4})(\d{2})(\d{2})$/); if (sap) return `${sap[1]}-${sap[2]}-${sap[3]}${t === "date" ? "" : "T00:00:00.000Z"}`;
      const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (us) { const iso = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`; return t === "date" ? iso : `${iso}T00:00:00.000Z`; }
      const d = new Date(str); if (!Number.isFinite(d.getTime())) return null;
      return t === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case "split": return typeof s === "string" ? s.split(sep).map((x) => x.trim()).filter(Boolean) : s;
    case "first": return Array.isArray(s) ? s[0] ?? null : s;
    case "join": return Array.isArray(s) ? s.join(sep) : s;
  }
}

/** Apply a FieldMap to one raw record. Missing required fields and type failures are issues, never exceptions. */
export function applyMapping<T = Record<string, unknown>>(raw: unknown, map: FieldMap, spec: MappingSpec): Mapped<T> {
  const out: Record<string, unknown> = {};
  const issues: MappingIssue[] = [];
  for (const f of spec.fields) {
    const rule = map[f.name];
    let value: unknown;
    if (rule) {
      value = rule.constant !== undefined ? rule.constant : rule.source ? getPath(raw, rule.source) : undefined;
      if (typeof value === "string") value = value.trim();
      if (value === "" ) value = undefined;
      for (const t of rule.transform ? ([] as Transform[]).concat(rule.transform) : []) value = applyTransform(value, t, rule.separator);
      if (rule.valueMap && value !== undefined && value !== null) {
        const key = String(value);
        const hit = Object.keys(rule.valueMap).find((k) => k === key) ?? Object.keys(rule.valueMap).find((k) => k.toLowerCase() === key.toLowerCase());
        if (hit !== undefined) value = rule.valueMap[hit];
        else if (rule.unmapped === "null") value = undefined;
        else if (rule.unmapped === "error") { issues.push({ field: f.name, level: "error", message: `value "${key}" is not in the value map for ${f.name}` }); value = undefined; }
      }
      if ((value === undefined || value === null) && rule.default !== undefined) value = rule.default;
    }
    if (value === undefined || value === null) {
      if (f.required || rule?.required) issues.push({ field: f.name, level: "error", message: `${f.name} is required${rule?.source ? ` (source "${rule.source}" was empty)` : " and has no mapping"}` });
      continue;
    }
    const typed = coerce(value, f);
    if (typed.error) { issues.push({ field: f.name, level: "error", message: typed.error }); continue; }
    out[f.name] = typed.value;
  }
  return { record: out as T, issues };
}

function coerce(value: unknown, f: CanonicalField): { value?: unknown; error?: string } {
  switch (f.type) {
    case "string": return { value: typeof value === "string" ? value : String(value) };
    case "number": case "money": { const n = typeof value === "number" ? value : applyTransform(value, "number"); return n === null || n === undefined ? { error: `${f.name}: "${String(value)}" is not a number` } : { value: f.type === "money" ? String(n) : n }; }
    case "boolean": { const b = applyTransform(value, "bool"); return b === null ? { error: `${f.name}: "${String(value)}" is not a yes/no value` } : { value: b }; }
    case "date": case "datetime": { const d = applyTransform(value, f.type); return d === null ? { error: `${f.name}: "${String(value)}" is not a date` } : { value: d }; }
    case "string[]": return { value: Array.isArray(value) ? value.map(String) : [String(value)] };
    case "enum": { const v = String(value).toUpperCase(); return f.values && !f.values.includes(v) ? { error: `${f.name}: "${String(value)}" is not one of ${f.values.join(", ")}` } : { value: v }; }
  }
}

/**
 * Validate a mapping before syncing: every required canonical field mapped, no unknown targets,
 * transforms known, and — when the provider can list its fields — every source path present.
 */
export function validateMapping(map: FieldMap, spec: MappingSpec, sourceFields?: string[] | null): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const known = new Set(spec.fields.map((f) => f.name));
  for (const [target, rule] of Object.entries(map)) {
    if (!known.has(target)) { issues.push({ field: target, level: "warning", message: `"${target}" is not a field of ${spec.entity}; it will be ignored` }); continue; }
    if (rule.source === undefined && rule.constant === undefined) issues.push({ field: target, level: "error", message: `${target} needs a source path or a constant` });
    for (const t of rule.transform ? ([] as Transform[]).concat(rule.transform) : []) if (!TRANSFORMS.has(t)) issues.push({ field: target, level: "error", message: `${target}: unknown transform "${t}"` });
    if (rule.source && sourceFields && sourceFields.length) {
      const head = rule.source.split(".")[0];
      const lower = sourceFields.map((s) => s.toLowerCase());
      if (!lower.includes(rule.source.toLowerCase()) && !lower.includes(head.toLowerCase())) issues.push({ field: target, level: "error", message: `source field "${rule.source}" does not exist on ${spec.entity}'s provider object` });
    }
  }
  for (const f of spec.fields) if (f.required && !map[f.name]) issues.push({ field: f.name, level: "error", message: `${f.name} is required but has no mapping` });
  return issues;
}
const TRANSFORMS = new Set<string>(["trim", "upper", "lower", "number", "money", "bool", "date", "datetime", "int", "split", "first", "join", "digits"]);

/** Merge a company's overrides over a provider's default mapping (override wins per field). */
export function mergeMapping(defaults: FieldMap, overrides: FieldMap | null | undefined): FieldMap {
  return { ...defaults, ...(overrides ?? {}) };
}

/** A per-entity mapping bundle as stored in mappingJson: { entity: FieldMap }. */
export type MappingBundle = Record<string, FieldMap>;
export function parseMappingBundle(json: string | null | undefined): MappingBundle {
  if (!json) return {};
  try { const v = JSON.parse(json) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as MappingBundle) : {}; } catch { return {}; }
}

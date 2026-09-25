/**
 * Access-product profile: the structured, provenance-tagged attributes of a trocar-family product
 * (docs/MATCH_QUALITY_MODEL.md §2–3). Built from several texts in priority order — each field is
 * filled by the first source that states it, later sources only fill gaps, and a later source
 * that disagrees is recorded as a conflict rather than silently ignored.
 *
 * The size parser is deliberately literal about what a number means: "5–12 mm" is an instrument
 * range (the port is 12 mm), "2/3 mm" is a set of two port sizes, "12 x 100 mm" is diameter and
 * length, "100 mm x 12 mm" the same in Ethicon's order, "for instruments up to 11 mm" a range
 * maximum, "6 EA/BX" nothing at all.
 */
import { componentOf, type Component } from "./component";
import { brandAssertions, skuAssertion, type BrandAssertion, type Fixation, type Tip, type Visualization } from "./brands";

export type EvidenceSource = "curated-spec" | "gudid:size" | "gudid:description" | "gudid:siblings" | "intake:description" | "catalog:description" | "brand" | "sku" | "bin";

export type SizeParse = {
  diameters: number[];
  range: { min: number; max: number } | null;
  /** true when no explicit size was stated and the diameter was taken as the range maximum */
  diameterFromRange: boolean;
  lengthMm: number | null;
  lengthClass: LengthClass | null;
  notes: string[];
};
export type LengthClass = "short" | "standard" | "long";

const MM = "(?:mm|millimet(?:er|re)s?)";
/** Centimetres appear on lengths ("10 cm length", "12 mm x 10 cm"); converted to mm, accepted for 3–20 cm (an access length, not an instrument). */
const CM = "(?:cm|centimet(?:er|re)s?)";
const NUM = "(\\d+(?:\\.\\d+)?)";

function normalise(text: string): string {
  return text
    .replace(/[™®©]/g, "")
    .replace(/[×✕]/g, "x")
    .replace(/[–—‐‑‒−]/g, "-")
    .replace(/\bMM\b/g, "mm")
    .replace(/\bMILLIMETERS?\b/gi, "mm")
    .replace(/\s+/g, " ")
    .trim();
}

/** A length in mm from a value + unit label (mm / millimeter, cm / centimeter, in / inch); other units are not lengths. */
export function toMm(value: number, unit: string): number | null {
  if (!Number.isFinite(value)) return null;
  const u = unit.trim().toLowerCase().replace(/[.\s]/g, "");
  if (u === "mm" || u.startsWith("milli")) return value;
  if (u === "cm" || u.startsWith("centi")) return Math.round(value * 100) / 10;
  if (u === "in" || u === '"' || u.startsWith("inch")) return Math.round(value * 254) / 10;
  return null;
}

export function lengthClassOf(mm: number | null | undefined): LengthClass | null {
  if (mm == null || !Number.isFinite(mm)) return null;
  return mm <= 80 ? "short" : mm <= 120 ? "standard" : "long";
}

/** Parse the sizes an access product states about itself. Pure; see the test matrix in tests/unit/access-sizes.test.ts. */
export function parseAccessSizes(raw: string): SizeParse {
  const t = normalise(raw);
  const out: SizeParse = { diameters: [], range: null, diameterFromRange: false, lengthMm: null, lengthClass: null, notes: [] };
  const consumed: [number, number][] = [];
  const taken = (i: number) => consumed.some(([s, e]) => i >= s && i < e);
  const take = (m: RegExpExecArray) => consumed.push([m.index, m.index + m[0].length]);
  const isReducer = (i: number) => /^\s*(?:-\s*)?(?:\d+(?:\.\d+)?\s*(?:\/\s*\d+(?:\.\d+)?)?\s*mm\s*)?(?:reducer|converter|adapter|cap)\b/i.test(t.slice(i, i + 40));
  const addDia = (v: number) => { if (v > 0 && v <= 20 && !out.diameters.includes(v)) out.diameters.push(v); };
  let m: RegExpExecArray | null;

  // 1. Explicit diameter: "Size: 12 mm", "12 mm diameter", "diameter 12 mm", "12 mm dia."
  const explicit = [new RegExp(`\\bsize:?\\s*${NUM}\\s*${MM}`, "gi"), new RegExp(`${NUM}\\s*${MM}\\s*(?:in\\s+)?(?:diam(?:eter)?|dia\\.?|id\\b|od\\b)`, "gi"), new RegExp(`\\b(?:diam(?:eter)?|dia\\.?)\\s*:?\\s*${NUM}\\s*${MM}`, "gi")];
  for (const re of explicit) {
    while ((m = re.exec(t))) { if (taken(m.index) || isReducer(m.index + m[0].length)) continue; const v = parseFloat(m[1]); if (v <= 20) { addDia(v); take(m); } }
  }
  // 2. Explicit length: "100 mm length", "length 100 mm", "100 mm long", "10 cm length"
  const lengthRe = [new RegExp(`${NUM}\\s*(${MM}|${CM})\\s*(?:in\\s+)?(?:length|long|lg\\b|working length|cannula length)`, "gi"), new RegExp(`\\b(?:length|working length|cannula length)\\s*:?\\s*${NUM}\\s*(${MM}|${CM})`, "gi")];
  const asMm = (raw: number, unit: string) => (new RegExp(`^${CM}$`, "i").test(unit) ? (raw >= 3 && raw <= 20 ? raw * 10 : NaN) : raw);
  for (const re of lengthRe) while ((m = re.exec(t))) { if (taken(m.index)) continue; const v = asMm(parseFloat(m[1]), m[2]); if (v >= 30 && v <= 400 && out.lengthMm == null) { out.lengthMm = v; take(m); } }

  // 3. Pairs "12 x 100 mm", "12mm x 100mm", "100 mm x 12 mm", "5x95", "12 mm x 10 cm"
  const pairRe = new RegExp(`${NUM}\\s*(${MM}|${CM})?\\s*x\\s*${NUM}\\s*(${MM}|${CM})?`, "gi");
  while ((m = pairRe.exec(t))) {
    if (taken(m.index)) continue;
    const a = asMm(parseFloat(m[1]), m[2] ?? "mm"), b = asMm(parseFloat(m[3]), m[4] ?? "mm");
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    // "Round 12 cm x 1": a unit on the first number and a bare small integer after the x is a pack count.
    if (m[2] && !m[4] && Number.isInteger(parseFloat(m[3])) && parseFloat(m[3]) <= 3) continue;
    const hasUnit = /mm|millimet|cm|centimet/i.test(m[0]) || /\b(?:trocar|cannula|sleeve|port|threaded)\b/i.test(t);
    if (!hasUnit) continue;
    const small = Math.min(a, b), big = Math.max(a, b);
    if (small <= 20 && big >= 30 && big >= 3 * small) {
      if (!out.diameters.length) addDia(small);
      else if (!out.diameters.includes(small)) out.notes.push(`pair ${m[0].trim()} disagrees with the stated size ${out.diameters.join("/")} mm`);
      if (out.lengthMm == null) out.lengthMm = big;
      take(m);
    }
  }
  // 4. Ranges "5 - 12 mm", "5mm - 12mm", "5-12mm", "instruments up to 11 mm", "5 mm to 12 mm"
  const rangeRe = new RegExp(`${NUM}\\s*(?:${MM})?\\s*(?:-|to)\\s*${NUM}\\s*${MM}`, "gi");
  while ((m = rangeRe.exec(t))) {
    if (taken(m.index) || isReducer(m.index + m[0].length)) continue;
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (a < b && b <= 20 && a >= 1) {
      // "5 - 2/3 mm Reducer" is excluded above; "3 - 5 mm" style ranges only
      if (!out.range) out.range = { min: a, max: b };
      take(m);
    }
  }
  const upToRe = new RegExp(`\\b(?:instruments?\\s+)?up\\s+to\\s+${NUM}\\s*${MM}`, "gi");
  while ((m = upToRe.exec(t))) { if (taken(m.index)) continue; const b = parseFloat(m[1]); if (b <= 20) { if (!out.range) out.range = { min: 1, max: b }; take(m); } }
  // "12 mm trocar" — the size named right before the component noun (after ranges, so "5-10mm Trocar" is the range)
  const nounRe = new RegExp(`${NUM}\\s*${MM}\\s+(?:trocar|cannula|sleeve|port|obturator)s?\\b`, "gi");
  while ((m = nounRe.exec(t))) { if (taken(m.index) || isReducer(m.index + m[0].length)) continue; const v = parseFloat(m[1]); if (v <= 20) { addDia(v); take(m); } }
  // 5. Multi-size "2/3 mm", "2 mm/3 mm", "2mm/3mm", "5/10 mm" — a device sized for both
  const multiRe = new RegExp(`${NUM}\\s*(?:${MM})?\\s*/\\s*${NUM}\\s*${MM}`, "gi");
  while ((m = multiRe.exec(t))) {
    if (taken(m.index) || isReducer(m.index + m[0].length)) continue;
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (a <= 20 && b <= 20 && a > 0 && b > 0) { addDia(a); addDia(b); take(m); }
  }
  // 6. Remaining single values "5 mm", "5mm", "100 mm" (a bare pack count "6 EA/BX" has no unit)
  const singleRe = new RegExp(`${NUM}\\s*${MM}\\b`, "gi");
  while ((m = singleRe.exec(t))) {
    if (taken(m.index) || isReducer(m.index + m[0].length)) continue;
    const v = parseFloat(m[1]);
    const before = t.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 20).toLowerCase();
    if (/thick|gauge|seal\b/.test(before + after)) continue;
    if (v > 20) { if (out.lengthMm == null && v >= 30 && v <= 400) out.lengthMm = v; take(m); continue; }
    if (/\b(?:seal|reducer|converter)\b/.test(after)) { take(m); continue; }
    if (!out.diameters.length) addDia(v);
    else if (!out.diameters.includes(v)) out.notes.push(`also mentions ${v} mm`);
    take(m);
  }
  // 7. The port is sized by the largest instrument it takes when nothing else says so.
  if (!out.diameters.length && out.range) { out.diameters = [out.range.max]; out.diameterFromRange = true; }
  // 8. Length words when no measurement was given
  if (out.lengthMm == null) {
    if (/\b(?:extra[\s-]?long|xl\b|x-?long)/i.test(t)) out.lengthClass = "long";
    else if (/\blong\b/i.test(t)) out.lengthClass = "long";
    else if (/\bshort\b/i.test(t)) out.lengthClass = "short";
    else if (/\bstandard\b/i.test(t)) out.lengthClass = "standard";
  } else out.lengthClass = lengthClassOf(out.lengthMm);
  return out;
}

export type Evidence = { field: string; value: string; source: EvidenceSource; via?: string };

export type AccessProfile = {
  component: Component;
  visualization: Visualization | null;
  tip: Tip | null;
  fixation: Fixation | null;
  lowProfile: boolean | null;
  diameters: number[];
  range: { min: number; max: number } | null;
  lengthMm: number | null;
  lengthClass: LengthClass | null;
  line: string | null;
  manufacturer: string | null;
  /** variant add-ons / packaging present on this product (fascial closure system, dual pack, non-sterile bulk…) */
  extras: string[];
  evidence: Evidence[];
  conflicts: string[];
};

export const emptyProfile = (): AccessProfile => ({ component: "unknown", visualization: null, tip: null, fixation: null, lowProfile: null, diameters: [], range: null, lengthMm: null, lengthClass: null, line: null, manufacturer: null, extras: [], evidence: [], conflicts: [] });

/** One text to read, or the SKU convention step (`source: "sku"`, `text` = the catalog number) placed where its priority belongs. */
export type ProfileSource = { text: string | null | undefined; source: EvidenceSource; sizes?: { type?: string; value?: string; unit?: string }[] | null; dims?: { name: string; value: number; unit: string }[] | null; manufacturer?: string | null; /** GMDN term: read for specific components only */ gmdn?: string | null; /** a ready assertion with its provenance (sibling-family evidence): gap-filling only */ assert?: BrandAssertion | null; via?: string | null };

/** What a GMDN term says about the component — only the specific ones; "laparoscopic access cannula" is generic. */
export function componentFromGmdn(gmdn: string | null | undefined): Component {
  if (!gmdn) return "unknown";
  if (/\bseal\b|\breducer\b|\bcap\b|\bvalve\b/i.test(gmdn)) return "accessory";
  if (/\bneedle\b/i.test(gmdn)) return "insufflation-needle";
  if (/\bobturator\b/i.test(gmdn)) return "obturator";
  return "unknown";
}

function applyAssertion(p: AccessProfile, a: BrandAssertion, source: EvidenceSource, via: string, stated: boolean) {
  const set = <K extends keyof AccessProfile>(k: K, v: AccessProfile[K], label: string) => {
    const cur = p[k];
    const unknown = cur == null || cur === "unknown" || (Array.isArray(cur) && cur.length === 0);
    if (unknown) { (p as Record<string, unknown>)[k] = v; p.evidence.push({ field: k, value: label, source, via }); }
    else if (JSON.stringify(cur) !== JSON.stringify(v) && stated) p.conflicts.push(`${k}: ${label} (${via}) vs ${Array.isArray(cur) ? cur.join("/") : String(cur)}`);
    // The labeler's sibling records agreeing with a value a generic rule assumed turns the assumption into evidence.
    else if (JSON.stringify(cur) === JSON.stringify(v) && source === "gudid:siblings") p.evidence.push({ field: k, value: `${label} (corroborated)`, source, via });
  };
  if (a.component) set("component", a.component, a.component);
  if (a.visualization) set("visualization", a.visualization, a.visualization);
  if (a.tip) set("tip", a.tip, a.tip);
  if (a.fixation) set("fixation", a.fixation, a.fixation);
  if (a.lowProfile != null) set("lowProfile", a.lowProfile, a.lowProfile ? "low profile" : "standard profile");
  if (a.diameterMm?.length) set("diameters", a.diameterMm, `${a.diameterMm.join("/")} mm`);
  if (a.lengthMm != null) { set("lengthMm", a.lengthMm, `${a.lengthMm} mm`); if (p.lengthClass == null) p.lengthClass = lengthClassOf(a.lengthMm); }
  if (a.line) set("line", a.line, a.line);
  if (a.manufacturer) set("manufacturer", a.manufacturer, a.manufacturer);
  for (const x of a.extras ?? []) if (!p.extras.includes(x)) { p.extras.push(x); p.evidence.push({ field: "extras", value: x, source, via }); }
}

/**
 * Build the profile from texts in priority order. Structured sizes (`sizes` from GUDID, `dims`
 * from a curated import) on a source are read before its text. Brand rules read each text before
 * the generic component classifier (they are more specific). A `{ source: "sku" }` entry applies
 * the manufacturer's SKU convention at that point of the order, gap-filling only.
 */
export function buildAccessProfile(sources: ProfileSource[]): AccessProfile {
  const p = emptyProfile();
  const sizeSet = (parse: SizeParse, source: EvidenceSource, via?: string) => {
    if (parse.diameters.length) {
      if (!p.diameters.length) { p.diameters = [...parse.diameters]; p.evidence.push({ field: "diameters", value: `${parse.diameters.join("/")} mm${parse.diameterFromRange ? " (largest of the instrument range)" : ""}`, source, via }); }
      else if (!parse.diameters.some((d) => p.diameters.some((x) => Math.abs(x - d) <= 0.5)) && !parse.diameterFromRange) p.conflicts.push(`diameter: ${parse.diameters.join("/")} mm (${via ?? source}) vs ${p.diameters.join("/")} mm`);
    }
    if (parse.range && !p.range) { p.range = parse.range; p.evidence.push({ field: "range", value: `${parse.range.min}–${parse.range.max} mm instruments`, source, via }); }
    if (parse.lengthMm != null) {
      if (p.lengthMm == null) { p.lengthMm = parse.lengthMm; p.lengthClass = lengthClassOf(parse.lengthMm); p.evidence.push({ field: "length", value: `${parse.lengthMm} mm`, source, via }); }
      else if (Math.abs(p.lengthMm - parse.lengthMm) > 5) p.conflicts.push(`length: ${parse.lengthMm} mm (${via ?? source}) vs ${p.lengthMm} mm`);
    } else if (parse.lengthClass && p.lengthClass == null) { p.lengthClass = parse.lengthClass; p.evidence.push({ field: "length", value: parse.lengthClass, source, via }); }
  };
  for (const s of sources) {
    if (s.source === "sku") {
      const sa = skuAssertion(s.text, s.manufacturer);
      if (sa) applyAssertion(p, sa.assert, "sku", sa.key, true);
      continue;
    }
    if (s.assert) { applyAssertion(p, s.assert, s.source, s.via ?? s.source, false); if (!s.text) continue; }
    // structured sizes first
    const structured: SizeParse = { diameters: [], range: null, diameterFromRange: false, lengthMm: null, lengthClass: null, notes: [] };
    // Structured sizes arrive in whatever unit the source used (GUDID "Centimeter", a curated import that
    // defaulted to cm, an inch label): everything is read in mm.
    for (const z of s.sizes ?? []) {
      const v = toMm(parseFloat(String(z.value ?? "")), String(z.unit ?? "")); if (v == null) continue;
      const type = String(z.type ?? "").toLowerCase();
      if (/diameter|width|size/.test(type) && v <= 20 && !/length/.test(type)) structured.diameters.push(v);
      else if (/length/.test(type) && v >= 30 && v <= 400) structured.lengthMm = v;
    }
    for (const d of s.dims ?? []) {
      const v = toMm(d.value, d.unit); if (v == null) continue;
      if (d.name === "diameter" && v <= 20) structured.diameters.push(v);
      else if (d.name === "length" && v >= 30 && v <= 400) structured.lengthMm = v;
    }
    if (structured.diameters.length || structured.lengthMm != null) { structured.lengthClass = lengthClassOf(structured.lengthMm); sizeSet(structured, s.source, "structured size"); }
    if (s.gmdn && p.component === "unknown") { const c = componentFromGmdn(s.gmdn); if (c !== "unknown") { p.component = c; p.evidence.push({ field: "component", value: c, source: s.source, via: "GMDN term" }); } }
    if (!s.text) continue;
    const text = normalise(s.text);
    sizeSet(parseAccessSizes(text), s.source);
    // Brand rules are ordered specific → generic; the first to set a field wins, later rules do not argue.
    for (const a of brandAssertions(text)) applyAssertion(p, a.assert, "brand", a.key, false);
    if (p.component === "unknown") { const c = componentOf(text); if (c !== "unknown") { p.component = c; p.evidence.push({ field: "component", value: c, source: s.source }); } }
  }
  if (p.lengthClass == null && p.lengthMm != null) p.lengthClass = lengthClassOf(p.lengthMm);
  return p;
}

/** Fill the gaps of `base` from `extra` (the line-level intake description, say); base's evidence wins. */
export function mergeProfiles(base: AccessProfile, extra: AccessProfile): AccessProfile {
  const out: AccessProfile = { ...base, diameters: [...base.diameters], extras: [...new Set([...(base.extras ?? []), ...(extra.extras ?? [])])], evidence: [...base.evidence], conflicts: [...base.conflicts] };
  const fields: (keyof AccessProfile)[] = ["component", "visualization", "tip", "fixation", "lowProfile", "range", "lengthMm", "lengthClass", "line", "manufacturer"];
  for (const k of fields) {
    const cur = out[k];
    const unknown = cur == null || cur === "unknown";
    const v = extra[k];
    if (unknown && v != null && v !== "unknown") { (out as Record<string, unknown>)[k] = v; out.evidence.push(...extra.evidence.filter((e) => e.field === (k === "lengthMm" ? "length" : k))); }
    else if (!unknown && v != null && v !== "unknown" && JSON.stringify(cur) !== JSON.stringify(v) && k !== "lengthClass" && k !== "line" && k !== "manufacturer") out.conflicts.push(`${k}: ${String(v)} (${extra.evidence.find((e) => e.field === (k === "lengthMm" ? "length" : k))?.source ?? "other source"}) vs ${String(cur)}`);
  }
  if (!out.diameters.length && extra.diameters.length) { out.diameters = [...extra.diameters]; out.evidence.push(...extra.evidence.filter((e) => e.field === "diameters")); }
  else if (out.diameters.length && extra.diameters.length && !extra.diameters.some((d) => out.diameters.some((x) => Math.abs(x - d) <= 0.5))) out.conflicts.push(`diameter: ${extra.diameters.join("/")} mm (${extra.evidence.find((e) => e.field === "diameters")?.source ?? "other source"}) vs ${out.diameters.join("/")} mm`);
  if (out.lengthMm != null) out.lengthClass = lengthClassOf(out.lengthMm);
  return out;
}

export function describeProfile(p: AccessProfile): string {
  const bits = [p.component !== "unknown" ? p.component : null, p.visualization, p.tip, p.diameters.length ? `${p.diameters.join("/")} mm` : null, p.lengthMm != null ? `${p.lengthMm} mm` : p.lengthClass, p.fixation, p.lowProfile ? "low profile" : null];
  return bits.filter(Boolean).join(" · ") || "no access attributes";
}

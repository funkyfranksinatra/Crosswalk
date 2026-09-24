/**
 * Brand → feature registry.
 *
 * A brand name is a claim about the product: "OPTIVIEW" is Ethicon's optical-entry bladeless
 * trocar line, "Kii Fios" is Applied Medical's, "Visiport" is ours. GUDID records often carry the
 * brand and nothing else, so the matcher would otherwise not know a 2B12XT is optical. Each rule
 * is data: what text it recognises, what it asserts, where the knowledge comes from, and a note a
 * reviewer can check. Rules assert; the profile builder (access.ts) decides precedence — a rule
 * never overrides a feature the product's own description states.
 *
 * SKU-convention rules (`kind: "sku"`) read a catalog number when the description is silent (an
 * Ethicon `…XT` is the 150 mm length). They are the weakest evidence and are tagged as such.
 */
import type { Component } from "./component";

export type Visualization = "optical" | "non-optical";
export type Tip = "bladeless" | "bladed" | "blunt" | "dilating";
export type Fixation = "fixation" | "smooth" | "balloon";

export type BrandAssertion = {
  component?: Component;
  visualization?: Visualization;
  tip?: Tip;
  fixation?: Fixation;
  lowProfile?: boolean;
  lengthMm?: number;
  diameterMm?: number[];
  /** variant features that make a SKU a different product for a rep (fascial closure system, dual pack, non-sterile bulk, dual cannula) */
  extras?: string[];
  family?: "Trocar Products";
  /** Product line, for the explanation and for grouping siblings */
  line?: string;
  manufacturer?: string;
};

export type BrandRule = {
  key: string;
  kind: "brand" | "sku";
  /** brand rules test the product text; sku rules test the catalog number (uppercased) */
  match: RegExp;
  /** the rule does not fire when the text also matches this (a "Trocar with Stability Sleeve" is not a sleeve SKU) */
  unless?: RegExp;
  assert: BrandAssertion | ((m: RegExpMatchArray) => BrandAssertion);
  provenance: "manufacturer description" | "family knowledge" | "curated mapping";
  note: string;
};

export const BRAND_RULES: BrandRule[] = [
  // ---- Ethicon --------------------------------------------------------------------------
  { key: "ethicon.optiview", kind: "brand", match: /\boptiview\b/i, assert: { visualization: "optical", line: "Endopath Xcel OPTIVIEW", manufacturer: "Ethicon" }, provenance: "manufacturer description", note: "OPTIVIEW Technology is Ethicon's optical-entry (clear tip) line — on bladeless and blunt-tip trocars alike, so the tip comes from the rest of the name" },
  { key: "ethicon.xcel", kind: "brand", match: /\bendopath\s+xcel\b/i, assert: { line: "Endopath Xcel", manufacturer: "Ethicon", family: "Trocar Products", visualization: "non-optical" }, provenance: "manufacturer description", note: "Endopath Xcel is Ethicon's single-use trocar platform; the optical-entry variant is always named OPTIVIEW, so a plain Xcel is non-optical" },
  { key: "ethicon.basx", kind: "brand", match: /\bendopath\s+basx\b/i, assert: { line: "Endopath BASX", manufacturer: "Ethicon", family: "Trocar Products", visualization: "non-optical" }, provenance: "manufacturer description", note: "Endopath BASX is Ethicon's economy (non-optical) trocar line" },
  { key: "ethicon.dilating", kind: "brand", match: /\bdilating\s+tip\b/i, assert: { tip: "dilating", visualization: "non-optical" }, provenance: "manufacturer description", note: "Ethicon Dilating Tip trocars are bladeless (the tip dilates rather than cuts)" },
  { key: "ethicon.sleeve", kind: "brand", match: /\b(?:universal|stability)\s+sleeves?\b/i, unless: /\bwith\s+(?:\w+\s+){0,2}(?:universal|stability)\s+sleeves?\b/i, assert: { component: "cannula" }, provenance: "manufacturer description", note: "Ethicon Universal / Stability Sleeves are cannula-only SKUs (no obturator)" },
  { key: "ethicon.nonshielded", kind: "brand", match: /\bnon-?shielded\b/i, assert: { tip: "bladed" }, provenance: "manufacturer description", note: "Ethicon non-shielded trocars are bladed" },
  // ---- Applied Medical ------------------------------------------------------------------
  { key: "applied.kii-fios", kind: "brand", match: /\bkii\b[^;]*\b(?:fios|optical)\b|\bfios\s+first\s+entry\b/i, assert: { visualization: "optical", tip: "bladeless", component: "trocar", line: "Kii Fios First Entry", manufacturer: "Applied Medical" }, provenance: "manufacturer description", note: "Kii Fios First Entry is Applied Medical's optical-entry bladeless trocar" },
  { key: "applied.kii-optical", kind: "brand", match: /(?<!\bnon[\s-])\boptical\s+access\s+system\b|(?<!\bnon[\s-])\boptical\s+separator\b|\bseparator\s+system\b/i, assert: { visualization: "optical", tip: "bladeless", component: "trocar", manufacturer: "Applied Medical" }, provenance: "manufacturer description", note: "Applied Medical optical access / Optical Separator systems are optical-entry trocars" },
  { key: "applied.kii-bladed", kind: "brand", match: /\bkii\b[^;]*\b(?:shielded\s+)?bladed\b/i, assert: { tip: "bladed", visualization: "non-optical", component: "trocar", manufacturer: "Applied Medical" }, provenance: "manufacturer description", note: "Kii Shielded Bladed access systems are bladed, non-optical trocars" },
  { key: "applied.kii-balloon", kind: "brand", match: /\bballoon\s+blunt[\s-]+tip\b|\bkii\b[^;]*\bballoon\b/i, assert: { tip: "blunt", fixation: "balloon", component: "trocar" }, provenance: "manufacturer description", note: "Kii Balloon Blunt Tip is a Hasson-style blunt trocar with a balloon anchor" },
  { key: "applied.kii-blunt", kind: "brand", match: /\bblunt[\s-]*tip\b(?![^;]*balloon)/i, assert: { tip: "blunt" }, provenance: "manufacturer description", note: "Blunt tip (Hasson) trocars are placed through an open cut-down, not by puncture" },
  { key: "applied.kii-sleeve", kind: "brand", match: /\bkii\b[^;]*\b(?:sleeve|advanced fixation cannula)\b|\badvanced\s+fixation\s+cannula\b/i, assert: { component: "cannula", fixation: "fixation", manufacturer: "Applied Medical" }, provenance: "manufacturer description", note: "Kii Sleeve / Advanced Fixation Cannula SKUs are cannula-only" },
  { key: "applied.kii-access", kind: "brand", match: /\bkii\b[^;]*\baccess\s+system\b|\bkii\b[^;]*\btrocars?\b/i, unless: /\bsleeve\b|\bfixation\s+cannula\b/i, assert: { component: "trocar", manufacturer: "Applied Medical", line: "Kii" }, provenance: "manufacturer description", note: "Kii access systems are complete trocars (cannula + obturator)" },
  { key: "applied.z-thread", kind: "brand", match: /\bz-?threaded?\b/i, assert: { fixation: "fixation" }, provenance: "manufacturer description", note: "Applied Medical Z-Thread is a threaded (fixation) cannula" },
  // ---- Medtronic / Covidien -----------------------------------------------------------------
  { key: "mdt.visiport", kind: "brand", match: /\bvisiport\b/i, assert: { visualization: "optical", tip: "bladed", component: "trocar", extras: ["handle"], line: "Visiport Plus", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "Visiport Plus RPF is an optical trocar with a retractable blade; sized by the 'Size:' field, the 5–11 mm is the instrument range" },
  { key: "mdt.versaone-optical", kind: "brand", match: /\bversaone\b[^;]*(?<!\bnon[\s-])\boptical\b/i, assert: { visualization: "optical", tip: "bladeless", component: "trocar", line: "VersaOne", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "VersaOne Optical is a bladeless optical-entry trocar" },
  { key: "mdt.versaone-universal", kind: "brand", match: /\bversaone\b[^;]*\buniversal\b[^;]*\bcannula\b|\buniversal\s+(?:fixation|smooth|threaded)?\s*cannula\b/i, assert: { component: "cannula", line: "VersaOne Universal Cannula", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "VersaOne Universal Cannula SKUs are cannula-only (used with a VersaOne obturator)" },
  { key: "mdt.versaone-blunt", kind: "brand", match: /\bversaone\b[^;]*\bblunt\s+trocar\b/i, assert: { tip: "blunt", component: "trocar", line: "VersaOne", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "VersaOne Blunt Trocar is the Hasson-style entry" },
  { key: "mdt.versaone", kind: "brand", match: /\bversaone\b/i, assert: { line: "VersaOne", manufacturer: "Medtronic", family: "Trocar Products" }, provenance: "manufacturer description", note: "VersaOne is the current Medtronic single-use trocar platform" },
  // "Versaport Plus Bladeless 12 mm … with fixation cannula" is a complete trocar sold with its cannula (the NB… SKU
  // convention says so too); only a Versaport SKU that IS the sleeve / cannula is cannula-only.
  { key: "mdt.versaport-sleeve", kind: "brand", match: /\bversaport\b[^;]*\b(?:sleeve|cannula)\b/i, unless: /\btrocar\b|\bobturator\b|\bwith\s+(?:\w+\s+){0,3}(?:sleeve|cannula)s?\b/i, assert: { component: "cannula", line: "Versaport", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "Versaport 'Sleeve' / 'Fixation Cannula' SKUs are cannula-only; 'Bladeless … with fixation cannula' is the trocar" },
  { key: "mdt.versaport", kind: "brand", match: /\bversaport\b/i, assert: { line: "Versaport", manufacturer: "Medtronic", family: "Trocar Products" }, provenance: "manufacturer description", note: "Versaport is the legacy Covidien trocar platform" },
  { key: "mdt.versastep", kind: "brand", match: /\bversastep\b|\bmini\s*step\b|\bstep\b[^;]*\bradially\b|radially\s+expand/i, unless: /\bneedle\b|\bveress\b/i, assert: { component: "dilating-system", tip: "bladeless", visualization: "non-optical", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "VersaStep / Step / Mini Step are radially expanding (dilating) access systems — bladeless, blind entry over a needle: a trocar substitute, not an optical one" },
  { key: "mdt.bluntport", kind: "brand", match: /\bbluntport\b/i, assert: { tip: "blunt", component: "trocar", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "Bluntport is the Hasson-style blunt trocar" },
  { key: "mdt.thoracoport", kind: "brand", match: /\bthoracoport\b/i, assert: { tip: "blunt", manufacturer: "Medtronic" }, provenance: "manufacturer description", note: "Thoracoport is a blunt thoracic access port" },
  { key: "mdt.versaseal", kind: "brand", match: /\bversaseal\b/i, unless: /\b(?:trocar|obturator)\b|\bcannula\b(?!\s+seal)/i, assert: { component: "accessory" }, provenance: "manufacturer description", note: "VersaSeal on its own is the cannula seal" },
  // ---- Variant packaging / add-ons (either side only ⇒ a different product, at most Close) ----------
  { key: "variant.fascial-closure", kind: "brand", match: /\bfascial\s+closure\b/i, assert: { extras: ["fascial closure system"] }, provenance: "manufacturer description", note: "a trocar sold with a fascial closure system is a distinct SKU" },
  { key: "variant.dual-pack", kind: "brand", match: /\bdual\s+pack\b|\b2\s*-?\s*pack\b|\btwin\s+pack\b/i, assert: { extras: ["dual pack"] }, provenance: "manufacturer description", note: "two-unit pack" },
  { key: "variant.bulk", kind: "brand", match: /\bnon-?sterile\b|\bbulk\b|\bNSB\b/, assert: { extras: ["non-sterile bulk"] }, provenance: "manufacturer description", note: "non-sterile bulk packaging (NSB)" },
  { key: "variant.handle", kind: "brand", match: /\bhandled\b|\bwith\s+handle\b|\bpistol[\s-]?grip\b/i, assert: { extras: ["handle"] }, provenance: "manufacturer description", note: "a trocar with an integral handle (Ethicon 'handled' SKUs, Visiport's pistol grip) is a distinct product from the plain one" },
  { key: "variant.dual-cannula", kind: "brand", match: /\bdual\s+(?:fixation\s+)?cannula\b/i, assert: { extras: ["dual cannula"] }, provenance: "manufacturer description", note: "sold with two cannulas" },
  // ---- Generic wording ---------------------------------------------------------------------
  // Negations first: "non-optical" is a statement of non-optical, not of optical; "without fixation" is a smooth cannula.
  { key: "generic.non-optical", kind: "brand", match: /\bnon[\s-]?optical\b|\bwithout\s+optical\b/i, assert: { visualization: "non-optical" }, provenance: "manufacturer description", note: "stated non-optical" },
  { key: "generic.without-fixation", kind: "brand", match: /\bwithout\s+(?:\w+\s+)?(?:fixation|threads?|threading)\b|\bun-?threaded\b/i, assert: { fixation: "smooth" }, provenance: "manufacturer description", note: "'without fixation' / unthreaded = smooth cannula" },
  { key: "generic.optical", kind: "brand", match: /(?<!\bnon[\s-])(?<!\bwithout\s)\boptical\b|\bclear\s+tip\b|\bvisual(?:ised|ized)?\s+entry\b/i, assert: { visualization: "optical" }, provenance: "manufacturer description", note: "'optical' / 'clear tip' names visualised entry" },
  { key: "generic.bladeless", kind: "brand", match: /\bbladeless\b|\bnon-?bladed\b/i, assert: { tip: "bladeless" }, provenance: "manufacturer description", note: "stated bladeless" },
  { key: "generic.bladed", kind: "brand", match: /(?<!\bnon[\s-])\bbladed\b(?!\s*less)|\bshielded\s+blade\b|\bpyramidal\s+tip\b/i, assert: { tip: "bladed" }, provenance: "manufacturer description", note: "stated bladed / pyramidal tip" },
  { key: "generic.hasson", kind: "brand", match: /\bhasson\b/i, assert: { tip: "blunt" }, provenance: "manufacturer description", note: "Hasson = blunt open-entry trocar" },
  { key: "generic.bladed-nonoptical", kind: "brand", match: /(?<!\bnon[\s-])\bbladed\b(?!\s*less)|\bnon-?shielded\b|\bshielded\s+blade\b/i, assert: { visualization: "non-optical" }, provenance: "manufacturer description", note: "a bladed trocar is non-optical unless the name says optical (the optical rules run first)" },
  { key: "generic.bladeless-nonoptical", kind: "brand", match: /\bbladeless\b|\bnon-?bladed\b|\bdilating\b/i, assert: { visualization: "non-optical" }, provenance: "manufacturer description", note: "a bladeless trocar is non-optical unless the name says optical / OPTIVIEW / Fios (those rules run first)" },
  { key: "generic.blunt-nonoptical", kind: "brand", match: /\bblunt\b|\bhasson\b/i, assert: { visualization: "non-optical" }, provenance: "manufacturer description", note: "a blunt / Hasson trocar is placed under direct vision through a cut-down, not an optical-entry device (optical rules run first)" },
  { key: "generic.fixation", kind: "brand", match: /(?<!\bwithout\s)(?<!\bwithout\s\w+\s)\bfixation\b|(?<!non-)(?<!non\s)(?<!\bwithout\s)\bthreaded\b|\bridged\b|\bstability\s+sleeves?\b/i, assert: { fixation: "fixation" }, provenance: "manufacturer description", note: "threaded / ridged / fixation cannula" },
  { key: "generic.smooth", kind: "brand", match: /\bsmooth\b|\bnon-?threaded\b/i, assert: { fixation: "smooth" }, provenance: "manufacturer description", note: "smooth (non-threaded) cannula" },
  { key: "generic.balloon", kind: "brand", match: /\bballoon\b/i, assert: { fixation: "balloon" }, provenance: "manufacturer description", note: "balloon-anchored cannula" },
  { key: "generic.low-profile", kind: "brand", match: /\blow\s+profile\b|\bLP\b/, assert: { lowProfile: true }, provenance: "manufacturer description", note: "low-profile head" },
  // ---- SKU conventions (weakest evidence: only fill gaps) --------------------------------------
  {
    key: "sku.ethicon-xcel", kind: "sku", match: /^(2?)(B|D|CB|CTB|CTD|CTF|CTS|NB)(\d{1,2})(ST|LT|XT)(H|S|P|HP)?$/, provenance: "family knowledge",
    note: "Ethicon Endopath Xcel/BASX: prefix 2 = OPTIVIEW, B = bladeless, D = dilating tip, CB/CTB = universal sleeve; size in mm; ST 75 mm, LT 100 mm, XT 150 mm",
    assert: (m) => ({ manufacturer: "Ethicon", family: "Trocar Products", diameterMm: [Number(m[3])], lengthMm: m[4] === "ST" ? 75 : m[4] === "LT" ? 100 : 150, ...(m[1] ? { visualization: "optical" as const } : { visualization: "non-optical" as const }), ...(m[2] === "B" || m[2] === "NB" ? { tip: "bladeless" as const, component: "trocar" as const } : m[2] === "D" ? { tip: "dilating" as const, component: "trocar" as const } : m[2] === "CB" || m[2] === "CTB" ? { component: "cannula" as const } : {}), ...(m[5] === "H" || m[5] === "HP" ? { extras: ["handle"] } : {}) }),
  },
  {
    key: "sku.mdt-versaone", kind: "sku", match: /^(ONB|NONB|NB|UNVCA|BPT|B)(\d{1,2})(SH|ST|LG)(FLP|SLP|F|S|B)?(-NSB|2C|CS)?$/, provenance: "family knowledge",
    note: "Medtronic VersaOne: ONB optical bladeless, NONB bladeless, B bladed, UNVCA universal cannula, BPT blunt; size in mm; SH 70 mm, ST 100 mm, LG 150 mm; F fixation, S smooth, B balloon, LP low profile; -NSB non-sterile bulk, 2C dual cannula, CS fascial closure system",
    assert: (m) => ({ manufacturer: "Medtronic", family: "Trocar Products", diameterMm: [Number(m[2])], lengthMm: m[3] === "SH" ? 70 : m[3] === "ST" ? 100 : 150, ...(m[5] ? { extras: [m[5] === "-NSB" ? "non-sterile bulk" : m[5] === "2C" ? "dual cannula" : "fascial closure system"] } : {}), ...(m[1] === "BPT" ? {} : m[4]?.startsWith("F") ? { fixation: "fixation" as const } : m[4]?.startsWith("S") ? { fixation: "smooth" as const } : m[4] === "B" ? { fixation: "balloon" as const } : {}), ...(m[4]?.endsWith("LP") ? { lowProfile: true } : {}), ...(m[1] === "ONB" ? { visualization: "optical" as const, tip: "bladeless" as const, component: "trocar" as const } : m[1] === "NONB" || m[1] === "NB" ? { visualization: "non-optical" as const, tip: "bladeless" as const, component: "trocar" as const } : m[1] === "B" ? { visualization: "non-optical" as const, tip: "bladed" as const, component: "trocar" as const } : m[1] === "UNVCA" ? { component: "cannula" as const } : m[1] === "BPT" ? { visualization: "non-optical" as const, tip: "blunt" as const, component: "trocar" as const } : {}) }),
  },
  {
    key: "sku.applied-kii", kind: "sku", match: /^(C[0O]|CT|CF|CB)([FSRBQ])(\d{2})$/, provenance: "family knowledge",
    note: "Applied Medical Kii: second letter F = Fios optical, S = sleeve, B = blunt/balloon, R = standard; last two digits encode size and length per the Kii catalog (not decoded here — sizes come from GUDID)",
    assert: (m) => ({ manufacturer: "Applied Medical", family: "Trocar Products", ...(m[2] === "F" ? { visualization: "optical" as const, tip: "bladeless" as const, component: "trocar" as const } : m[2] === "S" ? { component: "cannula" as const } : {}) }),
  },
];

/** Assertions from every brand rule the text matches, in rule order, with provenance. */
export function brandAssertions(text: string): { key: string; assert: BrandAssertion; provenance: BrandRule["provenance"]; note: string }[] {
  const t = text.replace(/[™®©]/g, "");
  const out: { key: string; assert: BrandAssertion; provenance: BrandRule["provenance"]; note: string }[] = [];
  for (const r of BRAND_RULES) {
    if (r.kind !== "brand") continue;
    const m = t.match(r.match);
    if (!m || (r.unless && r.unless.test(t))) continue;
    out.push({ key: r.key, assert: typeof r.assert === "function" ? r.assert(m) : r.assert, provenance: r.provenance, note: r.note });
  }
  return out;
}

/**
 * Assertions from the SKU convention the catalog number matches (first rule wins). A convention is
 * the manufacturer's own encoding, so it applies only when the product's manufacturer is known to be
 * that manufacturer — a pattern alone is not evidence that "B12LT" is an Ethicon code.
 */
export function skuAssertion(sku: string | null | undefined, manufacturer: string | null | undefined): { key: string; assert: BrandAssertion; provenance: BrandRule["provenance"]; note: string } | null {
  if (!sku || !manufacturer) return null;
  const s = sku.toUpperCase().trim();
  const mfr = manufacturer.toLowerCase();
  for (const r of BRAND_RULES) {
    if (r.kind !== "sku") continue;
    const m = s.match(r.match);
    if (!m) continue;
    const a = typeof r.assert === "function" ? r.assert(m) : r.assert;
    if (a.manufacturer && !mfr.includes(a.manufacturer.toLowerCase()) && !(a.manufacturer === "Medtronic" && /covidien/.test(mfr))) continue;
    return { key: r.key, assert: a, provenance: r.provenance, note: r.note };
  }
  return null;
}

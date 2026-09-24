/**
 * Component type of an access product: what is physically in the box.
 *
 * A 12 mm cannula-only sleeve is not a substitute for a 12 mm complete trocar and the other
 * way round, whatever their diameters say. The matcher treats this as a hard constraint
 * (src/lib/match/constraints.ts); the evaluator uses it to count device-type mismatches, so
 * one classifier serves both — a measurement and the rule it feeds must agree.
 *
 * The classification reads the product's own words. Order matters: "trocar with fixation
 * cannula" is a complete trocar, "fixation cannula" alone is a cannula, "obturator with seal"
 * is an obturator, "trocar sleeve" is a sleeve.
 */
export const COMPONENTS = ["trocar", "cannula", "obturator", "insufflation-needle", "accessory", "dilating-system", "unknown"] as const;
export type Component = (typeof COMPONENTS)[number];

const NEEDLE = /\bveress\b|insufflation needle|pneumoperitoneum needle|access needle/i;
const ACCESSORY = /\breducer\b(?!.*(cannula|sleeve|trocar))|\badapt[eo]r\b|\bseals?\s+\d+\s*pk\b|\bduckbill\b|\bvalve\b|\bseal cap\b|\bconverter\b(?!less)|\bgel cap\b|\binstrument seal\b|\bcannula seal\b|\bseal only\b|\bcap only\b|\bvalve only\b|\bseals?\s*(?:;|$)/i;
const OBTURATOR_ONLY = /\bobturator only\b|^(?:(?!trocar|cannula(?! only)|sleeve(?! assembly)|system).)*\bobturator\b/i;
const SLEEVE_ONLY = /\bcannula only\b|\bsleeve only\b|\bsleeve assembly\b|\bfixation sleeve\b|\bstab\w*ity sleeves?\b|\buniversal sleeves?\b|\btrocar sleeves?\b|\b(?:cannula|sleeve)s?\s*(?:;|$)|\buniversal (?:fixation |smooth |threaded )?cannula\b|\buniversal (?:fixation |smooth |threaded )?sleeve\b|^(?:(?!trocar|obturator|system|separator).)*\b(?:cannula|sleeve)\b/i;
const DILATING = /radially expand|\bversastep\b|\bmini step\b|\bstep\b.*dilat|expandable sleeve/i;
const TROCAR = /\btrocars?\b|\bseparator\b|\baccess system\b|\bport\b(?!\s*(?:cap|seal|reducer))|\bcannula and dilator\b|\bcannula with obturator\b|\bfirst entry\b|\bkii\b/i;

/** Classify from any text about the product (description, brand, GMDN). Empty → unknown. */
export function componentOf(...texts: (string | null | undefined)[]): Component {
  const t = texts.filter(Boolean).join(" ; ").replace(/[™®©]/g, "").trim();
  if (!t) return "unknown";
  if (NEEDLE.test(t)) return "insufflation-needle";
  if (DILATING.test(t)) return "dilating-system";
  // A trocar sold with its cannula names both; "with fixation cannula" / "with stability sleeve" is still a trocar,
  // and so is "Bladeless 12 mm … with fixation cannula" (the tip word names the obturator). "Fixation cannula …
  // for use with … trocar" is the opposite: a cannula sold FOR a trocar, so "for use with" never joins the two.
  // "with" binds to the next few words only ("with fixation cannula", "with 100mm Radiolucent Sleeve"), never
  // across a "for use with" or a seal description.
  const WITH = "(?<!\\bfor\\s)(?<!\\bfor\\suse\\s)\\bwith\\s+(?:[\\w.-]+\\s+){0,4}";
  const withCannula = new RegExp(`\\btrocars?\\b[^;]*${WITH}(?:cannula|sleeve)s?\\b|\\b(?:cannula|sleeve)s?\\b[^;]*${WITH}trocars?\\b|\\b(?:bladeless|bladed|optical|blunt(?:[\\s-]*tip)?|dilating(?:[\\s-]*tip)?)\\b[^;]*${WITH}(?:cannula|sleeve)s?\\b`, "i").test(t);
  if (withCannula) return "trocar";
  // "trocar with universal seal" names a seal as a part of the trocar, not a seal SKU.
  const accessoryAsPart = /\b(?:trocar|cannula|sleeve|obturator)s?\b[^;]*\bwith\b[^;]*\b(?:seal|valve|reducer|adapt[eo]r|cap)s?\b/i.test(t);
  if (!accessoryAsPart && ACCESSORY.test(t)) return "accessory";
  if (OBTURATOR_ONLY.test(t)) return "obturator";
  if (SLEEVE_ONLY.test(t)) return "cannula";
  if (TROCAR.test(t)) return "trocar";
  return "unknown";
}

/** Two components that must never be crossed as equivalents (a sleeve is not a trocar). */
export function componentsCompatible(a: Component, b: Component): boolean {
  if (a === "unknown" || b === "unknown") return true;
  if (a === b) return true;
  // A dilating system is a complete access device: a trocar substitute, not a cannula.
  const norm = (c: Component) => (c === "dilating-system" ? "trocar" : c);
  return norm(a) === norm(b);
}

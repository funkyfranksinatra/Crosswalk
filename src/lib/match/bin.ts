/**
 * The "bin": a structured, comparable description of a product.
 *
 * Both competitor products (from GUDID) and our own products are reduced to
 * this shape. The LLM produces it when available; a regex/keyword heuristic
 * produces a coarser version otherwise, so the pipeline is never blocked on
 * a model. Similarity between two bins is deterministic and explainable.
 */
import { z } from "zod";
import { buildAccessProfile, type AccessProfile, type ProfileSource } from "./access";
import { compareAccess, type ConstraintResult } from "./constraints";

export const FAMILIES = [
  "Trocar Products",
  "Surgical Stapling Products",
  "Laparoscopic Instruments (Hand)",
  "Hernia Mesh",
  "Fixation",
  "Energy",
  "Other",
] as const;
export type Family = (typeof FAMILIES)[number];

export const DimensionSchema = z.object({
  name: z.string().describe("lowercase canonical name: diameter, length, width, height, thickness, staple line length, staple height, gauge, count, volume"),
  value: z.number(),
  unit: z.enum(["mm", "cm", "in", "ga", "fr", "count", "ml", "other"]),
});

/**
 * Bump when the heuristic binner's rules change so cached bins are rebuilt on the next run.
 * Model bins record the heuristic version they were drafted from (`hv`); a bump rebuilds those
 * too, because the model corrects the heuristic first pass rather than starting from nothing.
 */
export const BIN_VERSION = 7;

export const BinSchema = z.object({
  v: z.number().optional().describe("internal: binner rule version"),
  hv: z.number().optional().describe("internal: heuristic rule version the model draft was based on"),
  productType: z.string().describe("canonical lowercase noun phrase, e.g. 'bladeless optical trocar', 'endoscopic stapler reload', 'polypropylene hernia mesh'"),
  family: z.enum(FAMILIES),
  function: z.string().describe("one sentence: what the product does in the OR"),
  materials: z.array(z.string()).describe("lowercase material names"),
  dimensions: z.array(DimensionSchema),
  features: z.array(z.string()).describe("lowercase tags: single-use, sterile, articulating, bladeless, optical, fixation cannula, curved tip, reinforced, absorbable, powered, reusable, threaded, smooth, macroporous, dual sided, etc."),
  compatibility: z.array(z.string()).describe("platforms / handles / systems it is used with, lowercase"),
  singleUse: z.boolean().nullable(),
  sterile: z.boolean().nullable(),
  implantable: z.boolean().nullable(),
  summary: z.string().describe("one line a sales rep would recognise"),
});
/** Stored shape: the model's bin plus the provenance-tagged access profile the heuristic derives (never asked of the model). */
export const StoredBinSchema = BinSchema.extend({ access: z.custom<AccessProfile>((v) => v == null || (typeof v === "object" && Array.isArray((v as AccessProfile).diameters))).optional() });
export type Bin = z.infer<typeof StoredBinSchema>;
export type Dimension = z.infer<typeof DimensionSchema>;

export function parseBin(json: string | null | undefined, opts: { allowStale?: boolean } = {}): Bin | null {
  if (!json) return null;
  try {
    const parsed = StoredBinSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    // Bins built by older heuristic rules are treated as missing so they get rebuilt. Model bins
    // (v = 9999) go stale when the heuristic draft they corrected is older than the current rules.
    if (!opts.allowStale) {
      const v = parsed.data.v ?? 0;
      if (v < BIN_VERSION) return null;
      if (v >= 9999 && (parsed.data.hv ?? 0) < BIN_VERSION) return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic binner (no model needed)
// ---------------------------------------------------------------------------

const MATERIALS = [
  "polypropylene", "polyester", "ptfe", "eptfe", "gore-tex", "titanium", "stainless steel", "steel",
  "polyglycolic", "pga", "pla", "p4hb", "poly-4-hydroxybutyrate", "polydioxanone", "pds", "silicone",
  "nitinol", "polycarbonate", "polyurethane", "collagen", "porcine", "bovine", "biologic", "absorbable",
  "monofilament", "multifilament", "nylon", "latex", "permanent",
];

/** "Nonabsorbable" must not read as "absorbable"; normalise negations before matching. */
function normaliseNegations(text: string): string {
  return text.replace(/non[\s-]?(bio)?(ab|re)sorbable/gi, "permanent").replace(/permanent(?:ly)? implant/gi, "permanent implant");
}

const FEATURES: [RegExp, string][] = [
  [/single[\s-]?use|disposable/i, "single-use"],
  [/reusable/i, "reusable"],
  [/sterile/i, "sterile"],
  [/articulat/i, "articulating"],
  [/roticulat/i, "articulating"],
  [/bladeless|non[\s-]?bladed|blunt/i, "bladeless"],
  [/\bbladed\b|shielded blade/i, "bladed"],
  [/optical|visiport|clear tip/i, "optical"],
  [/fixation cannula|fixation|threaded|z-thread/i, "fixation cannula"],
  [/smooth cannula|non-threaded/i, "smooth cannula"],
  [/curved tip/i, "curved tip"],
  [/reinforced|buttress|reinforcement/i, "reinforced"],
  [/(?:bio)?(?:ab|re)sorbable/i, "absorbable"],
  [/fully[\s-]?(?:bio)?(?:ab|re)sorbable|\bphasix\b|p4hb|poly-4-hydroxybutyrate|\bbio-a\b|\btigr\b|\bvicryl\b|\bdexon\b/i, "fully-absorbable"],
  [/partially[\s-]?(?:bio)?(?:ab|re)sorbable|\bultrapro\b|\bvypro\b|\bseramesh\b/i, "partially-absorbable"],
  [/\bpermanent\b/i, "permanent"],
  [/powered|signia|echelon flex|aeon/i, "powered"],
  // "Soft" as in Prolene Soft / Bard Soft Mesh is a lightweight construction; "soft tissue" is anatomy (GORE-TEX Soft Tissue Patch is microporous ePTFE).
  [/macroporous|lightweight|light weight|\bsoft\b(?!\s*tissue)/i, "macroporous"],
  [/dual[\s-]?sided|two[\s-]?sided|dual[\s-]?mesh|composite mesh|barrier|ds\b|\bst\b|sepra|intraperitoneal|\bipom\b|ventralight|physiomesh|proceed\b/i, "barrier"],
  [/self[\s-]?gripping|progrip/i, "self-gripping"],
  [/monopolar|cautery|electrode/i, "monopolar"],
  [/bipolar/i, "bipolar"],
  [/suction|irrigat/i, "suction-irrigation"],
  [/specimen|retrieval|pouch|bag/i, "specimen retrieval"],
  [/grasp|babcock|clinch|forceps/i, "grasper"],
  [/scissor|shears/i, "scissors"],
  [/dissect|maryland/i, "dissector"],
  [/needle|veress|insufflation/i, "insufflation needle"],
  [/tack|fastener|helical/i, "tacks"],
  [/vascular/i, "vascular"],
  [/medium\s*\/?\s*thick|med thk|medium thick/i, "medium-thick"],
  [/extra thick|x-thick|\bxt\b/i, "extra-thick"],
  [/\bthick\b/i, "thick"],
  [/\bmedium\b/i, "medium"],
  [/\bthin\b/i, "thin"],
  [/tan\b/i, "reload:tan"],
  [/purple|violet/i, "reload:purple"],
  [/\bblack\b/i, "reload:black"],
  [/\bgr[ae]y\b/i, "reload:gray"],
  [/\bwhite\b/i, "reload:white"],
  [/\bblue\b/i, "reload:blue"],
  [/\bgold\b/i, "reload:gold"],
  [/\bgreen\b/i, "reload:green"],
  [/\bloading unit\b|\breload\b|\bcartridge\b|sulu/i, "reload"],
  [/\bstapler\b|\bhandle\b|\binstrument\b/i, "instrument"],
  [/\bcircular\b|\beea\b|\bcdh\b|hemorrhoid/i, "circular"],
  // Endopath is Ethicon's stapler line and its trocar line; only the stapler sense is a linear cutter.
  [/\blinear cutter\b|\bgia\b|\bendopath\b(?![^;]*\b(?:xcel|basx|trocars?|sleeves?|cannulas?|separators?|obturators?)\b)|\bets\b/i, "linear cutter"],
  [/\bta\b|\bta™/i, "linear non-cutting"],
  [/\bextra long\b|\bxl\b|\blong\b/i, "long"],
  [/\bshort\b|\bcompact\b/i, "short"],
  [/\blow profile\b|\blp\b/i, "low profile"],
  [/\bkit\b|\bpack\b|\bdual pack\b/i, "pack"],
  [/sleeve|cannula only/i, "sleeve"],
  [/obturator/i, "obturator"],
  [/\bround\b|\bcircle\b/i, "shape:round"],
  [/\boval\b|\bellip/i, "shape:oval"],
  [/\brectang/i, "shape:rectangle"],
  [/\bsquare\b/i, "shape:square"],
  [/\bplug\b/i, "shape:plug"],
];

const FAMILY_RULES: [RegExp, Family][] = [
  // Order matters: fixation devices mention "mesh" in their GMDN term, staplers mention "tissue".
  // Other specialties first: a whole-labeler GUDID import brings cranial mesh, spinal cages, pedicle
  // plugs, vascular grafts and cardiac leads that would otherwise land in the surgical families on a
  // single keyword. They are not candidates for anything on a hospital's surgical list.
  [/cranial|craniofacial|cranioplasty|neurosurg|\bspinal?\b|\bspine\b|vertebr|pedicle|interbody|intervertebral|orthop|osteo|\bbone\b|dental|maxillofacial|cardiac|pacemaker|defibrillat|\blead\b|stent|vascular graft|endovascular|catheter|guidewire|insulin|glucose|infusion pump|ventilator|oxygenator|hemodialysis|ophthalm|cochlear|stimulat|deep brain|pulse generator|cardioverter|ablation catheter|surgical mesh, metal|metal mesh|titanium mesh|instrument tray|sterilization container|\bcaddy\b|\bcase\b.*\b(tray|lid|instruments?)\b|\blid\b/i, "Other"],
  [/\btack|fastener|helical|protack|absorbatack|securestrap|capsure|fixation device|mesh fixation/i, "Fixation"],
  [/stapl|reload|cartridge|loading unit|sulu|\bgia\b|\bta\b|\beea\b|echelon|endopath ets|aeon|signia|tri-staple|contour|proximate/i, "Surgical Stapling Products"],
  [/\bmesh\b|patch|biomaterial|hernia|dualmesh|dulamesh|parietene|parietex|phasix|prolene|ultrapro|ventralight|symbotex|progrip|composix|bard soft|perfix|plug/i, "Hernia Mesh"],
  [/trocar|cannula|obturator|sleeve|separator|access system|versaport|versaone|versastep|visiport|endopath xcel|kii\b|insufflation|veress|access needle|port\b/i, "Trocar Products"],
  [/grasp|babcock|clinch|scissor|shears|dissect|retract|clamp|suction|irrigat|specimen|pouch|retrieval bag|clip applier|hook|probe|ligasure|harmonic|sonicision|enseal|detachatip|epix|surgiwand|endo catch|reliacatch|inzii|anchor tissue/i, "Laparoscopic Instruments (Hand)"],
];

const FAMILY_FROM_CATEGORY: Record<string, Family> = {
  "trocar products": "Trocar Products",
  "surgical stapling products": "Surgical Stapling Products",
  "laparoscopic instruments (hand)": "Laparoscopic Instruments (Hand)",
  "synthetic mesh": "Hernia Mesh",
  "biologic mesh": "Hernia Mesh",
  "hernia mesh": "Hernia Mesh",
  fixation: "Fixation",
  energy: "Energy",
};

export function familyFromCategory(cat?: string | null): Family | null {
  if (!cat) return null;
  return FAMILY_FROM_CATEGORY[cat.trim().toLowerCase()] ?? null;
}

const UNIT_MAP: Record<string, Dimension["unit"]> = { mm: "mm", cm: "cm", in: "in", inch: "in", inches: "in", '"': "in", ga: "ga", gauge: "ga", g: "ga", fr: "fr", ml: "ml", cc: "ml" };

function toMm(d: Dimension): number | null {
  if (d.unit === "mm") return d.value;
  if (d.unit === "cm") return d.value * 10;
  if (d.unit === "in") return d.value * 25.4;
  return null;
}

/** Pull numeric dimensions out of free text. Handles "12 mm x 100 mm", "7.5 cm x 10 cm", "10x12 in.", "13 gauge", "30 tacks", "45 mm". */
export function extractDimensions(text: string): Dimension[] {
  const dims: Dimension[] = [];
  const t = text.replace(/×/g, "x").replace(/[“”]/g, '"');

  // A x B (x C) with a shared or per-value unit
  const pairRe = /(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|")?\s*[xX]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|")?(?:\s*[xX]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|")?)?/g;
  let m: RegExpExecArray | null;
  const consumed: [number, number][] = [];
  while ((m = pairRe.exec(t))) {
    const unitStr = (m[6] ?? m[4] ?? m[2] ?? "").toLowerCase();
    const unit = UNIT_MAP[unitStr] ?? null;
    if (!unit) continue;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[3]);
    // "Round 12 cm x 1" — the trailing bare small integer is a pack count, not a dimension.
    if (m[2] && !m[4] && !m[5] && b <= 3 && Number.isInteger(b)) {
      const u = UNIT_MAP[m[2].toLowerCase()] ?? unit;
      dims.push({ name: /round|circle|diam/i.test(t.slice(Math.max(0, m.index - 12), m.index)) ? "diameter" : "size", value: a, unit: u });
      dims.push({ name: "count", value: b, unit: "count" });
      consumed.push([m.index, m.index + m[0].length]);
      continue;
    }
    const u1 = UNIT_MAP[(m[2] ?? unitStr).toLowerCase()] ?? unit;
    const u2 = UNIT_MAP[(m[4] ?? unitStr).toLowerCase()] ?? unit;
    // Heuristic: first number is diameter when unit is mm and second is much bigger (trocar "12 mm x 100 mm")
    if (u1 === "mm" && u2 === "mm" && b >= a * 3 && a <= 20) {
      dims.push({ name: "diameter", value: a, unit: "mm" }, { name: "length", value: b, unit: "mm" });
    } else {
      const [w, l] = a <= b ? [a, b] : [b, a];
      dims.push({ name: "width", value: w, unit: u1 }, { name: "length", value: l, unit: u2 });
    }
    if (m[5]) {
      const third = parseFloat(m[5]);
      // "20 x 15 cm x 1" — a bare small integer after the sized pair is a pack count, not a thickness.
      if (!m[6] && third <= 3 && Number.isInteger(third)) dims.push({ name: "count", value: third, unit: "count" });
      else dims.push({ name: "thickness", value: third, unit: UNIT_MAP[(m[6] ?? unitStr).toLowerCase()] ?? unit });
    }
    consumed.push([m.index, m.index + m[0].length]);
  }

  const inConsumed = (i: number) => consumed.some(([s, e]) => i >= s && i < e);

  // Single "N mm" values with a role hint
  const singleRe = /(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?|")\b/g;
  while ((m = singleRe.exec(t))) {
    if (inConsumed(m.index)) continue;
    const v = parseFloat(m[1]);
    const unit = UNIT_MAP[m[2].toLowerCase()] ?? "mm";
    const before = t.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 25).toLowerCase();
    let name = "size";
    if (/thick/.test(after) || /thick/.test(before)) name = "thickness";
    else if (/round|circle|diam/.test(before)) name = "diameter";
    else if (/length|long|\blen\b/.test(after) || /length/.test(before)) name = "length";
    else if (/(reload|cartridge|loading unit|staple|gia|stapler|ets|echelon|aeon|tri-staple|articulat)/.test(before + after) && unit === "mm" && v >= 30) name = "staple line length";
    else if (/(introducer|cannula|trocar|port|instrument|grasper|scissors|shears|dissector|clip|probe|suction|bag|pouch|specimen|sleeve|stapler)/.test(before + " " + after) && unit === "mm" && v <= 20) name = "diameter";
    else if (unit === "mm" && v <= 20) name = "diameter";
    else if (unit === "mm" && v > 20) name = "length";
    else if (unit === "cm") name = /(long|length)/.test(before + after) ? "length" : "length";
    dims.push({ name, value: v, unit });
  }

  const gaRe = /(\d{1,2})\s*-?\s*(?:gauge|ga\b|g\b)/gi;
  while ((m = gaRe.exec(t))) dims.push({ name: "gauge", value: parseFloat(m[1]), unit: "ga" });

  const countRe = /(\d{1,3})\s*(?:tacks|fasteners|staples|clips|-?pack\b|pk\b|per box|\/box|ct\b)/gi;
  while ((m = countRe.exec(t))) dims.push({ name: "count", value: parseFloat(m[1]), unit: "count" });

  // Stapler staple height like "-2.5 mm; 3.5 mm" or "3.8" after GIA 60
  const heightRe = /\b(?:gia|ta)\s*\d{2,3}\s*-\s*(\d(?:\.\d)?)/gi;
  while ((m = heightRe.exec(t))) dims.push({ name: "staple height", value: parseFloat(m[1]), unit: "mm" });

  // de-dupe
  const seen = new Set<string>();
  return dims.filter((d) => {
    const k = `${d.name}:${d.value}:${d.unit}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Our mesh catalog numbers encode their size (PCO2015X = 20 x 15 cm, PPDS12 = 12 cm round,
 * PPM1106X3 = 11 x 6 cm). GUDID often lists only one side or none, so fill the gap from the code.
 */
export function sizeFromSku(sku: string | null | undefined): Dimension[] {
  if (!sku) return [];
  const s = sku.toUpperCase();
  let m = s.match(/^(?:PCO|PPM|PPDS|PPL|PTX|PCOS|TEC|TECR|TECT|PPSG|SPG|PPMS|PPMG|PPDM)(\d{2})(\d{2})(?:X\d?|[A-Z]{0,2})?$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= 4 && a <= 50 && b >= 4 && b <= 50) return [{ name: "width", value: Math.min(a, b), unit: "cm" }, { name: "length", value: Math.max(a, b), unit: "cm" }];
  }
  m = s.match(/^(?:PCO|PPDS|PPM|PPL|PTX|TEC)(\d{1,2})(?:X\d?|[A-Z]{0,2})?$/);
  if (m) {
    const d = Number(m[1]);
    if (d >= 4 && d <= 40) return [{ name: "diameter", value: d, unit: "cm" }];
  }
  return [];
}

/**
 * Collapse duplicate dimensions in place: "10 in" next to "26 cm" (a dual-unit label),
 * a GUDID "height 1 mm" next to the regex "thickness 1 mm". Metric wins; the first
 * value of each canonical name wins. Keeps the bins the model and the rep see short and unambiguous.
 */
export function normaliseDimensions(dims: Dimension[]): Dimension[] {
  const metricFirst = [...dims].sort((a, b) => (a.unit === "in" ? 1 : 0) - (b.unit === "in" ? 1 : 0));
  const kept: Dimension[] = [];
  for (const d of metricFirst) {
    const mm = toMm(d);
    // "height 1 mm" is a sheet thickness; "height 3.3 cm" on a plug is a real height.
    const name = d.name.toLowerCase() === "height" && mm != null && mm > 10 ? "height" : canonName(d.name);
    const dup = kept.some((k) => {
      if ((k.name.toLowerCase() === "height" && toMm(k) != null && toMm(k)! > 10 ? "height" : canonName(k.name)) !== name) return false;
      const kmm = toMm(k);
      if (mm == null || kmm == null) return k.unit === d.unit && k.value === d.value;
      // Dual-unit labels are rounded ("7 cm x 10 cm (3\" x 4\")"): allow 12% across unit systems, 6% within one.
      const tol = (k.unit === "in") !== (d.unit === "in") ? 0.12 : 0.06;
      return Math.abs(mm - kmm) / Math.max(mm, kmm, 1e-9) <= tol;
    });
    if (!dup) kept.push(name !== d.name.toLowerCase() ? { ...d, name } : d);
  }
  dims.splice(0, dims.length, ...kept);
  return dims;
}

/**
 * What makes two products the "same construction": materials plus the feature tags a surgeon
 * treats as a different device (barrier, absorbability, plug, self-gripping). Sibling grading
 * groups on this so Phasix (flat) and Phasix ST (barrier) never share one construction verdict.
 */
export function constructionSignature(bin: Bin): string {
  const CONSTRUCTION = new Set(["barrier", "fully-absorbable", "partially-absorbable", "shape:plug", "self-gripping", "reinforced", "biologic"]);
  const mats = [...new Set(bin.materials.map((m) => m.toLowerCase()))].sort();
  const feats = [...new Set(bin.features.filter((f) => CONSTRUCTION.has(f.toLowerCase())))].sort();
  return [...mats, ...feats].join(",") || "-";
}

/**
 * FDA review-panel specialties (openFDA `product_codes[].openfda.medical_specialty_description`)
 * that never hold endomechanical / hernia products. A record carrying any of them is "Other"
 * whatever its description says — Pyramesh is a spinal cage that GUDID also files under
 * "Mesh, Surgical, Metal", and a cardiopulmonary bypass "PLUG" is not a hernia plug.
 */
export const OFF_SPECIALTIES = /orthopedic|neurolog|cardiovascular|ear, nose|dental|ophthalm|radiolog|anesthesiolog|physical medicine|hematolog|clinical chemistry|immunolog|microbiolog|patholog|toxicolog|clinical toxicology/i;

export function heuristicBin(input: {
  sku?: string | null;
  name?: string | null;
  description?: string | null;
  brand?: string | null;
  gmdnName?: string | null;
  category?: string | null;
  /** FDA medical specialties of the record's product codes (see OFF_SPECIALTIES) */
  specialties?: string[] | null;
  sizes?: { type?: string; value?: string; unit?: string }[] | null;
  /** Sizes the rep imported for this competitor code — trusted over GUDID and regex. */
  importedSizes?: Dimension[] | null;
  /** Labeler / company, so SKU conventions apply only to the manufacturer that defines them. */
  manufacturer?: string | null;
  /** The catalog number as the manufacturer prints it (competitor or ours) — read by the SKU-convention rules. `sku` stays our own SKU (mesh size convention). */
  code?: string | null;
  /** The rep's intake description for this code (customer item master) — evidence below GUDID and the SKU convention. */
  intakeDescription?: string | null;
  singleUse?: boolean | null;
  sterile?: boolean | null;
  implantable?: boolean | null;
}): Bin {
  const text = normaliseNegations([input.brand, input.name, input.description, input.gmdnName].filter(Boolean).join(" ; "));
  const lower = text.toLowerCase();

  // Rules first (they read the product itself), sales category as the fallback.
  let family: Family = "Other";
  // A review panel outside surgery vetoes the surgical families — unless the GMDN term itself is a
  // surgical-access / stapling / mesh term (a laparoscopic cannula filed under "Cardiovascular" is still a cannula).
  const offSpecialty = (input.specialties ?? []).some((sp) => OFF_SPECIALTIES.test(sp)) && !/laparoscop|trocar|surgical stapl|hernia|surgical mesh/i.test(input.gmdnName ?? "");
  if (!offSpecialty) {
    for (const [re, fam] of FAMILY_RULES) {
      if (re.test(text)) { family = fam; break; }
    }
    if (family === "Other") family = familyFromCategory(input.category) ?? "Other";
  }

  const materials = MATERIALS.filter((mat) => lower.includes(mat));
  // Brand names carry the primary material even when the record doesn't spell it out.
  const BRAND_MATERIAL: [RegExp, string][] = [
    [/parietene|prolene|bard mesh|bard soft|marlex|ventralight|ventralex|ultrapro|vypro|3dmax|perfix|\bpolypropylene\b/i, "polypropylene"],
    [/parietex|symbotex|mersilene|\bpolyester\b/i, "polyester"],
    [/gore-?tex|dualmesh|mycromesh|\be?ptfe\b/i, "eptfe"],
    [/phasix|p4hb|poly-4-hydroxybutyrate/i, "p4hb"],
    [/strattice|permacol|alloderm|surgisis|biodesign|xenmatrix|porcine|bovine|dermis|\bbiologic/i, "biologic"],
  ];
  for (const [re, mat] of BRAND_MATERIAL) if (re.test(text) && !materials.includes(mat)) materials.push(mat);
  if (materials.includes("eptfe")) for (const m of ["ptfe", "gore-tex"]) { const i = materials.indexOf(m); if (i >= 0) materials.splice(i, 1); }
  const features = Array.from(new Set(FEATURES.filter(([re]) => re.test(text)).map(([, tag]) => tag)));
  // "absorbable" on its own only means something for fully resorbable devices; partially-absorbable
  // meshes and "with absorbable film" barriers are permanent implants and get their own tags.
  if (!features.includes("fully-absorbable")) {
    const i = features.indexOf("absorbable"); if (i >= 0) features.splice(i, 1);
    const j = materials.indexOf("absorbable"); if (j >= 0) materials.splice(j, 1);
  }
  const k = features.indexOf("permanent"); if (k >= 0) features.splice(k, 1);
  const k2 = materials.indexOf("permanent"); if (k2 >= 0) materials.splice(k2, 1);

  const dims = extractDimensions(text);
  // GUDID structured sizes are more trustworthy than regex; add them first.
  for (const s of input.sizes ?? []) {
    const v = parseFloat(String(s.value ?? ""));
    if (!Number.isFinite(v)) continue;
    const unitRaw = String(s.unit ?? "").toLowerCase();
    const unit: Dimension["unit"] = unitRaw.startsWith("milli") ? "mm" : unitRaw.startsWith("centi") ? "cm" : unitRaw.startsWith("inch") ? "in" : unitRaw.includes("gauge") ? "ga" : unitRaw.startsWith("french") ? "fr" : "other";
    const name = String(s.type ?? "size").toLowerCase().replace(/^outer |^inner /, "");
    if (!dims.some((d) => d.name === name && d.unit === unit)) dims.unshift({ name, value: v, unit });
  }

  // Imported competitor sizes win outright: drop whatever GUDID/regex said about the same dimension.
  if (input.importedSizes?.length) {
    const names = new Set(input.importedSizes.map((d) => canonName(d.name)));
    const sizeNames = ["width", "length", "diameter"];
    const replacesSize = input.importedSizes.some((d) => sizeNames.includes(canonName(d.name)));
    for (let i = dims.length - 1; i >= 0; i--) {
      const n = canonName(dims[i].name);
      if (names.has(n) || (replacesSize && (sizeNames.includes(n) || n === "size"))) dims.splice(i, 1);
    }
    dims.unshift(...input.importedSizes);
  }

  // Fill missing width/length/diameter from our own SKU convention (mesh only).
  if (family === "Hernia Mesh") {
    const fromSku = sizeFromSku(input.sku);
    for (const d of fromSku) if (!dims.some((x) => x.name === d.name || (d.name !== "diameter" && x.name === "diameter") || (d.name === "diameter" && (x.name === "width" || x.name === "length")))) dims.push(d);
  }

  // Access products get the provenance-tagged profile; its sizes replace the generic regex reading
  // (a "5–12 mm" range is not two diameters, "2/3 mm" is two, "100 mm x 5 mm" is length then size).
  let access: AccessProfile | undefined;
  if (family === "Trocar Products") {
    // Priority: structured sizes (curated import, GUDID) > the manufacturer's SKU convention > description
    // text (GUDID / curated sheet) > the intake description. The GMDN term is read only for what it
    // states specifically (a seal, a needle); "laparoscopic access cannula" is the generic term for trocars.
    const sources: ProfileSource[] = [
      ...(input.importedSizes?.length ? [{ text: null, source: "curated-spec" as const, dims: input.importedSizes }] : []),
      ...(input.sizes?.length ? [{ text: null, source: "gudid:size" as const, sizes: input.sizes }] : []),
      { text: input.code ?? input.sku ?? null, source: "sku", manufacturer: input.manufacturer ?? null },
      { text: [input.brand, input.name, input.description].filter(Boolean).join(" ; "), source: "gudid:description", gmdn: input.gmdnName ?? null },
      ...(input.intakeDescription ? [{ text: input.intakeDescription, source: "intake:description" as const }] : []),
    ];
    access = buildAccessProfile(sources);
    accessDimensions(dims, access);
    accessFeatures(features, access);
  }
  const productType = deriveProductType(family, features, lower, access);
  normaliseDimensions(dims);
  const compatibility: string[] = [];
  for (const sys of ["signia", "endo gia", "echelon", "aeon", "tri-staple", "versaone", "kii", "endopath xcel", "ligasure", "harmonic"]) {
    if (lower.includes(sys)) compatibility.push(sys);
  }

  return {
    v: BIN_VERSION,
    productType,
    family,
    function: functionSentence(family, productType),
    materials,
    dimensions: dims,
    features,
    compatibility,
    singleUse: input.singleUse ?? (features.includes("single-use") ? true : features.includes("reusable") ? false : null),
    sterile: input.sterile ?? (features.includes("sterile") ? true : null),
    implantable: input.implantable ?? (family === "Hernia Mesh" || family === "Fixation" ? true : null),
    summary: (input.description || input.name || "").replace(/\s+/g, " ").trim().slice(0, 120) + (input.importedSizes?.length ? " (size from competitor sizes import)" : ""),
    ...(access ? { access } : {}),
  };
}

/** Replace the generic size reading with the profile's (in place). */
function accessDimensions(dims: Dimension[], access: AccessProfile) {
  for (let i = dims.length - 1; i >= 0; i--) { const n = canonName(dims[i].name); if (["diameter", "length", "width", "lumen/inner diameter", "min instrument", "max instrument"].includes(n)) dims.splice(i, 1); }
  for (const d of [...access.diameters].reverse()) dims.unshift({ name: "diameter", value: d, unit: "mm" });
  if (access.lengthMm != null) dims.push({ name: "length", value: access.lengthMm, unit: "mm" });
  if (access.range) dims.push({ name: "min instrument", value: access.range.min, unit: "mm" }, { name: "max instrument", value: access.range.max, unit: "mm" });
}
function accessFeatures(features: string[], access: AccessProfile) {
  if (access.visualization === "optical" && !features.includes("optical")) features.push("optical");
  if ((access.tip === "bladeless" || access.tip === "dilating") && !features.includes("bladeless")) features.push("bladeless");
  if (access.tip === "bladed" && !features.includes("bladed")) features.push("bladed");
  if (access.component === "cannula" && !features.includes("sleeve")) features.push("sleeve");
  // "trocar with stability sleeve" is a trocar: the generic sleeve tag is the cannula-only marker.
  if (access.component === "trocar" || access.component === "dilating-system") { const i = features.indexOf("sleeve"); if (i >= 0) features.splice(i, 1); }
}

/**
 * A bin with a (merged) access profile applied: sizes, features and product type follow the profile.
 * Used at match time to fold line-level evidence (the intake description) into a cached competitor bin.
 */
export function withAccessProfile(bin: Bin, access: AccessProfile): Bin {
  const dims = bin.dimensions.map((d) => ({ ...d }));
  const features = [...bin.features];
  accessDimensions(dims, access);
  accessFeatures(features, access);
  normaliseDimensions(dims);
  return { ...bin, dimensions: dims, features, productType: bin.family === "Trocar Products" ? deriveProductType(bin.family, features, bin.summary.toLowerCase(), access) : bin.productType, access };
}

function deriveProductType(family: Family, features: string[], lower: string, access?: AccessProfile): string {
  const has = (f: string) => features.includes(f);
  switch (family) {
    case "Trocar Products":
      if (access && access.component !== "unknown") {
        switch (access.component) {
          case "insufflation-needle": return "insufflation needle";
          case "cannula": return "trocar sleeve";
          case "obturator": return "trocar obturator";
          case "accessory": return "trocar accessory";
          case "dilating-system": return "radially expanding trocar";
          default: return [access.tip === "bladed" ? "bladed" : access.tip === "blunt" ? "blunt" : access.tip ? "bladeless" : "", access.visualization === "optical" ? "optical" : "", "trocar"].filter(Boolean).join(" ");
        }
      }
      if (has("insufflation needle")) return "insufflation needle";
      if (has("sleeve") && !/trocar/.test(lower)) return "trocar sleeve";
      if (has("obturator") && !/trocar|system/.test(lower)) return "trocar obturator";
      return [has("bladeless") ? "bladeless" : has("bladed") ? "bladed" : "", has("optical") ? "optical" : "", "trocar"].filter(Boolean).join(" ");
    case "Surgical Stapling Products":
      if (has("circular")) return has("reload") ? "circular stapler reload" : "circular stapler";
      if (has("reload")) return has("reinforced") ? "reinforced endoscopic stapler reload" : "endoscopic stapler reload";
      if (/handle|shell|adapter/.test(lower)) return "powered stapler component";
      return has("linear cutter") ? "linear cutter stapler" : "surgical stapler";
    case "Laparoscopic Instruments (Hand)":
      if (has("specimen retrieval")) return "specimen retrieval bag";
      if (has("suction-irrigation")) return "suction irrigation device";
      if (has("scissors")) return "laparoscopic scissors";
      if (has("dissector")) return "laparoscopic dissector";
      if (has("grasper")) return "laparoscopic grasper";
      if (/retract/.test(lower)) return "laparoscopic retractor";
      if (/clip/.test(lower)) return "clip applier";
      return "laparoscopic hand instrument";
    case "Hernia Mesh":
      if (/biologic|porcine|bovine|dermis/.test(lower)) return "biologic hernia mesh";
      if (has("absorbable")) return has("barrier") ? "absorbable hernia mesh with barrier" : "absorbable hernia mesh";
      if (has("barrier")) return "composite hernia mesh with barrier";
      if (has("self-gripping")) return "self-gripping hernia mesh";
      if (has("shape:plug")) return "hernia plug";
      return "synthetic hernia mesh";
    case "Fixation":
      return has("absorbable") ? "absorbable tack fixation device" : "permanent tack fixation device";
    default:
      return "medical device";
  }
}

function functionSentence(family: Family, productType: string): string {
  const map: Record<Family, string> = {
    "Trocar Products": "Creates and maintains an access port through the abdominal wall for laparoscopic instruments.",
    "Surgical Stapling Products": "Transects and staples tissue during open or minimally invasive surgery.",
    "Laparoscopic Instruments (Hand)": "Hand-held instrument used through a trocar to manipulate, cut, or retrieve tissue.",
    "Hernia Mesh": "Implantable mesh that reinforces soft tissue in hernia repair.",
    Fixation: "Secures mesh or tissue with fasteners during hernia repair.",
    Energy: "Seals, cuts, or coagulates tissue with electrosurgical or ultrasonic energy.",
    Other: `Medical device (${productType}).`,
  };
  return map[family];
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function jaccard(a: string[], b: string[]): number | null {
  const A = new Set(a.map((s) => s.toLowerCase()));
  const B = new Set(b.map((s) => s.toLowerCase()));
  if (A.size === 0 && B.size === 0) return null;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t));
}
const STOP = new Set(["the", "and", "with", "for", "of", "to", "in", "a", "an", "mm", "cm", "x", "system", "single", "use", "device", "tm", "r"]);

/** Compare dimensions by canonical name, in mm where possible. */
const DIM_ALIAS: Record<string, string> = { height: "thickness", "outer diameter": "diameter", "inner diameter": "diameter", "cannula length": "length", "working length": "length", size: "diameter" };
const canonName = (n: string) => DIM_ALIAS[n.toLowerCase()] ?? n.toLowerCase();

function dimensionScore(a: Dimension[], b: Dimension[]): { score: number | null; detail: string[] } {
  const detail: string[] = [];
  const A = a.filter((d) => d.unit !== "count");
  const B = b.filter((d) => d.unit !== "count");
  if (A.length === 0 && B.length === 0) return { score: null, detail };
  // One side knows its sizes and the other doesn't: that is not a match, it is an unknown.
  if (A.length === 0 || B.length === 0) return { score: 0.35, detail: ["sizes unknown on one side"] };
  const names = new Set([...A.map((d) => canonName(d.name)), ...B.map((d) => canonName(d.name))]);
  let sum = 0;
  let n = 0;
  for (const name of names) {
    const da = A.filter((d) => canonName(d.name) === name);
    const db = B.filter((d) => canonName(d.name) === name);
    if (!da.length || !db.length) continue;
    // best pair match
    let best = 0;
    for (const x of da) for (const y of db) {
      const xv = toMm(x) ?? (x.unit === y.unit ? x.value : null);
      const yv = toMm(y) ?? (y.unit === x.unit ? y.value : null);
      if (xv == null || yv == null) continue;
      const rel = Math.abs(xv - yv) / Math.max(xv, yv, 1e-9);
      // 0% diff -> 1, 10% -> 0.8, 25% -> 0.5, >=50% -> 0
      const s = rel <= 0.02 ? 1 : Math.max(0, 1 - rel * 2);
      best = Math.max(best, s);
    }
    detail.push(`${name} ${best >= 0.98 ? "=" : best >= 0.6 ? "≈" : "≠"}`);
    sum += best;
    n++;
  }
  if (n === 0) {
    // Round vs rectangular (diameter vs width/length): compare the linear extents in mm instead of giving up.
    const ext = (ds: Dimension[]) => ds.map((d) => (d.name === "diameter" ? [toMm(d), toMm(d)] : [toMm(d)])).flat().filter((v): v is number => v != null).sort((x, y) => x - y);
    const ea = ext(A), eb = ext(B);
    if (ea.length && eb.length) {
      const pairs = Math.min(ea.length, eb.length);
      let acc = 0;
      for (let i = 0; i < pairs; i++) { const x = ea[ea.length - 1 - i], y = eb[eb.length - 1 - i]; const rel = Math.abs(x - y) / Math.max(x, y, 1e-9); acc += rel <= 0.02 ? 1 : Math.max(0, 1 - rel * 2); }
      return { score: (acc / pairs) * 0.85, detail: ["different shape — compared overall extents"] };
    }
    return { score: 0.5, detail: ["no comparable dimensions"] };
  }
  return { score: sum / n, detail };
}

export type MatchCap = "Exact Match" | "Close Match" | "Alternative Match" | "No Match";

export type SimilarityBreakdown = {
  score: number;
  /** Highest match type the construction differences allow. */
  cap: MatchCap;
  /** Access-product constraint findings when both sides carry a profile (docs/MATCH_QUALITY_MODEL.md §4). */
  access?: ConstraintResult;
  family: number | null;
  productType: number | null;
  dimensions: number | null;
  features: number | null;
  materials: number | null;
  text: number | null;
  notes: string[];
};

/** Deterministic similarity between two bins in [0,1] with an explanation. */
export function binSimilarity(a: Bin, b: Bin, textA = "", textB = ""): SimilarityBreakdown {
  const notes: string[] = [];
  const family = a.family === "Other" || b.family === "Other" ? 0.4 : a.family === b.family ? 1 : 0;
  if (family === 0) notes.push(`different family (${a.family} vs ${b.family})`);

  const pt = jaccard(tokens(a.productType), tokens(b.productType));
  if (pt !== null && pt >= 0.99) notes.push(`same product type: ${a.productType}`);
  else if (pt !== null && pt === 0) notes.push(`different product type (${a.productType} vs ${b.productType})`);

  const dim = dimensionScore(a.dimensions, b.dimensions);
  if (dim.detail.length) notes.push(dim.detail.join(", "));

  const feat = jaccard(a.features, b.features);
  const mat = jaccard(a.materials, b.materials);
  const txt = jaccard(tokens(textA || a.summary), tokens(textB || b.summary));

  // Weighted average over available factors
  const parts: [number | null, number][] = [
    [family, 0.25],
    [pt, 0.2],
    [dim.score, 0.25],
    [feat, 0.15],
    [mat, 0.05],
    [txt, 0.1],
  ];
  let wsum = 0;
  let acc = 0;
  for (const [v, w] of parts) {
    if (v === null || v === undefined) continue;
    acc += v * w;
    wsum += w;
  }
  let score = wsum ? acc / wsum : 0;
  // A different family is not a "slightly worse" match, it is a different product. Halve it.
  if (family === 0) score *= 0.5;

  // Construction differences a surgeon would not accept 1:1 cap the match type regardless of score.
  let cap: MatchCap = family === 0 ? "Alternative Match" : "Exact Match";
  const has = (b: Bin, f: string) => b.features.includes(f);
  const CORE = ["polypropylene", "polyester", "eptfe", "p4hb", "biologic", "titanium", "stainless steel"];
  const coreA = a.materials.filter((m) => CORE.includes(m));
  const coreB = b.materials.filter((m) => CORE.includes(m));
  if (has(a, "fully-absorbable") !== has(b, "fully-absorbable")) { cap = "Alternative Match"; notes.push(has(a, "fully-absorbable") ? "competitor is fully resorbable; ours is not" : "ours is fully resorbable; competitor is not"); score *= 0.85; }
  else if (has(a, "barrier") !== has(b, "barrier")) { if (cap === "Exact Match") cap = "Close Match"; notes.push(has(a, "barrier") ? "competitor has a tissue-separating barrier; ours does not" : "ours has a barrier layer; competitor does not"); score *= 0.92; }
  if (coreA.length && coreB.length && !coreA.some((m) => coreB.includes(m))) { if (cap === "Exact Match") cap = "Close Match"; notes.push(`different material (${coreA.join("/")} vs ${coreB.join("/")})`); score *= 0.92; }
  if (has(a, "partially-absorbable") !== has(b, "partially-absorbable") && cap === "Exact Match") cap = "Close Match";

  // Access products: hard constraints and soft signals from the provenance-tagged profiles.
  let access: ConstraintResult | undefined;
  if (a.access && b.access && a.family === "Trocar Products" && b.family === "Trocar Products") {
    access = compareAccess(a.access, b.access);
    score *= access.multiplier;
    // The decisive attributes are the evidence: generic feature/text overlap (brand words, packaging
    // words) must not hold a fully agreeing pair below the Exact threshold, nor lift a contradicted one.
    if (access.hard === 0) score = Math.max(score, access.agreement);
    if (MATCH_RANK[access.cap] > MATCH_RANK[cap]) cap = access.cap;
    // Findings lead the explanation: contradictions first, then what agrees.
    const order = { hard: 0, soft: 1, agree: 2, unknown: 3 };
    const lines = [...access.findings].sort((x, y) => order[x.kind] - order[y.kind]).filter((f) => f.kind !== "unknown").map((f) => (f.kind === "hard" ? `✗ ${f.text}` : f.kind === "soft" ? `≠ ${f.text}` : `= ${f.text}`));
    notes.splice(0, notes.length, ...lines, ...notes.filter((n) => !/same product type|different product type/.test(n)));
  }
  return { score, cap, access, family, productType: pt, dimensions: dim.score, features: feat, materials: mat, text: txt, notes };
}

const MATCH_RANK: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "No Match": 3 };

export function matchTypeFromScore(score: number, dims: number | null, cap: MatchCap = "Exact Match"): string {
  let t: string;
  if (score >= 0.82 && dims !== null && dims >= 0.9) t = "Exact Match";
  else if (score >= 0.6) t = "Close Match";
  else if (score >= 0.38) t = "Alternative Match";
  else t = "No Match";
  // Never claim Exact when the competitor's size is unknown — a rep must confirm it.
  if (t === "Exact Match" && dims === null) t = "Close Match";
  // A cap only ever lowers the grade; a hard incompatibility is No Match whatever the score.
  return MATCH_RANK[t] > MATCH_RANK[cap] ? t : cap;
}

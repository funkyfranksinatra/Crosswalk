/**
 * Hard constraints and soft signals between two access-product profiles
 * (docs/MATCH_QUALITY_MODEL.md §4). Pure and explainable: the result says which grade the
 * evidence still allows, how much to scale the similarity, and one line per finding.
 */
import { componentsCompatible } from "./component";
import type { AccessProfile } from "./access";

export type Grade = "Exact Match" | "Close Match" | "Alternative Match" | "No Match";
const RANK: Record<Grade, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "No Match": 3 };
export const lowerGrade = (a: Grade, b: Grade): Grade => (RANK[a] >= RANK[b] ? a : b);

export type Finding = { kind: "hard" | "soft" | "agree" | "unknown"; field: string; text: string };

export type ConstraintResult = {
  /** best grade the evidence allows */
  cap: Grade;
  /** multiply the similarity by this */
  multiplier: number;
  findings: Finding[];
  hard: number;
  soft: number;
  agreements: number;
  /** share of decisive fields known on both sides (component, diameter, length, visualization, tip) */
  coverage: number;
  /** diameter known on both sides and equal (required for Exact) */
  diameterConfirmed: boolean;
  /** best grade the attributes alone support: Exact needs ≥ 4 of the 5 decisive fields known (a curated Exact is judged by `cap`) */
  attributeCap: Grade;
  /** agreement on the decisive fields, 0–1, after the soft/hard multipliers — the access-aware similarity */
  agreement: number;
  /** a substitute of a different access technique (radially expanding system for a trocar): half a soft contradiction for confidence */
  techniqueDiffers: boolean;
};

const overlap = (a: number[], b: number[]) => a.some((x) => b.some((y) => Math.abs(x - y) <= 0.5));
const fmt = (d: number[]) => `${d.join("/")} mm`;

export function compareAccess(comp: AccessProfile, own: AccessProfile): ConstraintResult {
  const findings: Finding[] = [];
  let cap: Grade = "Exact Match";
  let multiplier = 1;
  let known = 0;
  const decisive = 5;
  let techniqueDiffers = false;

  // component — hard
  if (comp.component !== "unknown" && own.component !== "unknown") {
    known++;
    if (!componentsCompatible(comp.component, own.component)) {
      cap = "No Match"; multiplier *= 0.3;
      findings.push({ kind: "hard", field: "component", text: `${own.component === "cannula" ? "cannula only" : own.component} — the competitor line is a ${comp.component === "cannula" ? "cannula only" : comp.component}` });
    } else if (comp.component !== own.component) {
      // trocar ↔ radially expanding system: an accepted substitute (the curated sheets cross them as Exact),
      // but a different access technique — say so, and rank the like-for-like product first.
      multiplier *= 0.95; techniqueDiffers = true;
      findings.push({ kind: "agree", field: "component", text: `${own.component === "dilating-system" ? "radially expanding system" : own.component} for a ${comp.component === "dilating-system" ? "radially expanding system" : comp.component} (different access technique)` });
    } else findings.push({ kind: "agree", field: "component", text: `both ${comp.component}` });
  } else findings.push({ kind: "unknown", field: "component", text: comp.component === "unknown" ? "competitor component unknown" : "our component unknown" });

  // diameter — hard
  let diameterConfirmed = false;
  if (comp.diameters.length && own.diameters.length) {
    known++;
    if (!overlap(comp.diameters, own.diameters)) {
      cap = lowerGrade(cap, "Alternative Match"); multiplier *= 0.55;
      findings.push({ kind: "hard", field: "diameter", text: `${fmt(comp.diameters)} vs ${fmt(own.diameters)}` });
    } else {
      diameterConfirmed = true;
      const exact = comp.diameters.length === own.diameters.length && comp.diameters.every((d) => own.diameters.some((y) => Math.abs(d - y) <= 0.5));
      findings.push({ kind: "agree", field: "diameter", text: exact ? `${fmt(comp.diameters)} = ${fmt(own.diameters)}` : `${fmt(own.diameters)} covers ${fmt(comp.diameters)}` });
      if (!exact) multiplier *= 0.97;
    }
  } else findings.push({ kind: "unknown", field: "diameter", text: comp.diameters.length ? "our diameter unknown" : "competitor diameter unknown" });

  // length — soft (class); exact mm agreement is positive evidence
  const lc = comp.lengthClass, lo = own.lengthClass;
  if (lc && lo) {
    known++;
    if (lc !== lo) { cap = lowerGrade(cap, "Close Match"); multiplier *= 0.85; findings.push({ kind: "soft", field: "length", text: `length ${comp.lengthMm != null ? `${comp.lengthMm} mm` : lc} vs ${own.lengthMm != null ? `${own.lengthMm} mm` : lo}` }); }
    else findings.push({ kind: "agree", field: "length", text: comp.lengthMm != null && own.lengthMm != null ? `${comp.lengthMm} mm ≈ ${own.lengthMm} mm` : `both ${lc}` });
  } else findings.push({ kind: "unknown", field: "length", text: lc ? "our length unknown" : "competitor length unknown" });

  // visualization — soft
  if (comp.visualization && own.visualization) {
    known++;
    if (comp.visualization !== own.visualization) { cap = lowerGrade(cap, "Close Match"); multiplier *= 0.85; findings.push({ kind: "soft", field: "visualization", text: comp.visualization === "optical" ? "competitor is an optical-entry trocar; ours is not" : "ours is optical-entry; the competitor is not" }); }
    else findings.push({ kind: "agree", field: "visualization", text: comp.visualization === "optical" ? "both optical-entry" : "both non-optical" });
  } else if (comp.visualization === "optical" && !own.visualization) { known += 0.5; findings.push({ kind: "unknown", field: "visualization", text: "competitor is optical; ours does not say" }); }
  else findings.push({ kind: "unknown", field: "visualization", text: "visualization not stated" });

  // tip — soft (dilating counts as bladeless)
  const tipOf = (t: AccessProfile["tip"]) => (t === "dilating" ? "bladeless" : t);
  if (comp.tip && own.tip) {
    known++;
    const a = tipOf(comp.tip), b = tipOf(own.tip);
    if (a !== b) { cap = lowerGrade(cap, "Close Match"); multiplier *= 0.85; findings.push({ kind: "soft", field: "tip", text: `${comp.tip} vs ${own.tip}` }); }
    else findings.push({ kind: "agree", field: "tip", text: comp.tip === own.tip ? `both ${comp.tip}` : `${own.tip} for ${comp.tip} (both bladeless)` });
  } else findings.push({ kind: "unknown", field: "tip", text: "tip not stated" });

  // fixation — soft, small
  if (comp.fixation && own.fixation) {
    if (comp.fixation !== own.fixation) { cap = lowerGrade(cap, "Close Match"); multiplier *= 0.9; findings.push({ kind: "soft", field: "fixation", text: `${own.fixation} cannula for a ${comp.fixation} one` }); }
    else findings.push({ kind: "agree", field: "fixation", text: `both ${comp.fixation}` });
  }
  // low profile — soft, tiny
  if ((comp.lowProfile ?? false) !== (own.lowProfile ?? false)) { cap = lowerGrade(cap, "Close Match"); multiplier *= 0.9; findings.push({ kind: "soft", field: "profile", text: own.lowProfile ? "ours is the low-profile variant" : "competitor is low profile" }); }
  // variant add-ons / packaging on one side only — a different SKU for the rep
  const ex = (x: AccessProfile) => x.extras ?? [];
  // Ours carrying an add-on the competitor lacks is a different offer (at most Close); the competitor
  // carrying one we lack is worth a note and a small penalty — we still offer the plain product.
  for (const x of ex(own)) if (!ex(comp).includes(x)) { cap = lowerGrade(cap, "Close Match"); multiplier *= 0.9; findings.push({ kind: "soft", field: "variant", text: `ours is the ${x} variant` }); }
  for (const x of ex(comp)) if (!ex(own).includes(x)) { multiplier *= 0.95; findings.push({ kind: "unknown", field: "variant", text: `competitor is the ${x} variant; ours is the plain product` }); }
  // instrument range — soft when both state one
  if (comp.range && own.range && Math.abs(comp.range.max - own.range.max) > 0.5) { multiplier *= 0.97; findings.push({ kind: "soft", field: "range", text: `instruments ${comp.range.min}–${comp.range.max} mm vs ${own.range.min}–${own.range.max} mm` }); }

  const hard = findings.filter((f) => f.kind === "hard").length;
  const soft = findings.filter((f) => f.kind === "soft").length;
  const agreements = findings.filter((f) => f.kind === "agree").length;
  const coverage = Math.min(1, known / decisive);
  // Attributes alone never call a different access technique Exact; a curated sheet may.
  const attributeCap = (coverage < 0.8 || techniqueDiffers) && cap === "Exact Match" ? "Close Match" : cap;
  if (attributeCap !== cap) findings.push({ kind: "unknown", field: "coverage", text: techniqueDiffers ? "different access technique: Exact only on a curated cross" : `Exact needs ${Math.ceil(decisive * 0.8)} of ${decisive} decisive attributes known; ${Math.round(known)} are` });
  const agreement = hard ? 0 : (agreements / Math.max(1, agreements + soft)) * (0.7 + 0.3 * coverage) * multiplier;
  return { cap, multiplier, findings, hard, soft, agreements, coverage, diameterConfirmed, attributeCap, agreement, techniqueDiffers };
}

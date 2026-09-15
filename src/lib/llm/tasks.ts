/**
 * The three jobs the model does for Crosswalk. Each has a heuristic twin so the
 * pipeline runs without a key; the model simply makes the bins sharper and
 * the match grades more defensible.
 */
import { z } from "zod";
import { structured, llmConfig } from "./client";
import { BinSchema, heuristicBin, normaliseDimensions, type Bin, type Dimension, FAMILIES, BIN_VERSION, OFF_SPECIALTIES } from "@/lib/match/bin";

const BIN_SYSTEM = `You are a surgical product specialist helping a medical-device sales team cross-reference products.
Reduce the product to a precise, comparable attribute bin. Rules:
- productType: short lowercase noun phrase a clinician would use (e.g. "bladeless optical trocar", "endoscopic stapler reload", "absorbable hernia mesh with barrier", "laparoscopic grasper").
- family: one of ${FAMILIES.join(" | ")}.
- dimensions: numeric only, canonical names (diameter, length, width, height, thickness, staple line length, staple height, gauge, count). Convert "10 x 15 cm" into width 10 cm + length 15 cm. Trocar "12 mm x 100 mm" is diameter 12 mm + length 100 mm.
- features: lowercase tags; include stapler reload colour/thickness (e.g. "reload:purple", "medium-thick"), trocar cannula type ("fixation cannula", "smooth cannula", "bladeless", "optical"), mesh construction ("macroporous", "barrier", "absorbable", "self-gripping"), reusability, articulation, powered.
- compatibility: handles/platforms it needs (e.g. "signia", "endo gia universal", "echelon flex").
- Dimensions: use what is stated in the record. If the record has no sizes but you know this exact catalog number's published size with certainty (e.g. a well-known mesh or reload code), you may add it and append "(size from product knowledge)" to the summary. Never guess.`;

export async function binProduct(input: {
  subject: string;
  sku?: string | null;
  name?: string | null;
  description?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  gmdnName?: string | null;
  gmdnDefinition?: string | null;
  category?: string | null;
  sizes?: { type?: string; value?: string; unit?: string }[] | null;
  importedSizes?: Dimension[] | null;
  singleUse?: boolean | null;
  sterile?: boolean | null;
  implantable?: boolean | null;
  specialties?: string[] | null;
  useLlm?: boolean;
}): Promise<{ bin: Bin; source: "llm" | "heuristic" }> {
  const heuristic = heuristicBin({ ...input, sku: input.sku ?? null });
  if (input.useLlm === false || !llmConfig().available) return { bin: heuristic, source: "heuristic" };
  // An FDA review panel outside surgery is decisive (see OFF_SPECIALTIES): no model call, no candidate.
  if (heuristic.family === "Other" && (input.specialties ?? []).some((sp) => OFF_SPECIALTIES.test(sp))) return { bin: heuristic, source: "heuristic" };

  const user = [
    `Catalog number: ${input.subject}`,
    input.manufacturer ? `Manufacturer: ${input.manufacturer}` : null,
    input.brand ? `Brand: ${input.brand}` : null,
    input.name ? `Name: ${input.name}` : null,
    input.description ? `Description: ${input.description}` : null,
    input.category ? `Sales category: ${input.category}` : null,
    input.gmdnName ? `GMDN term: ${input.gmdnName}` : null,
    input.gmdnDefinition ? `GMDN definition: ${input.gmdnDefinition}` : null,
    input.sizes?.length ? `GUDID sizes: ${input.sizes.map((s) => `${s.type} ${s.value} ${s.unit}`).join("; ")}` : null,
    input.importedSizes?.length ? `Sizes from the sales team's competitor catalog import (authoritative — use these as the product's dimensions): ${input.importedSizes.map((d) => `${d.name} ${d.value} ${d.unit}`).join("; ")}` : null,
    input.singleUse != null ? `Single use: ${input.singleUse}` : null,
    input.sterile != null ? `Sterile: ${input.sterile}` : null,
    `Heuristic first pass (correct it, do not just copy it): ${JSON.stringify(heuristic)}`,
  ].filter(Boolean).join("\n");

  const res = await structured({ purpose: "bin", subject: input.subject, system: BIN_SYSTEM, user, schema: BinSchema, schemaName: "product_bin" });
  if (!res.ok) return { bin: heuristic, source: "heuristic" };
  // Keep any heuristic dimensions the model dropped when it kept the same family
  const bin: Bin = { ...res.data, v: 9999, hv: BIN_VERSION }; // stale only when the heuristic draft rules change
  if (bin.dimensions.length === 0 && heuristic.dimensions.length) bin.dimensions = heuristic.dimensions;
  // Sizes we know from our own SKU convention beat a model that only saw a partial GUDID record.
  for (const d of heuristic.dimensions.filter((x) => ["width", "length", "diameter"].includes(x.name))) if (!bin.dimensions.some((x) => x.name === d.name)) bin.dimensions.push(d);
  // Imported competitor sizes are authoritative: overwrite whatever the model kept for those names.
  for (const d of input.importedSizes ?? []) { bin.dimensions = bin.dimensions.filter((x) => x.name !== d.name); bin.dimensions.unshift(d); }
  normaliseDimensions(bin.dimensions);
  return { bin, source: "llm" };
}

// ---------------------------------------------------------------------------

const HintsSchema = z.object({
  likelyManufacturer: z.string().nullable().describe("labeler name as it would appear in FDA GUDID, or null"),
  likelyBrand: z.string().nullable(),
  likelyProductType: z.string().nullable(),
  cfnVariants: z.array(z.string()).describe("up to 6 alternative catalog-number spellings to try, most likely first"),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type CfnHints = z.infer<typeof HintsSchema>;

/** When openFDA finds nothing, ask the model what the CFN probably is. */
export async function cfnHints(cfn: string, context: { accountName?: string | null; siblingCfns?: string[] }): Promise<CfnHints | null> {
  if (!llmConfig().available) return null;
  const user = [
    `Unresolved competitor catalog number: ${cfn}`,
    context.accountName ? `Customer: ${context.accountName}` : null,
    context.siblingCfns?.length ? `Other codes on the same purchase list (they hint at the manufacturer and hospital item-number prefixes): ${context.siblingCfns.slice(0, 40).join(", ")}` : null,
    "Hospitals often prepend a distributor or item-number prefix (e.g. '3583' + real CFN). Reprocessors relabel codes. Suggest the most plausible original catalog-number spellings, manufacturer, and brand so we can retry the FDA GUDID search.",
  ].filter(Boolean).join("\n");
  const res = await structured({
    purpose: "cfn-hints",
    subject: cfn,
    system: "You are an expert in surgical product catalog numbers (Ethicon, Covidien/Medtronic, Applied Medical, W.L. Gore, BD/Bard, Conmed, Teleflex, Intuitive, Olympus, Stryker, B. Braun). Be concrete and honest about uncertainty.",
    user,
    schema: HintsSchema,
    schemaName: "cfn_hints",
    maxOutputTokens: 600,
  });
  return res.ok ? res.data : null;
}

// Candidate grading lives in src/lib/match/grading.ts (sibling groups + cached verdicts).

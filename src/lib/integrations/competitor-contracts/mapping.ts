/** Canonical competitor contract-price row and the loose default column map for marketing / contracting spreadsheets. */
import type { FieldMap, MappingSpec } from "../core/mapping";

export const CONTRACT_PRICE_SPEC: MappingSpec = { entity: "CompetitorContractPrice", fields: [
  { name: "gpoName", type: "string", description: "GPO the contract belongs to (blank for a national/direct price)" },
  { name: "competitorName", type: "string", required: true, description: "Competitor manufacturer" },
  { name: "competitorSku", type: "string", required: true, description: "Competitor catalog number" },
  { name: "description", type: "string", description: "Product description" },
  { name: "price", type: "money", required: true, description: "Contract price" },
  { name: "currency", type: "string", description: "Currency", example: "USD" },
  { name: "uom", type: "string", description: "Unit of measure (EA, BX, CS…)" },
  { name: "packSize", type: "number", description: "Units per UOM when the price is per box/case" },
  { name: "tier", type: "string", description: "Contract tier" },
  { name: "effectiveFrom", type: "date", description: "Price effective date" },
  { name: "effectiveTo", type: "date", description: "Price expiration date" },
  { name: "contractRef", type: "string", description: "Contract / agreement number" },
  { name: "sourceOwner", type: "string", description: "Who supplied the file (team or person)" },
] };

export const CONTRACT_PRICE_DEFAULT_MAPPING: FieldMap = {
  gpoName: { source: "GPO" }, competitorName: { source: "Manufacturer" }, competitorSku: { source: "Catalog Number" }, description: { source: "Description" }, price: { source: "Contract Price", transform: "money" }, currency: { source: "Currency", default: "USD" }, uom: { source: "UOM", default: "EA" }, packSize: { source: "Pack Size", transform: "number" }, tier: { source: "Tier" }, effectiveFrom: { source: "Effective Date", transform: "date" }, effectiveTo: { source: "Expiration Date", transform: "date" }, contractRef: { source: "Contract Number" },
};

/** UOM synonyms → canonical; unknown UOMs are ambiguous and go to review. */
export const UOM_ALIASES: Record<string, string> = { ea: "EA", each: "EA", pc: "EA", pcs: "EA", unit: "EA", bx: "BX", box: "BX", cs: "CS", case: "CS", ca: "CS", pk: "PK", pack: "PK", dz: "DZ", dozen: "DZ", rl: "RL", roll: "RL", kt: "KT", kit: "KT" };
export function normalizeUom(v: string | null | undefined, extra: Record<string, string> = {}): { uom: string | null; ambiguous: boolean } {
  const s = (v ?? "").trim().toLowerCase().replace(/[.\s]/g, "");
  if (!s) return { uom: "EA", ambiguous: false };
  const hit = extra[s] ?? extra[v?.trim() ?? ""] ?? UOM_ALIASES[s];
  return hit ? { uom: hit.toUpperCase(), ambiguous: false } : { uom: null, ambiguous: true };
}

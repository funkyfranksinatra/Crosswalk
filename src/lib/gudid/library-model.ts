/**
 * Pure pieces of the GUDID library (no database): the openFDA search clause and the
 * record → row mapping. Kept separate so `scripts/check.ts` can test them offline.
 */
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { heuristicBin } from "@/lib/match/bin";
import { displayManufacturer, summarizeRecord, recordCode, type OpenFdaRecord } from "./openfda";

export function phrase(s: string) {
  return `"${encodeURIComponent(s.replace(/"/g, ""))}"`;
}

/** The base search clause for an import: labeler phrase + optional distribution filter. */
export function baseSearch(opts: { query: string; inDistributionOnly?: boolean }): string {
  const parts = [`company_name:${phrase(opts.query)}`];
  if (opts.inDistributionOnly !== false) parts.push(`commercial_distribution_status:${phrase("In Commercial Distribution")}`);
  return parts.join("+AND+");
}

export type DeviceRow = ReturnType<typeof toDeviceRow>;

export function toDeviceRow(r: OpenFdaRecord) {
  const s = summarizeRecord(r);
  const code = recordCode(r);
  const cfnNorm = code ? normalizeCfn(code) : null;
  const family = heuristicBin({ sku: code ?? undefined, brand: s.brand, description: s.description, gmdnName: s.gmdnName, sizes: s.sizes, singleUse: s.singleUse, sterile: s.sterile, implantable: s.implantable }).family;
  return {
    recordKey: r.public_device_record_key ?? `${r.company_name}|${r.version_or_model_number}|${r.catalog_number}`,
    primaryDi: s.gudidDi,
    labeler: r.company_name ?? "Unknown",
    manufacturer: displayManufacturer(r.company_name),
    catalogNumber: r.catalog_number?.trim() || null,
    versionModel: r.version_or_model_number?.trim() || null,
    cfnNorm,
    cfnCompact: cfnNorm ? compactCfn(cfnNorm) : null,
    brand: s.brand,
    description: s.description,
    gmdnName: s.gmdnName,
    gmdnCode: s.gmdnCode,
    fdaProductCode: s.fdaProductCode,
    status: s.status,
    family: family as string | null,
    sizesJson: s.sizes.length ? JSON.stringify(s.sizes) : null,
    singleUse: s.singleUse,
    sterile: s.sterile,
    implantable: s.implantable,
    gudidJson: JSON.stringify(r),
    publishDate: r.publish_date ?? null,
    versionDate: r.public_version_date ?? null,
  };
}


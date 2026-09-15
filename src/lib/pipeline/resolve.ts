/**
 * CFN → GUDID resolution.
 *
 * Two passes. Pass 1 takes the unambiguous hits (exact / punctuation-only
 * variants) and builds a *request context*: which manufacturers and product
 * families this customer's list is about, and whether the hospital prepends
 * an item-number prefix to everything. Pass 2 uses that context to pick
 * between colliding hits for the messy codes (bare numbers, prefixed codes,
 * wildcard matches) and to say how confident it is.
 */
import { prisma } from "@/lib/db";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { searchByCfn, searchOpenFda, searchByBrandAndCompany, summarizeRecord, displayManufacturer, recordCode, type OpenFdaRecord } from "@/lib/gudid/openfda";
import { localHits } from "@/lib/gudid/library";
import { cfnHints } from "@/lib/llm/tasks";
import { heuristicBin, type Family } from "@/lib/match/bin";

export type ResolutionContext = {
  manufacturers: Map<string, number>; // display name -> count
  families: Map<Family, number>;
  commonPrefixes: string[]; // e.g. ["3583"]
  ourName: string;
  preferCompanies: string[];
};

export type Variant = { value: string; reason: string; tier: number; wildcard?: boolean };

const REPROCESSOR = /sterilmed|sustainability|provision|reprocess|innovative health|medline renewal|northeast scientific|renu|arjo|cardinal health/i;

/** Variant generation, ordered by tier (lower = more trustworthy). */
export function variantsFor(cfnNorm: string, ctx?: ResolutionContext, strict = false): Variant[] {
  const out: Variant[] = [];
  const seen = new Set<string>();
  const push = (value: string, reason: string, tier: number, wildcard = false) => {
    const v = value.trim();
    if (v.length < 3 || seen.has(v)) return;
    seen.add(v);
    out.push({ value: v, reason, tier, wildcard });
  };
  push(cfnNorm, "exact", 0);
  const compact = compactCfn(cfnNorm);
  push(compact, "punctuation removed", 0);
  if (/-S$/.test(cfnNorm)) push(cfnNorm.slice(0, -2), "-S suffix removed", 1);
  if (/[A-Z0-9]X$/.test(compact) && compact.length > 5) push(compact.slice(0, -1), "trailing X removed", 1);
  // Excel drops leading zeros; BD/Bard and many EU labelers use 7-digit zero-padded codes.
  if (/^\d+$/.test(compact) && compact.length < 8) {
    for (const w of [7, 6, 5, 8]) if (w > compact.length) push(compact.padStart(w, "0"), `zero-padded to ${w}`, 1);
  }
  if (strict) return out;

  // Hospital / distributor prefixes. A prefix seen across the whole list is trusted (tier 1); a guess is tier 2.
  for (const p of ctx?.commonPrefixes ?? []) {
    if (compact.startsWith(p) && compact.length - p.length >= 4) push(compact.slice(p.length), `list-wide prefix ${p} removed`, 1);
  }
  for (const len of [4, 3, 5]) {
    const m = compact.match(new RegExp(`^(\\d{${len}})([A-Z0-9]{5,})$`));
    if (m) push(m[2], `leading ${len}-digit prefix ${m[1]} removed`, 2);
  }
  // Wildcard "contains" for long cores only (short cores hit everything).
  const cores = out.filter((v) => v.tier >= 1 && /[A-Z]/.test(v.value) && v.value.length >= 6).map((v) => v.value);
  for (const core of [...new Set(cores)].slice(0, 2)) push(`*${core}*`, `contains ${core}`, 3, true);
  return out;
}

type Hit = { record: OpenFdaRecord; variant: Variant; score: number; reasons: string[]; fromLibrary?: boolean };

function scoreHit(record: OpenFdaRecord, variant: Variant, cfn: string, ctx: ResolutionContext | undefined): Hit {
  const reasons: string[] = [];
  let s = 0;
  const recCfn = [(record.catalog_number ?? "").toUpperCase(), (record.version_or_model_number ?? "").toUpperCase()];
  const target = variant.wildcard ? variant.value.replace(/\*/g, "") : variant.value;
  if (recCfn.includes(target)) { s += 3; }
  else if (recCfn.some((c) => c.includes(target))) { s += 1.5; reasons.push("code is a substring of the GUDID code"); }
  s += [4, 3, 2, 0.5][variant.tier] ?? 0;
  if (variant.reason !== "exact") reasons.push(variant.reason);
  const company = record.company_name ?? "";
  if (REPROCESSOR.test(company)) { s -= 2.5; reasons.push("reprocessor / relabeler"); } else s += 1;
  if ((record.commercial_distribution_status ?? "").startsWith("In Commercial")) s += 1;
  if (record.device_description) s += 0.5;
  const disp = displayManufacturer(company);
  if (ctx) {
    if (ctx.manufacturers.has(disp)) { s += 2.5; reasons.push(`manufacturer also appears elsewhere on this list`); }
    if (ctx.preferCompanies.some((c) => company.toLowerCase().includes(c.toLowerCase()))) { s += 1; reasons.push("this is one of our own labelers"); }
    const fam = heuristicBin({ brand: record.brand_name, description: record.device_description, gmdnName: record.gmdn_terms?.[0]?.name }).family;
    if (fam !== "Other" && ctx.families.has(fam)) { s += 1.5; reasons.push(`same product family as the rest of the list (${fam})`); }
    else if (fam === "Other" && ctx.families.size > 0) { s -= 1; reasons.push("product family unlike the rest of the list"); }
  }
  return { record, variant, score: s, reasons };
}

/** Confidence in [0,1] from a hit score; ≥0.75 is accepted silently, lower is flagged for review. */
function confidenceOf(best: Hit, runnerUp?: Hit): number {
  let c = Math.max(0, Math.min(1, (best.score - 2) / 9));
  if (runnerUp && runnerUp.score >= best.score - 1 && displayManufacturer(runnerUp.record.company_name) !== displayManufacturer(best.record.company_name)) c *= 0.7; // real ambiguity
  return Math.round(c * 100) / 100;
}

export async function gatherHits(cfnNorm: string, ctx: ResolutionContext | undefined, strict: boolean): Promise<Hit[]> {
  const variants = variantsFor(cfnNorm, ctx, strict);
  const hits: Hit[] = [];
  const seenKeys = new Set<string>();
  const localVariants = new Set<string>();
  for (const v of variants) {
    // Stop early once a tier-0 hit exists (no point trying prefixes) unless in context pass
    if (hits.some((h) => h.variant.tier === 0) && v.tier >= 2) break;
    // GUDID library first (Catalog → GUDID library): a labeler catalog imported in bulk answers
    // without a network round trip. Only when the library has nothing for this variant do we
    // ask openFDA — so a library that holds Ethicon still resolves Bard codes live.
    const local = await localHits(v.value, Boolean(v.wildcard), 10);
    const results = local.length
      ? local
      : (v.wildcard
        ? await searchOpenFda(`catalog_number:${v.value}+OR+version_or_model_number:${v.value}`, 10)
        : await searchByCfn(v.value, 10)).results;
    if (local.length) localVariants.add(v.value);
    for (const rec of results) {
      const key = rec.public_device_record_key ?? `${rec.company_name}|${rec.version_or_model_number}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const h = scoreHit(rec, v, cfnNorm, ctx);
      if (localVariants.has(v.value)) h.fromLibrary = true;
      hits.push(h);
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

export function buildContext(resolved: { manufacturer: string | null; category: string | null; binFamily: Family | null }[], allCodes: string[], ourName: string, preferCompanies: string[]): ResolutionContext {
  const manufacturers = new Map<string, number>();
  const families = new Map<Family, number>();
  for (const r of resolved) {
    if (r.manufacturer) manufacturers.set(r.manufacturer, (manufacturers.get(r.manufacturer) ?? 0) + 1);
    if (r.binFamily && r.binFamily !== "Other") families.set(r.binFamily, (families.get(r.binFamily) ?? 0) + 1);
  }
  // A 4-digit numeric prefix shared by ≥3 codes (or ≥20% of the list) is a hospital item-number prefix.
  const prefixCounts = new Map<string, number>();
  for (const c of allCodes) {
    const m = compactCfn(c).match(/^(\d{4})[A-Z0-9]{5,}$/);
    if (m) prefixCounts.set(m[1], (prefixCounts.get(m[1]) ?? 0) + 1);
  }
  const commonPrefixes = [...prefixCounts.entries()].filter(([, n]) => n >= 3 || n >= allCodes.length * 0.2).map(([p]) => p);
  return { manufacturers, families, commonPrefixes, ourName, preferCompanies };
}

export type ResolveOptions = { useLlm: boolean; accountName?: string | null; siblingCfns?: string[]; ctx?: ResolutionContext; strict?: boolean; force?: boolean };

/**
 * Resolve one code. Returns the CompetitorProduct row (cached when already
 * resolved with confidence) or null when strict mode found nothing.
 */
export async function resolveCfn(cfnNorm: string, opts: ResolveOptions) {
  const cached = await prisma.competitorProduct.findUnique({ where: { cfnNorm } });
  if (cached && !opts.force && cached.resolution !== "not-found" && (cached.confidence ?? 0) >= 0.75) return cached;
  if (cached && !opts.force && cached.resolution === "manual") return cached;

  const hits = await gatherHits(cfnNorm, opts.ctx, Boolean(opts.strict));
  if (hits.length) {
    const best = hits[0];
    const confidence = confidenceOf(best, hits[1]);
    if (opts.strict && (best.variant.tier > 1 || confidence < 0.75)) return null; // leave for pass 2
    const resolution = best.variant.tier === 0 ? "openfda" : "openfda-variant";
    const via = best.fromLibrary ? "GUDID library" : "GUDID";
    const note = best.variant.reason === "exact" ? `${via} exact hit` : `${via} hit via ${best.variant.reason}${best.reasons.length ? " — " + best.reasons.filter((r) => r !== best.variant.reason).join("; ") : ""}`;
    return upsertFromRecord(cfnNorm, best.record, recordCode(best.record) ?? best.variant.value.replace(/\*/g, ""), resolution, note, confidence, hits.slice(1, 6).map((h) => h.record));
  }
  if (opts.strict) return null;

  // Curated sheet knows the code (description only, no GUDID)
  const known = await prisma.knownCross.findFirst({ where: { competitorCodeNorm: { in: [cfnNorm, compactCfn(cfnNorm)] } } });
  if (known) {
    const data = { cfnMatched: known.competitorCode, manufacturer: known.competitorName, description: known.competitorDescription, category: known.category, resolution: "known-cross", resolutionNote: `Described in curated sheet (${known.source}); not in GUDID`, confidence: 0.8, binJson: null, binSource: null };
    return prisma.competitorProduct.upsert({ where: { cfnNorm }, create: { cfnNorm, ...data }, update: data });
  }

  // Model hints → retry
  if (opts.useLlm) {
    const hints = await cfnHints(cfnNorm, { accountName: opts.accountName, siblingCfns: opts.siblingCfns });
    if (hints) {
      for (const v of hints.cfnVariants.slice(0, 6)) {
        const vv = normalizeCfn(v);
        if (!vv || vv === cfnNorm) continue;
        const r = await searchByCfn(vv, 10);
        if (r.total > 0) {
          const scored = r.results.map((rec) => scoreHit(rec, { value: vv, reason: `model suggested ${vv}`, tier: 2 }, cfnNorm, opts.ctx)).sort((a, b) => b.score - a.score);
          const confidence = Math.min(0.7, confidenceOf(scored[0], scored[1]));
          return upsertFromRecord(cfnNorm, scored[0].record, vv, "llm", `Model suggested ${vv} (${hints.likelyManufacturer ?? "?"}); GUDID confirmed the code exists`, confidence, scored.slice(1, 6).map((h) => h.record));
        }
      }
      if (hints.likelyBrand) {
        const r = await searchByBrandAndCompany(hints.likelyBrand, hints.likelyManufacturer ?? undefined, 25);
        const hit = r.results.find((x) => [x.catalog_number, x.version_or_model_number].some((c) => c && cfnNorm.includes(normalizeCfn(c))));
        if (hit) return upsertFromRecord(cfnNorm, hit, hit.catalog_number ?? hit.version_or_model_number ?? cfnNorm, "llm", `Model pointed at brand ${hints.likelyBrand}; a GUDID code is contained in this code`, 0.6, []);
      }
      const data = { manufacturer: hints.likelyManufacturer, description: hints.likelyProductType ? `${hints.likelyProductType} (unverified model guess, ${Math.round(hints.confidence * 100)}%)` : null, resolution: "not-found", resolutionNote: `Not in GUDID. Model: ${hints.reasoning.slice(0, 240)}`, confidence: 0 };
      return prisma.competitorProduct.upsert({ where: { cfnNorm }, create: { cfnNorm, ...data }, update: data });
    }
  }

  const data = { resolution: "not-found", resolutionNote: "No GUDID record for this code or any of its variants", confidence: 0 };
  return prisma.competitorProduct.upsert({ where: { cfnNorm }, create: { cfnNorm, ...data }, update: data });
}

export { recordCode };

async function upsertFromRecord(cfnNorm: string, r: OpenFdaRecord, matched: string, resolution: string, note: string, confidence: number, alternates: OpenFdaRecord[]) {
  const s = summarizeRecord(r);
  const data = {
    cfnMatched: matched,
    manufacturer: displayManufacturer(s.manufacturer),
    labeler: s.manufacturer,
    brand: s.brand,
    description: s.description,
    gudidDi: s.gudidDi,
    gmdnName: s.gmdnName,
    gmdnCode: s.gmdnCode,
    fdaProductCode: s.fdaProductCode,
    status: s.status,
    gudidJson: JSON.stringify(r),
    resolution,
    resolutionNote: note,
    confidence,
    alternatesJson: JSON.stringify(alternates.map((x) => ({ company: displayManufacturer(x.company_name), brand: x.brand_name, cfn: x.catalog_number ?? x.version_or_model_number, description: (x.device_description ?? "").slice(0, 120), status: x.commercial_distribution_status, key: x.public_device_record_key }))),
    binJson: null,
    binSource: null,
    category: null,
  };
  return prisma.competitorProduct.upsert({ where: { cfnNorm }, create: { cfnNorm, ...data }, update: data });
}

/**
 * GUDID library — a labeler's entire GUDID catalog pulled from openFDA in bulk.
 *
 * Why: resolving a hospital list code-by-code costs one openFDA round trip per variant
 * (≈300 ms each, rate-limited). Once a competitor's catalog is in the database the
 * resolver answers from Postgres first (`localHits`), and anyone can look a product up
 * without leaving Crosswalk. The same import can populate *our* catalog from GUDID
 * (`addToOwnCatalog`) for families the company competes in.
 *
 * openFDA paging: `limit` ≤ 1000 and `skip` ≤ 25 000 → at most 26 000 records per query.
 * Labelers bigger than that (Medtronic ≈ 88k) are split by FDA product code, and any
 * product-code bucket still over the cap is split again by brand. Records carry several
 * product codes, so buckets overlap; we dedupe by `public_device_record_key`.
 */
import { prisma } from "@/lib/db";
import { compactCfn } from "@/lib/cfn";
import { heuristicBin, FAMILIES, type Family } from "@/lib/match/bin";
import { summarizeRecord, type OpenFdaRecord } from "./openfda";
import { baseSearch, phrase, toDeviceRow, type DeviceRow } from "./library-model";

export { baseSearch, toDeviceRow, type DeviceRow };

const BASE = "https://api.fda.gov/device/udi.json";
const PAGE = 1000;
const MAX_SKIP = 25000;
const PER_QUERY_CAP = MAX_SKIP + PAGE;
const PACE_MS = Number(process.env.OPENFDA_PACE_MS ?? (process.env.OPENFDA_API_KEY ? 80 : 260));

export type ImportKind = "COMPETITOR" | "OWN";
export type ImportOptions = {
  query: string;
  kind: ImportKind;
  addToOwnCatalog?: boolean;
  families?: Family[] | null;
  productCodes?: string[] | null;
  inDistributionOnly?: boolean;
  startedById?: string | null;
};

/* ------------------------------------------------------------------------------------ */
/* openFDA plumbing                                                                     */
/* ------------------------------------------------------------------------------------ */

function withKey(url: string) {
  return process.env.OPENFDA_API_KEY ? `${url}&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY)}` : url;
}

async function getJson(url: string, retries = 3): Promise<{ meta?: { results?: { total?: number } }; results?: unknown[]; error?: { code: string } }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(withKey(url), { headers: { accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return { results: [] };
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`openFDA ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function countFor(search: string): Promise<number> {
  const d = await getJson(`${BASE}?search=${search}&limit=1`);
  return d.meta?.results?.total ?? (d.results?.length ?? 0);
}

async function bucketsFor(search: string, field: string): Promise<{ term: string; count: number }[]> {
  const d = await getJson(`${BASE}?search=${search}&count=${field}&limit=1000`);
  return (d.results ?? []) as { term: string; count: number }[];
}

/**
 * Split a search into sub-searches that each fit under openFDA's paging cap.
 * Returns the leaf searches with their expected counts (overlapping — see header).
 */
export async function planSearches(search: string, total?: number, depth = 0): Promise<{ search: string; count: number }[]> {
  const n = total ?? (await countFor(search));
  if (n <= PER_QUERY_CAP || depth >= 2) return [{ search, count: n }];
  const field = depth === 0 ? "product_codes.code.exact" : "brand_name.exact";
  const buckets = await bucketsFor(search, field);
  const out: { search: string; count: number }[] = [];
  for (const b of buckets) {
    const key = depth === 0 ? "product_codes.code" : "brand_name";
    out.push(...(await planSearches(`${search}+AND+${key}:${phrase(b.term)}`, b.count, depth + 1)));
    await sleep(PACE_MS / 2);
  }
  // Records with no value in the split field would otherwise be missed.
  const missingKey = depth === 0 ? "product_codes.code" : "brand_name";
  out.push({ search: `${search}+AND+_missing_:${missingKey}`, count: 0 });
  return out;
}

/** What an import would pull: totals, the labeler names the phrase matches, and the product codes. */
export async function planImport(opts: Pick<ImportOptions, "query" | "inDistributionOnly" | "productCodes">) {
  let search = baseSearch(opts);
  if (opts.productCodes?.length) search += `+AND+(${opts.productCodes.map((c) => `product_codes.code:${phrase(c)}`).join("+OR+")})`;
  const [total, labelers, productCodes] = await Promise.all([countFor(search), bucketsFor(search, "company_name.exact"), bucketsFor(search, "product_codes.code.exact")]);
  const existing = await prisma.gudidDevice.count({ where: { labeler: { in: labelers.map((l) => l.term) } } });
  return { search, total, labelers, productCodes: productCodes.slice(0, 200), existing, requests: Math.ceil(total / PAGE) + (total > PER_QUERY_CAP ? productCodes.length : 0) };
}

/* ------------------------------------------------------------------------------------ */
/* the import runner                                                                     */
/* ------------------------------------------------------------------------------------ */

const cancelled = new Set<string>();
const running = new Map<string, Promise<void>>();

export function cancelImport(id: string) {
  cancelled.add(id);
}

export async function startImport(opts: ImportOptions) {
  const active = await prisma.gudidImport.findFirst({ where: { status: { in: ["QUEUED", "RUNNING"] } } });
  if (active && running.has(active.id)) throw new Error(`An import is already running (${active.query}); wait for it or cancel it first`);
  if (active) {
    // RUNNING in the database but not in this process: the server restarted mid-import.
    // Its rows are intact; re-running the labeler refreshes and completes it.
    await prisma.gudidImport.update({ where: { id: active.id }, data: { status: "FAILED", error: "Interrupted by a server restart — run the import again to complete it", finishedAt: new Date() } });
  }
  const row = await prisma.gudidImport.create({
    data: {
      query: opts.query.trim(),
      kind: opts.kind,
      addToOwnCatalog: Boolean(opts.addToOwnCatalog),
      familiesJson: opts.families?.length ? JSON.stringify(opts.families) : null,
      productCodesJson: opts.productCodes?.length ? JSON.stringify(opts.productCodes) : null,
      inDistributionOnly: opts.inDistributionOnly !== false,
      startedById: opts.startedById ?? null,
    },
  });
  const p = runImport(row.id).catch(() => undefined).finally(() => running.delete(row.id));
  running.set(row.id, p);
  return row;
}

async function appendLog(id: string, line: string, patch: Record<string, unknown> = {}) {
  const cur = await prisma.gudidImport.findUnique({ where: { id }, select: { log: true } });
  const log = `${cur?.log ?? ""}${new Date().toISOString().slice(11, 19)} ${line}\n`.split("\n").slice(-60).join("\n");
  await prisma.gudidImport.update({ where: { id }, data: { log, ...patch } });
}

export async function runImport(id: string) {
  const job = await prisma.gudidImport.findUniqueOrThrow({ where: { id } });
  const productCodes = job.productCodesJson ? (JSON.parse(job.productCodesJson) as string[]) : null;
  const families = job.familiesJson ? (JSON.parse(job.familiesJson) as Family[]) : null;
  let search = baseSearch({ query: job.query, inDistributionOnly: job.inDistributionOnly });
  if (productCodes?.length) search += `+AND+(${productCodes.map((c) => `product_codes.code:${phrase(c)}`).join("+OR+")})`;

  const seen = new Set<string>();
  let fetched = 0, created = 0, updated = 0, ownAdded = 0, errors = 0;
  try {
    await prisma.gudidImport.update({ where: { id }, data: { status: "RUNNING" } });
    const total = await countFor(search);
    await appendLog(id, `openFDA reports ${total.toLocaleString()} records for "${job.query}"`, { expected: total });
    const leaves = await planSearches(search, total);
    if (leaves.length > 1) await appendLog(id, `Split into ${leaves.length} product-code queries (openFDA pages at most 26,000 per query)`);

    for (const leaf of leaves) {
      for (let skip = 0; skip <= MAX_SKIP; skip += PAGE) {
        if (cancelled.has(id)) throw new Error("cancelled");
        const d = await getJson(`${BASE}?search=${leaf.search}&limit=${PAGE}&skip=${skip}`);
        const recs = (d.results ?? []) as OpenFdaRecord[];
        if (recs.length === 0) break;
        const fresh = recs.filter((r) => { const k = r.public_device_record_key ?? ""; if (!k || seen.has(k)) return false; seen.add(k); return true; });
        fetched += fresh.length;
        try {
          const res = await upsertDevices(id, fresh);
          created += res.created;
          updated += res.updated;
          if (job.addToOwnCatalog) ownAdded += await adoptIntoOwnCatalog(fresh.map(toDeviceRow), families);
        } catch (e) {
          errors++;
          await appendLog(id, `! page skip=${skip}: ${e instanceof Error ? e.message : e}`);
        }
        await prisma.gudidImport.update({ where: { id }, data: { fetched, created, updated, ownAdded, errors } });
        if (recs.length < PAGE) break;
        await sleep(PACE_MS);
      }
    }
    await appendLog(id, `Done: ${fetched.toLocaleString()} records — ${created.toLocaleString()} new, ${updated.toLocaleString()} refreshed${job.addToOwnCatalog ? `, ${ownAdded.toLocaleString()} added to our catalog` : ""}`, { status: "DONE", finishedAt: new Date(), fetched, created, updated, ownAdded, errors });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await appendLog(id, msg === "cancelled" ? "Cancelled" : `Failed: ${msg}`, { status: msg === "cancelled" ? "CANCELLED" : "FAILED", error: msg === "cancelled" ? null : msg, finishedAt: new Date(), fetched, created, updated, ownAdded, errors });
  } finally {
    cancelled.delete(id);
  }
}

/** Insert new records; refresh rows whose GUDID version date moved. */
async function upsertDevices(importId: string, recs: OpenFdaRecord[]) {
  const rows = recs.map(toDeviceRow);
  const existing = await prisma.gudidDevice.findMany({ where: { recordKey: { in: rows.map((r) => r.recordKey) } }, select: { id: true, recordKey: true, versionDate: true } });
  const byKey = new Map(existing.map((e) => [e.recordKey, e]));
  const fresh = rows.filter((r) => !byKey.has(r.recordKey));
  const stale = rows.filter((r) => { const e = byKey.get(r.recordKey); return e && e.versionDate !== r.versionDate; });
  if (fresh.length) await prisma.gudidDevice.createMany({ data: fresh.map((r) => ({ ...r, importId })), skipDuplicates: true });
  for (const r of stale) await prisma.gudidDevice.update({ where: { recordKey: r.recordKey }, data: { ...r, importId } });
  return { created: fresh.length, updated: stale.length };
}

/**
 * Add library records to OwnProduct (skipping SKUs already there). Family filter keeps the
 * matcher's candidate pool relevant — a whole labeler catalog would otherwise include
 * every pacemaker and pump the company sells.
 */
export async function adoptIntoOwnCatalog(rows: DeviceRow[], families: Family[] | null) {
  const { getCompany } = await import("@/lib/settings");
  const company = await getCompany();
  // "Other" is never adopted: the binner could not place the product in a family the matcher knows,
  // so it would only dilute the candidate pool (a whole-labeler import is mostly other divisions).
  const wanted = rows.filter((r) => r.cfnNorm && r.family && r.family !== "Other" && (!families || families.includes(r.family as Family)));
  if (!wanted.length) return 0;
  // One row per SKU: prefer the record with sizes, then the most recent version.
  const bySku = new Map<string, DeviceRow>();
  for (const r of wanted) {
    const cur = bySku.get(r.cfnNorm!);
    if (!cur || (!cur.sizesJson && r.sizesJson) || (cur.sizesJson === r.sizesJson && (r.versionDate ?? "") > (cur.versionDate ?? ""))) bySku.set(r.cfnNorm!, r);
  }
  const skus = [...bySku.keys()];
  const present = new Set((await prisma.ownProduct.findMany({ where: { companyId: company.id, sku: { in: skus } }, select: { sku: true } })).map((p) => p.sku));
  const data = skus.filter((s) => !present.has(s)).map((sku) => {
    const r = bySku.get(sku)!;
    const raw = JSON.parse(r.gudidJson) as OpenFdaRecord;
    const s = summarizeRecord(raw);
    const bin = heuristicBin({ sku, brand: r.brand, description: r.description, gmdnName: r.gmdnName, specialties: s.specialties, sizes: s.sizes, singleUse: s.singleUse, sterile: s.sterile, implantable: s.implantable });
    return {
      companyId: company.id, sku, description: r.description ?? sku, category: bin.family, brand: r.brand, labeler: r.labeler, status: r.status,
      gudidDi: r.primaryDi, gmdnName: r.gmdnName, gmdnCode: r.gmdnCode, fdaProductCode: r.fdaProductCode, gudidJson: r.gudidJson, gudidSyncedAt: new Date(),
      binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date(), source: "gudid-import",
    };
  });
  if (!data.length) return 0;
  const res = await prisma.ownProduct.createMany({ data, skipDuplicates: true });
  return res.count;
}

/** Adopt specific library records (by recordKey) into our catalog — the per-row button. */
export async function adoptRecords(recordKeys: string[]) {
  const devices = await prisma.gudidDevice.findMany({ where: { recordKey: { in: recordKeys } } });
  return adoptIntoOwnCatalog(devices, null);
}

/**
 * Re-evaluate SKUs that imports added to our catalog with the current binning rules, and
 * remove the ones that do not belong: everything now classified "Other", plus (optionally)
 * whole families. SKUs already referenced by a match, proposal, price, cost or purchase are
 * deactivated instead of deleted so history stays intact.
 */
export async function pruneAdopted(opts: { families?: string[] | null; dryRun?: boolean } = {}) {
  const { getCompany } = await import("@/lib/settings");
  const company = await getCompany();
  const drop = new Set(opts.families ?? []);
  let rebinned = 0, deleted = 0, deactivated = 0, kept = 0;
  const PAGE = 500;
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.ownProduct.findMany({ where: { companyId: company.id, source: "gudid-import", ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: PAGE, select: { id: true, sku: true, brand: true, description: true, gmdnName: true, gudidJson: true, category: true, binJson: true, binSource: true, isActive: true, _count: { select: { candidates: true, proposalLines: true, prices: true, costs: true, purchases: true } } } });
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    const toDelete: string[] = [];
    const toDeactivate: string[] = [];
    for (const p of batch) {
      const raw = p.gudidJson ? (JSON.parse(p.gudidJson) as OpenFdaRecord) : null;
      const g = raw ? summarizeRecord(raw) : null;
      const bin = heuristicBin({ sku: p.sku, brand: p.brand, description: p.description, gmdnName: p.gmdnName, specialties: g?.specialties, sizes: g?.sizes, singleUse: g?.singleUse, sterile: g?.sterile, implantable: g?.implantable });
      const referenced = Object.values(p._count).some((n) => n > 0);
      if (bin.family === "Other" || drop.has(bin.family)) {
        if (referenced) toDeactivate.push(p.id); else toDelete.push(p.id);
        continue;
      }
      kept++;
      if (!opts.dryRun && (p.category !== bin.family || p.binSource !== "llm")) {
        await prisma.ownProduct.update({ where: { id: p.id }, data: { category: bin.family, ...(p.binSource !== "llm" ? { binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date() } : {}) } });
        rebinned++;
      }
    }
    if (!opts.dryRun) {
      if (toDelete.length) await prisma.ownProduct.deleteMany({ where: { id: { in: toDelete } } });
      if (toDeactivate.length) await prisma.ownProduct.updateMany({ where: { id: { in: toDeactivate } }, data: { isActive: false } });
    }
    deleted += toDelete.length;
    deactivated += toDeactivate.length;
  }
  return { kept, rebinned, deleted, deactivated };
}

/* ------------------------------------------------------------------------------------ */
/* resolver hook                                                                        */
/* ------------------------------------------------------------------------------------ */

/**
 * Library hits for one resolver variant, returned as openFDA records so the resolver
 * scores them with the same rules as live hits. Wildcards (`*CORE*`) become a
 * `contains` on the compact code.
 */
export async function localHits(variantValue: string, wildcard: boolean, limit = 10): Promise<OpenFdaRecord[]> {
  const v = variantValue.replace(/\*/g, "");
  if (!v) return [];
  const rows = wildcard
    ? await prisma.gudidDevice.findMany({ where: { cfnCompact: { contains: compactCfn(v) } }, take: limit, select: { gudidJson: true } })
    : await prisma.gudidDevice.findMany({ where: { OR: [{ cfnNorm: v }, { cfnCompact: compactCfn(v) }] }, take: limit, select: { gudidJson: true } });
  return rows.map((r) => JSON.parse(r.gudidJson) as OpenFdaRecord);
}

export async function libraryStats() {
  const [total, byManufacturer, imports] = await Promise.all([
    prisma.gudidDevice.count(),
    prisma.gudidDevice.groupBy({ by: ["manufacturer"], _count: { _all: true }, orderBy: { _count: { manufacturer: "desc" } } }),
    prisma.gudidImport.findMany({ orderBy: { startedAt: "desc" }, take: 20, include: { startedBy: { select: { name: true } } } }),
  ]);
  return { total, byManufacturer: byManufacturer.map((m) => ({ manufacturer: m.manufacturer, count: m._count._all })), imports };
}

export const IMPORT_FAMILIES = FAMILIES;

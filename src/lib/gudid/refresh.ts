/**
 * GUDID cache expiry. A resolved competitor code (CompetitorProduct) and an enriched own
 * SKU (OwnProduct.gudidJson) are snapshots of a GUDID record that can change: a device
 * leaves commercial distribution, a labeler corrects sizes, a brand is renamed.
 *
 * Policy: records older than GUDID_CACHE_TTL_DAYS (default 90) are *served stale* —
 * a run never waits on a refresh — and re-checked in the background: the nightly
 * `gudid.refresh` job sweeps the oldest rows; the resolver also enqueues a one-off
 * refresh for a stale row the moment it is used, so hot codes are never far behind.
 *
 * A refresh only touches the row when openFDA's `public_version_date` moved; the bin is
 * then cleared so the next run re-bins from the new record.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { lookupByDi, summarizeRecord, displayManufacturer, type OpenFdaRecord } from "./openfda";

export function ttlDays(): number {
  const n = Number(process.env.GUDID_CACHE_TTL_DAYS ?? 90);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

export function isStale(checkedAt: Date | null, fallback: Date | null): boolean {
  const at = checkedAt ?? fallback;
  if (!at) return true;
  return Date.now() - at.getTime() > ttlDays() * 86_400_000;
}

/** Fire-and-forget: queue a refresh of one code if it is past its TTL (deduplicated per code). */
export async function refreshIfStale(row: { cfnNorm: string; gudidCheckedAt: Date | null; resolvedAt: Date; gudidDi: string | null; resolution: string }) {
  if (!row.gudidDi || !["openfda", "openfda-variant", "llm"].includes(row.resolution)) return;
  if (!isStale(row.gudidCheckedAt, row.resolvedAt)) return;
  try {
    const { enqueue, jobsEnabled } = await import("@/lib/jobs/boss");
    if (!jobsEnabled()) return;
    await enqueue("gudid.refresh", { cfnNorm: row.cfnNorm }, { singletonKey: `refresh:${row.cfnNorm}` });
  } catch (e) {
    log.warn("gudid.refresh_enqueue_failed", { cfnNorm: row.cfnNorm, error: e instanceof Error ? e.message : String(e) });
  }
}

export type RefreshReport = { checked: number; changed: number; missing: number; errors: number; ownChecked: number; ownChanged: number };

/** Re-check one code, or the `limit` oldest stale rows (competitor products first, then own SKUs). */
export async function refreshStaleRecords(opts: { cfnNorm?: string; limit?: number } = {}): Promise<RefreshReport> {
  const cutoff = new Date(Date.now() - ttlDays() * 86_400_000);
  const rep: RefreshReport = { checked: 0, changed: 0, missing: 0, errors: 0, ownChecked: 0, ownChanged: 0 };
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 200));

  const rows = opts.cfnNorm
    ? await prisma.competitorProduct.findMany({ where: { cfnNorm: opts.cfnNorm } })
    : await prisma.competitorProduct.findMany({
        where: { resolution: { in: ["openfda", "openfda-variant", "llm"] }, gudidDi: { not: null }, OR: [{ gudidCheckedAt: null, resolvedAt: { lt: cutoff } }, { gudidCheckedAt: { lt: cutoff } }] },
        orderBy: [{ gudidCheckedAt: { sort: "asc", nulls: "first" } }, { resolvedAt: "asc" }],
        take: limit,
      });
  for (const row of rows) {
    if (!row.gudidDi) continue;
    rep.checked++;
    try {
      const rec = await lookupByDi(row.gudidDi);
      if (!rec) {
        rep.missing++;
        await prisma.competitorProduct.update({ where: { id: row.id }, data: { gudidCheckedAt: new Date(), resolutionNote: appendNote(row.resolutionNote, "GUDID record no longer found on refresh") } });
        continue;
      }
      const prev = row.gudidJson ? (JSON.parse(row.gudidJson) as OpenFdaRecord) : null;
      if (prev?.public_version_date && prev.public_version_date === rec.public_version_date) {
        await prisma.competitorProduct.update({ where: { id: row.id }, data: { gudidCheckedAt: new Date() } });
        continue;
      }
      const s = summarizeRecord(rec);
      await prisma.competitorProduct.update({ where: { id: row.id }, data: { manufacturer: displayManufacturer(s.manufacturer), labeler: s.manufacturer, brand: s.brand, description: s.description, gmdnName: s.gmdnName, gmdnCode: s.gmdnCode, fdaProductCode: s.fdaProductCode, status: s.status, gudidJson: JSON.stringify(rec), gudidCheckedAt: new Date(), binJson: null, binSource: null, binnedAt: null, resolutionNote: appendNote(row.resolutionNote, `GUDID record updated on refresh (${prev?.public_version_date ?? "?"} → ${rec.public_version_date ?? "?"})`) } });
      rep.changed++;
    } catch (e) {
      rep.errors++;
      log.warn("gudid.refresh_error", { cfnNorm: row.cfnNorm, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Own SKUs: distribution status is what matters (a retired SKU must not be quoted).
  if (!opts.cfnNorm) {
    const own = await prisma.ownProduct.findMany({ where: { gudidDi: { not: null }, OR: [{ gudidSyncedAt: null }, { gudidSyncedAt: { lt: cutoff } }] }, orderBy: { gudidSyncedAt: { sort: "asc", nulls: "first" } }, take: Math.max(1, Math.floor(limit / 2)) });
    for (const p of own) {
      rep.ownChecked++;
      try {
        const rec = await lookupByDi(p.gudidDi!);
        if (!rec) { await prisma.ownProduct.update({ where: { id: p.id }, data: { gudidSyncedAt: new Date() } }); continue; }
        const prev = p.gudidJson ? (JSON.parse(p.gudidJson) as OpenFdaRecord) : null;
        if (prev?.public_version_date && prev.public_version_date === rec.public_version_date) { await prisma.ownProduct.update({ where: { id: p.id }, data: { gudidSyncedAt: new Date() } }); continue; }
        const s = summarizeRecord(rec);
        await prisma.ownProduct.update({ where: { id: p.id }, data: { status: s.status, gudidJson: JSON.stringify(rec), gudidSyncedAt: new Date(), gmdnName: s.gmdnName, gmdnCode: s.gmdnCode, fdaProductCode: s.fdaProductCode, ...(p.binSource !== "llm" ? { binJson: null, binSource: null, binnedAt: null } : {}) } });
        rep.ownChanged++;
      } catch (e) {
        rep.errors++;
        log.warn("gudid.refresh_own_error", { sku: p.sku, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  log.info("gudid.refresh_done", { ...rep, ttlDays: ttlDays(), one: opts.cfnNorm ?? null });
  return rep;
}

function appendNote(existing: string | null, note: string) {
  const base = (existing ?? "").replace(/\s*\|\s*GUDID record (updated|no longer found)[^|]*$/, "");
  return `${base}${base ? " | " : ""}${note}`.slice(0, 1000);
}

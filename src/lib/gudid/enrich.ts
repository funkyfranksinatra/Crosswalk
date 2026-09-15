/**
 * Enrich own products from openFDA: brand, labeler, GMDN, sizes, status.
 * Prefers our own labelers (Covidien / Medtronic / Sofradim) over
 * reprocessors that relabel the same catalog number.
 */
import { prisma } from "@/lib/db";
import { searchByCfn, rankHits, summarizeRecord } from "./openfda";
import { heuristicBin } from "@/lib/match/bin";

export async function enrichOwnProducts(companyId: string, onProgress?: (msg: string) => void, opts: { onlyMissing?: boolean; limit?: number } = {}) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const prefer = JSON.parse(company.labelers || "[]") as string[];
  const products = await prisma.ownProduct.findMany({ where: { companyId, ...(opts.onlyMissing === false ? {} : { gudidSyncedAt: null }) }, orderBy: { sku: "asc" }, take: opts.limit });
  let enriched = 0;
  let missing = 0;
  let i = 0;
  for (const p of products) {
    i++;
    try {
      const r = await searchByCfn(p.sku, 10);
      const own = r.results.filter((x) => prefer.some((c) => (x.company_name ?? "").toLowerCase().includes(c.toLowerCase())));
      const best = rankHits(own.length ? own : r.results, p.sku, prefer)[0];
      if (!best) {
        missing++;
        await prisma.ownProduct.update({ where: { id: p.id }, data: { gudidSyncedAt: new Date() } });
      } else {
        const s = summarizeRecord(best);
        const bin = heuristicBin({ sku: p.sku, brand: s.brand, description: `${p.description} ; ${s.description ?? ""}`, category: p.category, gmdnName: s.gmdnName, specialties: s.specialties, sizes: s.sizes, singleUse: s.singleUse, sterile: s.sterile, implantable: s.implantable });
        await prisma.ownProduct.update({
          where: { id: p.id },
          data: {
            brand: s.brand,
            labeler: s.manufacturer,
            status: s.status,
            gudidDi: s.gudidDi,
            gmdnName: s.gmdnName,
            gmdnCode: s.gmdnCode,
            fdaProductCode: s.fdaProductCode,
            gudidJson: JSON.stringify(best),
            gudidSyncedAt: new Date(),
            ...(p.binSource !== "llm" ? { binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date() } : {}),
          },
        });
        enriched++;
      }
    } catch (e) {
      onProgress?.(`  ! ${p.sku}: ${e instanceof Error ? e.message : e}`);
    }
    if (i % 25 === 0) onProgress?.(`  ${i}/${products.length} (${enriched} enriched, ${missing} missing)`);
    await new Promise((res) => setTimeout(res, 260)); // stay under openFDA's 240 req/min without a key
  }
  return { enriched, missing, total: products.length };
}

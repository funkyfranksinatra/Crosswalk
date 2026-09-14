import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCompany } from "@/lib/settings";
import { normalizeCfn } from "@/lib/cfn";
import { searchByCfn, rankHits, summarizeRecord } from "@/lib/gudid/openfda";
import { heuristicBin } from "@/lib/match/bin";

/** Add own SKUs by catalog number; each is looked up in GUDID under our labelers. */
export async function POST(req: Request) {
  const body = (await req.json()) as { skus: string; category?: string };
  const company = await getCompany();
  const prefer = JSON.parse(company.labelers || "[]") as string[];
  const skus = [...new Set(body.skus.split(/[\s,;]+/).map(normalizeCfn).filter(Boolean))].slice(0, 100);
  const results: { sku: string; status: "added" | "exists" | "not-found" | "added-unverified"; description?: string }[] = [];
  for (const sku of skus) {
    const exists = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku } } });
    if (exists) { results.push({ sku, status: "exists", description: exists.description }); continue; }
    const r = await searchByCfn(sku, 10);
    const own = r.results.filter((x) => prefer.some((c) => (x.company_name ?? "").toLowerCase().includes(c.toLowerCase())));
    const best = rankHits(own, sku, prefer)[0];
    if (!best) {
      results.push({ sku, status: "not-found" });
      continue;
    }
    const s = summarizeRecord(best);
    const bin = heuristicBin({ sku, brand: s.brand, description: s.description, category: body.category, gmdnName: s.gmdnName, sizes: s.sizes, singleUse: s.singleUse, sterile: s.sterile, implantable: s.implantable });
    await prisma.ownProduct.create({
      data: { companyId: company.id, sku, description: s.description ?? sku, category: body.category || bin.family, brand: s.brand, labeler: s.manufacturer, status: s.status, gudidDi: s.gudidDi, gmdnName: s.gmdnName, gmdnCode: s.gmdnCode, fdaProductCode: s.fdaProductCode, gudidJson: JSON.stringify(best), gudidSyncedAt: new Date(), binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date() },
    });
    results.push({ sku, status: "added", description: s.description ?? undefined });
    await new Promise((res) => setTimeout(res, 260));
  }
  return NextResponse.json({ results });
}

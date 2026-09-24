import { prisma } from "@/lib/db";
import { getCompany } from "@/lib/settings";
import { PageHeader, Card, Stat } from "@/components/ui";
import { parseBin } from "@/lib/match/bin";
import { num } from "@/lib/money";
import { CatalogTable, CatalogActions } from "./client";
import { getActor, can } from "@/lib/auth";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ q?: string; cat?: string; only?: string }> }) {
  const { q = "", cat = "", only = "" } = await searchParams;
  const actor = await getActor();
  // Prices are commercial data: list / pricebook prices need view_pricing, COGS needs view_cost.
  // Roles without either (CLINICAL_REVIEWER) still see the catalog itself — SKUs, GUDID, bins.
  const showPrice = can(actor, "view_pricing");
  const showCost = can(actor, "view_cost");
  const company = await getCompany();
  const where = {
    companyId: company.id,
    ...(cat ? { category: cat } : {}),
    ...(only === "unpriced" ? { listPrice: null, prices: { none: {} } } : only === "nogudid" ? { gudidDi: null } : only === "discontinued" ? { status: { contains: "Not in" } } : {}),
    ...(q ? { OR: [{ sku: { contains: q } }, { description: { contains: q } }, { brand: { contains: q } }] } : {}),
  };
  const [products, categories, total, priced, withGudid, pricebooks, specCount, competitors] = await Promise.all([
    prisma.ownProduct.findMany({ where, orderBy: [{ category: "asc" }, { sku: "asc" }], include: { prices: { include: { pricebook: true } }, _count: { select: { candidates: true } } }, take: 500 }),
    prisma.ownProduct.groupBy({ by: ["category"], where: { companyId: company.id }, _count: { _all: true }, orderBy: { category: "asc" } }),
    prisma.ownProduct.count({ where: { companyId: company.id } }),
    prisma.ownProduct.count({ where: { companyId: company.id, OR: [{ listPrice: { not: null } }, { prices: { some: {} } }] } }),
    prisma.ownProduct.count({ where: { companyId: company.id, gudidDi: { not: null } } }),
    prisma.pricebook.findMany({ orderBy: { name: "asc" } }),
    prisma.competitorSpec.count(),
    prisma.competitorProduct.findMany({ where: { resolution: { not: "not-found" } }, select: { binJson: true, manufacturer: true } }),
  ]);
  // Competitor codes we have seen that still have no width/length/diameter — the sizes import fills these.
  const unsized = competitors.filter((c) => c.manufacturer !== company.name && !parseBin(c.binJson, { allowStale: true })?.dimensions.some((d) => ["width", "length", "diameter"].includes(d.name))).length;
  return (
    <>
      <PageHeader eyebrow={company.name} title="Our catalog" description="Every SKU Crosswalk can propose. Seeded from the curated cross-reference sheets, enriched from FDA GUDID, priced from your import." actions={<CatalogActions canManage={can(actor, "manage_catalog")} canImportCost={can(actor, "import_cost_data")} />} />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        <Stat label="SKUs" value={total} />
        <Stat label="With GUDID record" value={withGudid} hint={withGudid < total ? `${total - withGudid} to enrich` : "complete"} tone="accent" />
        <Stat label="Priced" value={priced} hint={priced ? `${pricebooks.length} pricebook${pricebooks.length === 1 ? "" : "s"}` : "import pricing to rank on money"} tone={priced ? "exact" : "alt"} />
        <Stat label="Competitor sizes" value={specCount} hint={unsized ? `${unsized} competitor code${unsized === 1 ? "" : "s"} seen without a size` : competitors.length ? "every competitor code seen has a size" : "none seen yet"} tone={unsized ? "alt" : "exact"} />
        <Stat label="Categories" value={categories.length} />
      </div>
      <Card padded={false}>
        <CatalogTable
          products={products.map((p) => ({ id: p.id, sku: p.sku, description: p.description, category: p.category, brand: p.brand, labeler: p.labeler, status: p.status, gudidDi: p.gudidDi, gmdnName: p.gmdnName, listPrice: showPrice ? num(p.listPrice) : null, cogs: showCost ? num(p.cogs) : null, binJson: p.binJson, binSource: p.binSource, prices: showPrice ? p.prices.filter((e) => e.pricebook).map((e) => ({ name: e.pricebook!.name, price: num(e.price) ?? 0 })) : [], used: p._count.candidates }))}
          categories={categories.map((c) => ({ name: c.category ?? "Uncategorised", count: c._count._all }))}
          q={q} cat={cat} only={only} total={total} showPrice={showPrice} showCost={showCost}
        />
      </Card>
    </>
  );
}

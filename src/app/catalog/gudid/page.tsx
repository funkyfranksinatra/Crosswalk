import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCompany } from "@/lib/settings";
import { getActor } from "@/lib/auth";
import { PageHeader, Card, Stat, Empty } from "@/components/ui";
import { FAMILIES } from "@/lib/match/bin";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { LibraryTable, ImportPanel, ImportHistory } from "./client";

export default async function GudidLibraryPage({ searchParams }: { searchParams: Promise<{ q?: string; mfr?: string; fam?: string }> }) {
  const { q = "", mfr = "", fam = "" } = await searchParams;
  const actor = await getActor();
  if (!actor) return <Empty title="Sign in to use the GUDID library">Use the development sign-in in the sidebar.</Empty>;
  const canManage = actor.permissions.has("manage_catalog");
  const company = await getCompany();
  const ownLabelers = JSON.parse(company.labelers || "[]") as string[];

  const code = q ? normalizeCfn(q) : "";
  const where = {
    ...(mfr ? { manufacturer: mfr } : {}),
    ...(fam ? { family: fam } : {}),
    ...(q
      ? { OR: [{ cfnNorm: code }, { cfnCompact: { contains: compactCfn(code) } }, { primaryDi: q.trim() }, { brand: { contains: q, mode: "insensitive" as const } }, { description: { contains: q, mode: "insensitive" as const } }, { gmdnName: { contains: q, mode: "insensitive" as const } }] }
      : {}),
  };
  const [rows, total, matched, byManufacturer, byFamily, imports, ownSkus] = await Promise.all([
    prisma.gudidDevice.findMany({ where, orderBy: [{ manufacturer: "asc" }, { brand: "asc" }, { cfnNorm: "asc" }], take: 300 }),
    prisma.gudidDevice.count(),
    prisma.gudidDevice.count({ where }),
    prisma.gudidDevice.groupBy({ by: ["manufacturer"], _count: { _all: true }, orderBy: { _count: { manufacturer: "desc" } } }),
    prisma.gudidDevice.groupBy({ by: ["family"], _count: { _all: true } }),
    prisma.gudidImport.findMany({ orderBy: { startedAt: "desc" }, take: 12, include: { startedBy: { select: { name: true } } } }),
    prisma.ownProduct.findMany({ where: { companyId: company.id }, select: { sku: true } }),
  ]);
  const ownSet = new Set(ownSkus.map((s) => s.sku));
  const running = imports.find((i) => i.status === "RUNNING" || i.status === "QUEUED") ?? null;
  const isOwnLabeler = (labeler: string) => ownLabelers.some((l) => labeler.toLowerCase().includes(l.toLowerCase()));

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/catalog" className="hover:underline">Our catalog</Link>}
        title="GUDID library"
        description="Whole labeler catalogs from FDA GUDID, kept in Crosswalk. The cross-reference engine answers from here before it asks openFDA, and anyone can look a product up by code, brand, DI or description."
        actions={canManage ? <ImportPanel families={[...FAMILIES]} ownLabelers={ownLabelers} running={running ? { id: running.id, query: running.query } : null} /> : undefined}
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Records" value={total.toLocaleString()} hint={total ? `${byManufacturer.length} manufacturer${byManufacturer.length === 1 ? "" : "s"}` : "import a labeler to start"} tone="accent" />
        <Stat label="Manufacturers" value={byManufacturer.length} hint={byManufacturer.slice(0, 3).map((m) => m.manufacturer).join(" · ") || "—"} />
        <Stat label="Imports" value={imports.length} hint={running ? `running: ${running.query}` : imports[0] ? `last: ${imports[0].query}` : "none yet"} tone={running ? "close" : "none"} />
        <Stat label="Matching" value={matched.toLocaleString()} hint={q || mfr || fam ? "for the current filter" : "everything"} />
      </div>
      <Card padded={false} className="mb-5">
        <LibraryTable
          rows={rows.map((r) => ({ id: r.id, recordKey: r.recordKey, code: r.cfnNorm ?? r.catalogNumber ?? r.versionModel ?? "—", catalogNumber: r.catalogNumber, versionModel: r.versionModel, brand: r.brand, description: r.description, manufacturer: r.manufacturer, labeler: r.labeler, gmdnName: r.gmdnName, fdaProductCode: r.fdaProductCode, status: r.status, family: r.family, sizes: r.sizesJson ? (JSON.parse(r.sizesJson) as { type?: string; value?: string; unit?: string; text?: string }[]) : [], primaryDi: r.primaryDi, singleUse: r.singleUse, sterile: r.sterile, implantable: r.implantable, isOwn: isOwnLabeler(r.labeler), inCatalog: r.cfnNorm ? ownSet.has(r.cfnNorm) : false }))}
          manufacturers={byManufacturer.map((m) => ({ name: m.manufacturer, count: m._count._all }))}
          families={byFamily.filter((f) => f.family).map((f) => ({ name: f.family!, count: f._count._all }))}
          q={q} mfr={mfr} fam={fam} matched={matched} canManage={canManage}
        />
      </Card>
      <ImportHistory imports={imports.map((i) => ({ id: i.id, query: i.query, kind: i.kind, status: i.status, expected: i.expected, fetched: i.fetched, created: i.created, updated: i.updated, ownAdded: i.ownAdded, errors: i.errors, addToOwnCatalog: i.addToOwnCatalog, startedAt: i.startedAt.toISOString(), finishedAt: i.finishedAt?.toISOString() ?? null, startedBy: i.startedBy?.name ?? null, log: i.log, error: i.error }))} canManage={canManage} />
    </>
  );
}

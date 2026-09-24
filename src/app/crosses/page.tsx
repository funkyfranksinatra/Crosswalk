import { prisma } from "@/lib/db";
import { PageHeader, Card, Stat, MatchChip, Empty, Chip } from "@/components/ui";
import { CrossFilters } from "./filters";
import { Governance } from "./governance";
import { getActor, can } from "@/lib/auth";
import { Pill } from "@/components/commercial";

export default async function CrossesPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; company?: string; source?: string }> }) {
  const { q = "", type = "", company = "", source = "" } = await searchParams;
  const where = {
    ...(type ? { matchType: type } : {}),
    ...(company ? { competitorName: company } : {}),
    ...(source ? { source } : {}),
    ...(q ? { OR: [{ ownSku: { contains: q } }, { competitorCode: { contains: q } }, { ownDescription: { contains: q } }, { competitorDescription: { contains: q } }] } : {}),
  };
  const [rows, total, byType, byCompany, bySource] = await Promise.all([
    prisma.knownCross.findMany({ where, orderBy: [{ category: "asc" }, { ownSku: "asc" }], take: 400 }),
    prisma.knownCross.count(),
    prisma.knownCross.groupBy({ by: ["matchType"], _count: { _all: true } }),
    prisma.knownCross.groupBy({ by: ["competitorName"], _count: { _all: true }, orderBy: { _count: { competitorName: "desc" } } }),
    prisma.knownCross.groupBy({ by: ["source"], _count: { _all: true } }),
  ]);
  const count = (t: string) => byType.find((b) => b.matchType === t)?._count._all ?? 0;
  const actor = await getActor();
  return (
    <>
      <PageHeader eyebrow="Governed cross-reference" title="Crosswalk" description="Human-curated crosses, governed: clinical and product-marketing review, an equivalence level a customer may be shown, and frozen published versions that proposals pin. Rep-proposed crosses queue here and never reach a quote until published." />
      <Governance canManage={can(actor, "manage_crosswalk")} canPublish={can(actor, "publish_crosswalk")} canClinical={can(actor, "review_crosswalk_clinical") || (actor?.roles ?? []).includes("ADMIN")} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Crosses" value={total} hint={`${byCompany.length} competitors · ${bySource.length} sheets`} />
        <Stat label="Exact" value={count("Exact Match")} tone="exact" />
        <Stat label="Close" value={count("Close Match")} tone="close" />
        <Stat label="Alternative" value={count("Alternative Match") + count("US Downsell Match")} tone="alt" />
      </div>
      <Card padded={false}>
        <CrossFilters q={q} type={type} company={company} source={source} companies={byCompany.map((c) => ({ name: c.competitorName, count: c._count._all }))} sources={bySource.map((s) => ({ name: s.source, count: s._count._all }))} shown={rows.length} />
        {rows.length === 0 ? <Empty title="No crosses match" /> : (
          <table className="table">
            <thead><tr><th>Our SKU</th><th>Our description</th><th>Match</th><th>Equivalence</th><th>Competitor</th><th>Their code</th><th>Their description</th><th>Notes</th><th>Source</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.isActive ? "" : "bg-panel-2 [&>td]:text-muted"}>
                  <td className="mono font-semibold">{r.ownSku}{r.preferredOwnSku && r.preferredOwnSku !== r.ownSku && <div className="text-[11px] text-accent">prefer {r.preferredOwnSku}</div>}</td>
                  <td className="max-w-[300px] text-ink-2"><div className="line-clamp-2">{r.ownDescription}</div></td>
                  <td><MatchChip type={r.matchType} /></td>
                  <td><Pill value={r.approvalStatus === "APPROVED" ? r.equivalenceLevel : r.approvalStatus}>{r.approvalStatus === "APPROVED" ? r.equivalenceLevel.replace(/_/g, " ").toLowerCase() : r.approvalStatus.toLowerCase()}</Pill></td>
                  <td>{r.competitorName}</td>
                  <td className="mono">{r.competitorCode}</td>
                  <td className="max-w-[300px] text-ink-2"><div className="line-clamp-2">{r.competitorDescription}</div></td>
                  <td className="text-[12px] text-muted max-w-[200px]"><div className="line-clamp-2">{r.additionalProducts ? <span>Needs: <span className="mono">{r.additionalProducts}</span></span> : r.notes}</div>{!r.isActive && <Chip tone="alt">inactive</Chip>}</td>
                  <td className="text-[12px] text-muted">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

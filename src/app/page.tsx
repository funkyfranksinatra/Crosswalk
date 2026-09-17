import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCompany } from "@/lib/settings";
import { llmConfig } from "@/lib/llm/client";
import { PageHeader, Card, Stat, StatusPill, relTime, Empty, Chip } from "@/components/ui";
import { summarizeLines } from "@/lib/requests";

export default async function Overview() {
  const company = await getCompany();
  const [requests, products, priced, binned, crosses, competitors, unresolved] = await Promise.all([
    prisma.request.findMany({ where: { NOT: { reference: { startsWith: "BENCH-" } } }, orderBy: { createdAt: "desc" }, take: 8, include: { lines: { select: { quantity: true, estCompetitorPrice: true, resolutionStatus: true, matchStatus: true, reviewed: true, selectedCandidateId: true, candidates: { where: { isSelected: true }, select: { id: true, matchType: true, unitPrice: true } } } } } }),
    prisma.ownProduct.count({ where: { companyId: company.id, isActive: true } }),
    prisma.ownProduct.count({ where: { companyId: company.id, OR: [{ listPrice: { not: null } }, { prices: { some: {} } }] } }),
    prisma.ownProduct.count({ where: { companyId: company.id, gudidSyncedAt: { not: null }, gudidDi: { not: null } } }),
    prisma.knownCross.count({ where: { isActive: true } }),
    prisma.competitorProduct.count({ where: { resolution: { not: "not-found" } } }),
    prisma.competitorProduct.count({ where: { resolution: "not-found" } }),
  ]);
  const llm = llmConfig();
  const readiness = [
    { label: "Catalog", ok: products > 0, text: `${products} SKUs · ${binned} with GUDID data`, href: "/catalog", action: binned < products ? "Enrich from GUDID" : undefined },
    { label: "Pricing", ok: priced > 0, text: priced ? `${priced} of ${products} SKUs priced` : "No prices loaded — ranking uses attributes only", href: "/catalog", action: "Import pricing" },
    { label: "Model", ok: llm.available, text: llm.available ? `${llm.model} for binning, grading and unresolved codes` : "Heuristic mode. Add OPENAI_API_KEY to .env for model-assisted matching", href: "/settings" },
    { label: "Curated crosses", ok: crosses > 0, text: `${crosses} human-verified cross references loaded`, href: "/crosses" },
  ];

  return (
    <>
      <PageHeader
        eyebrow={company.name}
        title="Competitive cross reference"
        description="Upload what a prospect buys from a competitor. Crosswalk resolves every code against FDA GUDID, bins the attributes, and ranks your best-fit and next-best products with prices ready for a bid."
        actions={<Link href="/requests/new" className="btn-primary">New request</Link>}
      />

      <div className="grid grid-cols-4 gap-3 mb-6">
        <Stat label="Requests" value={await prisma.request.count()} hint="all time" />
        <Stat label="Competitor products resolved" value={competitors} hint={unresolved ? `${unresolved} still unresolved` : "cached across requests"} tone="accent" />
        <Stat label="Our SKUs" value={products} hint={`${priced} priced`} />
        <Stat label="Known crosses" value={crosses} hint="from curated sheets" />
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-4">
        <Card title="Recent requests" padded={false} actions={<Link href="/requests" className="text-[12.5px] text-accent font-medium">All requests →</Link>}>
          {requests.length === 0 ? (
            <Empty title="No requests yet">Start with the sample intake in <span className="kbd">data/reference</span> or upload a rep's spreadsheet.</Empty>
          ) : (
            <table className="table">
              <thead><tr><th>Request</th><th>Account</th><th>Lines</th><th>Matched</th><th>Status</th><th>When</th></tr></thead>
              <tbody>
                {requests.map((r) => {
                  const s = summarizeLines(r.lines);
                  return (
                    <tr key={r.id}>
                      <td><Link href={`/requests/${r.id}`} className="mono font-semibold text-accent">{r.reference}</Link></td>
                      <td><div className="text-ink">{r.accountName ?? "—"}</div><div className="mono text-[11.5px] text-muted">{r.accountNumber}</div></td>
                      <td className="mono">{s.total}</td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <span className="mono">{s.matched}</span>
                          <span className="text-muted text-[12px]">({s.exact}E · {s.close}C · {s.alternative}A)</span>
                        </div>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="text-muted">{relTime(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Readiness" subtitle="What Crosswalk has to work with right now">
          <ul className="space-y-3">
            {readiness.map((r) => (
              <li key={r.label} className="flex items-start gap-3">
                <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${r.ok ? "bg-exact" : "bg-alt"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">{r.label}</span>
                    <Link href={r.href} className="text-[12px] text-accent font-medium">{r.action ?? "Open"} →</Link>
                  </div>
                  <div className="text-[12.5px] text-muted">{r.text}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-5 pt-4 border-t border-line-2">
            <div className="eyebrow mb-2">How a request runs</div>
            <ol className="text-[12.5px] text-ink-2 space-y-1.5">
              <li className="flex gap-2"><Chip tone="accent">1</Chip> Resolve each code in GUDID (openFDA) — variants, list context, model hints</li>
              <li className="flex gap-2"><Chip tone="accent">2</Chip> Bin attributes: type, family, sizes, materials, features</li>
              <li className="flex gap-2"><Chip tone="accent">3</Chip> Retrieve candidates: curated crosses + attribute neighbours</li>
              <li className="flex gap-2"><Chip tone="accent">4</Chip> Rank by fit, price, cost and margin; grade with the model</li>
            </ol>
          </div>
        </Card>
      </div>
    </>
  );
}

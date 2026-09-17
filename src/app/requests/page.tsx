import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Card, StatusPill, relTime, Empty, money } from "@/components/ui";
import { summarizeLines } from "@/lib/requests";
import { getActor, can } from "@/lib/auth";

export default async function RequestsPage() {
  const actor = await getActor();
  if (!can(actor, "run_cross_reference")) return <Empty title="Cross-reference requests need the run_cross_reference permission" />;
  // Only the selected candidate is needed for the summary — not every candidate of every line of every request.
  const requests = await prisma.request.findMany({ where: { NOT: { reference: { startsWith: "BENCH-" } } }, orderBy: { createdAt: "desc" }, take: 200, include: { pricebook: true, lines: { select: { quantity: true, estCompetitorPrice: true, resolutionStatus: true, matchStatus: true, reviewed: true, selectedCandidateId: true, candidates: { where: { isSelected: true }, select: { id: true, matchType: true, unitPrice: true } } } } } });
  return (
    <>
      <PageHeader eyebrow="Requests" title="Cross-reference requests" description="One request per intake spreadsheet. Re-run any time after the catalog, pricing, or model configuration changes." actions={<Link href="/requests/new" className="btn-primary">New request</Link>} />
      <Card padded={false}>
        {requests.length === 0 ? (
          <Empty title="No requests yet" />
        ) : (
          <table className="table">
            <thead><tr><th>Request</th><th>Account</th><th>Pricebook</th><th>Lines</th><th>Resolved</th><th>Matched</th><th>Our value</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {requests.map((r) => {
                const s = summarizeLines(r.lines);
                return (
                  <tr key={r.id}>
                    <td><Link href={`/requests/${r.id}`} className="mono font-semibold text-accent">{r.reference}</Link><div className="text-[11.5px] text-muted truncate max-w-[220px]">{r.sourceFileName}</div></td>
                    <td><div>{r.accountName ?? "—"}</div><div className="mono text-[11.5px] text-muted">{r.accountNumber}</div></td>
                    <td className="text-muted">{r.pricebook?.name ?? "List price"}</td>
                    <td className="mono">{s.total}</td>
                    <td className="mono">{s.resolved}</td>
                    <td className="mono">{s.matched} <span className="text-muted text-[12px]">({s.exact}E · {s.close}C · {s.alternative}A)</span></td>
                    <td className="mono">{money(s.ourExtended, { compact: true })}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="text-muted">{relTime(r.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

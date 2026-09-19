import Link from "next/link";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/auth";
import { PageHeader, Card, Empty, money, relTime } from "@/components/ui";
import { ProposalStatus } from "@/components/commercial";
import { scopeFor, proposalWhere } from "@/lib/auth/scope";

export default async function ProposalsPage() {
  const actor = await getActor();
  if (!actor || !actor.permissions.has("view_pricing")) return <Empty title="Sign in to see proposals">Use the development sign-in in the sidebar.</Empty>;
  const proposals = await prisma.proposal.findMany({ where: proposalWhere(await scopeFor(actor)), orderBy: { createdAt: "desc" }, include: { account: true, _count: { select: { lines: true, approvals: { where: { status: "PENDING" } } } } }, take: 200 });
  return (
    <>
      <PageHeader eyebrow="Proposals" title="Commercial proposals" description="Versioned quotes built from a cross-reference request: waterfall pricing, competitor intelligence, recommendations, approvals and outcomes." />
      <Card padded={false}>
        {proposals.length === 0 ? (
          <Empty title="No proposals yet">Open a completed cross-reference request and choose <b>Create proposal</b>.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Proposal</th><th>Account</th><th>GPO</th><th>Lines</th><th className="text-right">Value</th><th className="text-right">Savings</th><th className="text-right">Margin</th><th>Status</th><th>Valid through</th><th>Updated</th></tr></thead>
            <tbody>
              {proposals.map((p) => {
                const e = p.economicsJson ? JSON.parse(p.economicsJson) : null;
                const showMargin = actor.permissions.has("view_margin");
                return (
                  <tr key={p.id}>
                    <td><Link href={`/proposals/${p.id}`} className="mono font-semibold text-accent">{p.reference}</Link><div className="text-[11.5px] text-muted">v{p.version}</div></td>
                    <td>{p.account.name}<div className="mono text-[11.5px] text-muted">{p.account.accountNumber}</div></td>
                    <td className="text-muted">{p.gpoNameSnapshot ?? "—"}</td>
                    <td className="mono">{p._count.lines}</td>
                    <td className="mono text-right">{money(e?.revenue, { compact: true })}</td>
                    <td className="mono text-right">{money(e?.customerSavings, { compact: true })}</td>
                    <td className="mono text-right">{showMargin && e?.blendedMarginPct != null ? `${(Number(e.blendedMarginPct) * 100).toFixed(1)}%` : "—"}</td>
                    <td><ProposalStatus status={p.status} pending={p._count.approvals} /></td>
                    <td className="text-muted">{p.validThrough ? new Date(p.validThrough).toISOString().slice(0, 10) : "—"}</td>
                    <td className="text-muted">{relTime(p.updatedAt)}</td>
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

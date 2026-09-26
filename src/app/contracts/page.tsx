import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Card, Empty, money } from "@/components/ui";
import { Pill } from "@/components/commercial";
import { renewalPipeline } from "@/lib/compliance";
import { num } from "@/lib/money";
import { ContractTools } from "./tools";
import { getActor, can } from "@/lib/auth";
import { scopeFor, contractWhere } from "@/lib/auth/scope";

export default async function ContractsPage() {
  const actor = await getActor();
  if (!can(actor, "view_pricing")) return <Empty title="Contracts are visible to commercial roles">Your role has no pricing visibility.</Empty>;
  const contracts = await prisma.contract.findMany({ where: contractWhere(await scopeFor(actor!)), orderBy: [{ status: "asc" }, { effectiveTo: "asc" }], include: { account: true, gpo: true, _count: { select: { entries: true, commitments: true, rebates: true, bundles: true } } } });
  const renewals = await renewalPipeline(180);
  // The GPO list feeds the New-contract popover (there is no GPO listing route); only a manage_contracts actor can use it.
  const gpos = can(actor, "manage_contracts") ? await prisma.gpo.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  return (
    <>
      <PageHeader eyebrow="Contracts" title="Contracts & price context" description="List → national → GPO tier → IDN → local account. The waterfall reads these; proposals snapshot the result." actions={<ContractTools gpos={gpos} />} />
      {renewals.length > 0 && (
        <Card title="Renewal pipeline" subtitle="Active contracts expiring within 180 days" className="mb-4" padded={false}>
          <table className="table !text-[12.5px]"><thead><tr><th>Contract</th><th>Counterparty</th><th>Expires</th><th>Days</th><th>Flags</th></tr></thead><tbody>{renewals.map((r) => <tr key={r.id}><td><Link className="mono text-accent" href={`/contracts/${r.id}`}>{r.contractNumber}</Link> <span className="text-muted">{r.name}</span></td><td>{r.account ?? "—"}</td><td className="mono">{r.effectiveTo.slice(0, 10)}</td><td className={`mono ${r.daysLeft < 60 ? "text-none" : "text-alt"}`}>{r.daysLeft}</td><td className="text-muted">{r.flags.join(" · ") || (r.renewal ? `${r.renewal.kind?.toLowerCase()} renewal` : "")}</td></tr>)}</tbody></table>
        </Card>
      )}
      <Card padded={false}>
        {contracts.length === 0 ? <Empty title="No contracts yet" /> : (
          <table className="table"><thead><tr><th>Contract</th><th>Type</th><th>Counterparty</th><th>Status</th><th>Term</th><th className="text-right">Committed</th><th>Entries</th><th>Terms</th></tr></thead>
            <tbody>{contracts.map((c) => <tr key={c.id}><td><Link href={`/contracts/${c.id}`} className="mono font-semibold text-accent">{c.contractNumber}</Link><div className="text-[11.5px] text-muted">{c.name}</div></td><td>{c.type}{c.tier ? <span className="text-muted"> · {c.tier}</span> : null}</td><td>{c.account?.name ?? c.gpo?.name ?? <span className="text-muted">all accounts</span>}</td><td><Pill value={c.status} /></td><td className="mono text-[12px]">{c.effectiveFrom.toISOString().slice(0, 10)} → {c.effectiveTo?.toISOString().slice(0, 10) ?? "open"}</td><td className="mono text-right">{money(num(c.committedValue), { compact: true })}</td><td className="mono">{c._count.entries}</td><td className="text-muted text-[12px]">{[c._count.commitments && `${c._count.commitments} commitment`, c._count.rebates && `${c._count.rebates} rebate`, c._count.bundles && `${c._count.bundles} bundle`].filter(Boolean).join(" · ") || "—"}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </>
  );
}

import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Card, Empty, money } from "@/components/ui";
import { Pill, ProposalStatus } from "@/components/commercial";
import { num } from "@/lib/money";
import { getActor, can } from "@/lib/auth";
import { scopeFor, accountWhere } from "@/lib/auth/scope";

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!can(actor, "view_pricing")) return <Empty title="Accounts are visible to commercial roles">Your role has no pricing visibility.</Empty>;
  const a = await prisma.account.findFirst({ where: { id, ...accountWhere(await scopeFor(actor!)) }, include: { parent: true, children: true, memberships: { include: { gpo: true }, orderBy: { effectiveFrom: "desc" } }, contracts: { orderBy: { effectiveFrom: "desc" } }, opportunities: true, proposals: { orderBy: { createdAt: "desc" } }, requests: { orderBy: { createdAt: "desc" }, take: 10 }, purchases: { orderBy: { invoiceDate: "desc" }, take: 25 }, observations: { orderBy: { observedAt: "desc" }, take: 25, include: { competitor: true } } } });
  if (!a) return <Empty title="Account not found" />;
  const gpoContracts = a.memberships.length ? await prisma.contract.findMany({ where: { type: "GPO", gpoId: { in: a.memberships.map((m) => m.gpoId) } } }) : [];
  return (
    <>
      <PageHeader eyebrow={`Account · ${a.type.replace(/_/g, "-").toLowerCase()}`} title={a.name} description={<span>{a.accountNumber ? <span className="mono">{a.accountNumber} · </span> : null}{a.parent ? <>part of <Link className="text-accent" href={`/accounts/${a.parent.id}`}>{a.parent.name}</Link> · </> : null}{a.region ?? ""}{a.segment ? ` · ${a.segment}` : ""}{a.isStrategic ? " · strategic account" : ""}</span>} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 [&>*]:min-w-0">
        <Card title="GPO membership" subtitle="Effective-dated; changes never rewrite historical quotes">
          {a.memberships.length === 0 ? <div className="text-muted text-[13px]">No GPO affiliation on file.</div> : <table className="table !text-[12.5px]"><thead><tr><th>GPO</th><th>Tier</th><th>From</th><th>To</th><th>Source</th></tr></thead><tbody>{a.memberships.map((m) => <tr key={m.id}><td>{m.gpo.name}</td><td>{m.tier ?? "—"}</td><td className="mono">{m.effectiveFrom.toISOString().slice(0, 10)}</td><td className="mono">{m.effectiveTo ? m.effectiveTo.toISOString().slice(0, 10) : "open"}</td><td className="text-muted">{m.source}{m.verifiedAt ? ` · verified ${m.verifiedAt.toISOString().slice(0, 10)}` : ""}</td></tr>)}</tbody></table>}
        </Card>
        <Card title="Applicable contracts" subtitle="Local agreements plus the GPO contracts this account's memberships unlock">
          <table className="table !text-[12.5px]"><thead><tr><th>Contract</th><th>Type</th><th>Status</th><th>Term</th></tr></thead><tbody>{[...a.contracts, ...gpoContracts].map((c) => <tr key={c.id}><td><Link className="text-accent mono" href={`/contracts/${c.id}`}>{c.contractNumber}</Link><div className="text-muted">{c.name}</div></td><td>{c.type}{c.tier ? ` · ${c.tier}` : ""}</td><td><Pill value={c.status} /></td><td className="mono">{c.effectiveFrom.toISOString().slice(0, 10)} → {c.effectiveTo?.toISOString().slice(0, 10) ?? "open"}</td></tr>)}</tbody></table>
        </Card>
        <Card title="Proposals" padded={false}>
          {a.proposals.length === 0 ? <div className="p-5 text-muted text-[13px]">No proposals. Run a cross-reference request for this account, then create one.</div> : <table className="table !text-[12.5px]"><thead><tr><th>Proposal</th><th>Status</th><th className="text-right">Value</th><th>Created</th></tr></thead><tbody>{a.proposals.map((p) => { const e = p.economicsJson ? JSON.parse(p.economicsJson) : null; return <tr key={p.id}><td><Link className="mono text-accent font-semibold" href={`/proposals/${p.id}`}>{p.reference}</Link></td><td><ProposalStatus status={p.status} /></td><td className="mono text-right">{money(e?.revenue, { compact: true })}</td><td className="text-muted">{p.createdAt.toISOString().slice(0, 10)}</td></tr>; })}</tbody></table>}
        </Card>
        <Card title="Recent purchases" subtitle="ERP feed or import — drives contract compliance" padded={false}>
          {a.purchases.length === 0 ? <div className="p-5 text-muted text-[13px]">No purchase records.</div> : <table className="table !text-[12.5px]"><thead><tr><th>Date</th><th>SKU</th><th className="text-right">Qty</th><th className="text-right">Net price</th><th>Source</th></tr></thead><tbody>{a.purchases.map((r) => <tr key={r.id}><td className="mono">{r.invoiceDate.toISOString().slice(0, 10)}</td><td className="mono">{r.sku}</td><td className="mono text-right">{num(r.quantity)}</td><td className="mono text-right">{money(num(r.netPrice))}</td><td className="text-muted">{r.source}</td></tr>)}</tbody></table>}
        </Card>
        <Card title="Competitor prices observed here" className="lg:col-span-2" padded={false}>
          {a.observations.length === 0 ? <div className="p-5 text-muted text-[13px]">No observations recorded at this account.</div> : <table className="table !text-[12.5px]"><thead><tr><th>Competitor</th><th>Code</th><th className="text-right">Price</th><th>Observed</th><th>Source</th><th>Status</th></tr></thead><tbody>{a.observations.map((o) => <tr key={o.id}><td>{o.competitor.name}</td><td className="mono">{o.competitorSku}</td><td className="mono text-right">{money(num(o.price))}</td><td className="mono">{o.observedAt.toISOString().slice(0, 10)}</td><td className="text-muted">{o.sourceType.replace(/_/g, " ").toLowerCase()}{o.sourceRef ? ` · ${o.sourceRef}` : ""}</td><td><Pill value={o.verificationStatus} /></td></tr>)}</tbody></table>}
        </Card>
      </div>
    </>
  );
}

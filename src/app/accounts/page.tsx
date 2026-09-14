import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Card, Empty } from "@/components/ui";
import { Pill } from "@/components/commercial";

export default async function AccountsPage() {
  const accounts = await prisma.account.findMany({ orderBy: { name: "asc" }, include: { parent: true, memberships: { include: { gpo: true } }, _count: { select: { contracts: true, proposals: true, purchases: true } } } });
  const now = new Date();
  return (
    <>
      <PageHeader eyebrow="Accounts" title="Accounts & GPO membership" description="CRM is the system of record for accounts; the platform keeps what pricing needs — hierarchy, GPO affiliation with effective dates, contracts and proposals. Sync from Settings → Integrations." />
      <Card padded={false}>
        {accounts.length === 0 ? <Empty title="No accounts yet" /> : (
          <table className="table"><thead><tr><th>Account</th><th>Type</th><th>Parent / IDN</th><th>GPO (current)</th><th>Region</th><th>Contracts</th><th>Proposals</th><th>Purchases</th></tr></thead>
            <tbody>{accounts.map((a) => { const m = a.memberships.find((x) => x.effectiveFrom <= now && (!x.effectiveTo || x.effectiveTo > now)); return (
              <tr key={a.id}><td><Link href={`/accounts/${a.id}`} className="font-semibold text-accent">{a.name}</Link><div className="mono text-[11.5px] text-muted">{a.accountNumber ?? ""}{a.isStrategic ? " · strategic" : ""}</div></td><td><Pill value={a.type}>{a.type.replace(/_/g, "-").toLowerCase()}</Pill></td><td className="text-muted">{a.parent?.name ?? "—"}</td><td>{m ? `${m.gpo.name}${m.tier ? ` · ${m.tier}` : ""}` : <span className="text-muted">none</span>}</td><td className="text-muted">{a.region ?? "—"}</td><td className="mono">{a._count.contracts}</td><td className="mono">{a._count.proposals}</td><td className="mono">{a._count.purchases}</td></tr>); })}</tbody>
          </table>
        )}
      </Card>
    </>
  );
}

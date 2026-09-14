"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { Pill } from "@/components/commercial";

type Status = { status: Record<"crm" | "erp" | "gpo", { adapter: string; configured: boolean; note: string }>; recent: { id: string; system: string; direction: string; entityType: string; status: string; error: string | null; at: string }[]; counts: { system: string; status: string; _count: { _all: number } }[] };

export function IntegrationsCard({ canSync }: { canSync: boolean }) {
  const [s, setS] = useState<Status | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await fetch("/api/integrations", { cache: "no-store" }); if (r.ok) setS(await r.json()); }, []);
  useEffect(() => { load(); }, [load]);
  async function sync(system: string) { setMsg(`Syncing ${system}…`); const r = await fetch("/api/integrations/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system }) }); const j = await r.json(); setMsg(r.ok ? `${system.toUpperCase()}: ${JSON.stringify(j)}` : j.error); load(); }
  return (
    <Card title="Integrations" subtitle="CRM owns accounts/opportunities, ERP owns SKUs/costs/purchases, the GPO feed owns memberships. Sync is idempotent (external ids + payload hashes) and logged.">
      {s && (
        <div className="space-y-1.5 text-[12.5px]">
          {(["crm", "erp", "gpo"] as const).map((k) => <div key={k} className="flex items-center gap-2"><span className="w-10 uppercase mono">{k}</span><Pill value={s.status[k].configured ? "ACTIVE" : "DRAFT"}>{s.status[k].configured ? "configured" : "dev adapter"}</Pill><span className="text-muted flex-1 truncate">{s.status[k].note}</span>{canSync && <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => sync(k)}>Sync now</button>}</div>)}
          {msg && <div className="text-accent-ink mono text-[11.5px] break-all">{msg}</div>}
          <div className="text-[11.5px] text-muted pt-1">Last sync events: {s.recent.slice(0, 5).map((r) => `${r.system} ${r.direction} ${r.entityType} ${r.status}`).join(" · ") || "none"}. Credentials needed for the real adapters are listed in <Link className="text-accent" href="/docs/INTEGRATIONS.md">docs/INTEGRATIONS.md</Link>.</div>
        </div>
      )}
      <div className="mt-3 flex gap-2 text-[12.5px]"><Link className="text-accent" href="/settings/pricing">Pricing policies →</Link><Link className="text-accent" href="/crosses">Crosswalk governance →</Link></div>
    </Card>
  );
}

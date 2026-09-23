"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { Pill } from "@/components/commercial";

type SystemStatus = { adapter: string; configured: boolean; implemented: boolean; note: string; api: { name: string; env: { name: string; set: boolean }[]; implemented: boolean }; feed: { files: { name: string; present: boolean }[] } };
type Status = { status: Record<"crm" | "erp" | "gpo", SystemStatus> & { feedDir: string | null; tier2?: { key: string; label: string; provider: string | null; enabled: boolean; status: string }[] }; recent: { id: string; system: string; direction: string; entityType: string; status: string; error: string | null; at: string }[]; counts: { system: string; status: string; _count: { _all: number } }[] };
type Report = { system: string; entityType: string; created: number; updated: number; skipped: number; failed: number; errors: string[] };

const LABEL: Record<"crm" | "erp" | "gpo", string> = { crm: "CRM — accounts, parents, opportunities, GPO affiliation", erp: "ERP — SKU master, list prices, standard cost by plant/region, purchases", gpo: "GPO — membership roster with tier and effective dates" };

function summarize(system: string, j: unknown): string {
  const reps = (Array.isArray(j) ? j : [j]) as Report[];
  if (!reps[0] || typeof reps[0] !== "object" || !("entityType" in reps[0])) return `${system.toUpperCase()}: ${JSON.stringify(j)}`;
  return reps.map((r) => `${r.entityType}: ${r.created} new · ${r.updated} updated · ${r.skipped} unchanged${r.failed ? ` · ${r.failed} failed — ${r.errors.map((e) => e.split("\n")[0]).join("; ")}` : ""}`).join("  |  ");
}

export function IntegrationsCard({ canSync }: { canSync: boolean }) {
  const [s, setS] = useState<Status | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<"crm" | "erp" | "gpo" | null>(null);
  const load = useCallback(async () => { const r = await fetch("/api/integrations", { cache: "no-store" }); if (r.ok) setS(await r.json()); }, []);
  useEffect(() => { load(); }, [load]);
  async function sync(system: string) {
    setMsg(`Syncing ${system}…`);
    const r = await fetch("/api/integrations/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system }) });
    const j = await r.json();
    setMsg(r.ok ? summarize(system, j) : j.error);
    load();
  }
  return (
    <Card title="Integrations" subtitle="CRM owns accounts/opportunities, ERP owns SKUs/costs/purchases, the GPO feed owns memberships. Sync is idempotent (external ids + payload hashes) and logged." actions={<Link className="btn-primary" href="/settings/integrations">Configure integrations →</Link>}>
      {s?.status.tier2?.some((t) => t.enabled) && <div className="mb-2 text-[12px] text-muted">Configured: {s.status.tier2.filter((t) => t.enabled).map((t) => `${t.label} (${t.provider}, ${t.status.toLowerCase()})`).join(" · ")}</div>}
      {s && (
        <div className="space-y-1.5 text-[12.5px]">
          {(["crm", "erp", "gpo"] as const).map((k) => {
            const st = s.status[k];
            const tone = st.configured && st.implemented ? "ACTIVE" : st.configured ? "AT_RISK" : "DRAFT";
            const label = st.configured && st.implemented ? st.adapter === "file" ? "file feed" : "connected" : st.configured ? "not implemented" : "dev adapter";
            return (
              <div key={k}>
                <div className="flex items-center gap-2">
                  <span className="w-10 uppercase mono">{k}</span>
                  <Pill value={tone}>{label}</Pill>
                  <span className="text-muted flex-1 truncate">{st.note}</span>
                  <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => setOpen(open === k ? null : k)}>{open === k ? "Hide" : "How to connect"}</button>
                  {canSync && <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => sync(k)}>Sync now</button>}
                </div>
                {open === k && (
                  <div className="ml-12 mt-1.5 mb-2 rounded-md bg-panel-2 px-3 py-2.5 text-[12px] space-y-2">
                    <div className="text-ink-2">{LABEL[k]}</div>
                    <div>
                      <div className="font-medium">Route 1 — file feed <span className="text-muted font-normal">(works today)</span></div>
                      <div className="text-muted">Set <span className="mono">INTEGRATION_FEED_DIR</span> in <span className="mono">.env</span> to a folder your {k === "gpo" ? "GPO portal export" : k.toUpperCase() + " export"} lands in (network share, SFTP drop, synced OneDrive), restart, then <b>Sync now</b>. {s.status.feedDir ? <>Currently <span className="mono">{s.status.feedDir}</span>.</> : "Not set."}</div>
                      <ul className="mt-1 space-y-0.5">
                        {st.feed.files.map((f) => <li key={f.name} className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${f.present ? "bg-exact" : "bg-faint"}`} /><span className="mono">{f.name}</span><span className="text-muted">{f.present ? "found" : "not found"}</span></li>)}
                      </ul>
                      <div className="text-muted mt-1">Column headers are listed in <span className="mono">src/lib/integrations/file.ts</span> and docs/INTEGRATIONS.md; extra columns are ignored. {k === "crm" && "Approved quotes are written to outbound/quotes/ in the same folder."}</div>
                    </div>
                    <div>
                      <div className="font-medium">Route 2 — {st.api.name} API <span className="text-muted font-normal">({st.api.implemented ? "implemented" : k === "gpo" ? "no standard API — GPOs supply rosters as files" : "adapter skeleton: needs the credentials below and an implementation against the vendor API"})</span></div>
                      {st.api.env.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {st.api.env.map((e) => <li key={e.name} className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${e.set ? "bg-exact" : "bg-faint"}`} /><span className="mono">{e.name}</span><span className="text-muted">{e.set ? "set" : "missing"}</span></li>)}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {msg && <div className="text-accent-ink text-[11.5px] break-words">{msg}</div>}
          <div className="text-[11.5px] text-muted pt-1">Last sync events: {s.recent.slice(0, 5).map((r) => `${r.system} ${r.direction} ${r.entityType} ${r.status}`).join(" · ") || "none"}. Credentials needed for the real adapters are listed in <Link className="text-accent" href="/docs/INTEGRATIONS.md">docs/INTEGRATIONS.md</Link>.</div>
        </div>
      )}
      <div className="mt-3 flex gap-2 text-[12.5px]"><Link className="text-accent" href="/settings/pricing">Pricing policies →</Link><Link className="text-accent" href="/crosses">Crosswalk governance →</Link></div>
    </Card>
  );
}

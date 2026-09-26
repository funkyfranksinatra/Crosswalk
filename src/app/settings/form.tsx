"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import type { Weights } from "@/lib/match/score";
import type { ScopeUnassignedParent } from "@/lib/settings";

const LABELS: Record<keyof Weights, [string, string]> = {
  bin: ["Attribute fit", "How closely the product's type, sizes, materials and features match the competitor's."],
  price: ["Competitive price", "Our unit price versus the estimated competitor price on the line (needs a competitor price)."],
  cogs: ["Cost to manufacture", "Lower COGS ranks higher among the candidates for a line (needs COGS on the SKU)."],
  margin: ["Margin", "(price − COGS) / price, saturating at 60% (needs both)."],
};

export function SettingsForm({ weights, maxCandidates, companyName, scopeUnassignedParent = "inherit", canEdit = true }: { weights: Weights; maxCandidates: number; companyName: string; scopeUnassignedParent?: ScopeUnassignedParent; canEdit?: boolean }) {
  const [w, setW] = useState<Weights>(weights);
  const [max, setMax] = useState(maxCandidates);
  const [name, setName] = useState(companyName);
  const [scope, setScope] = useState<ScopeUnassignedParent>(scopeUnassignedParent);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sum = w.bin + w.price + w.cogs + w.margin;
  async function save() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weights: w, maxCandidates: max, companyName: name, scopeUnassignedParent: scope }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error ?? `Could not save (${r.status})`); return; }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  return (
    <Card title="Ranking" subtitle="Weights renormalise automatically when a factor is unavailable for a SKU, so unpriced products are never punished for missing data." actions={<button type="button" className="btn-primary" disabled={!canEdit || busy} title={canEdit ? undefined : "Needs the configure settings permission"} onClick={save}>{saved ? "Saved" : busy ? "Saving…" : "Save"}</button>}>
      {err && <div role="alert" className="mb-3 rounded-lg bg-none-soft text-none px-3 py-2 text-[12.5px]">{err}</div>}
      {!canEdit && <div className="mb-3 text-[12px] text-muted">Read-only: changing weights needs the configure settings permission.</div>}
      <div className="space-y-4">
        {(Object.keys(LABELS) as (keyof Weights)[]).map((k) => (
          <div key={k}>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={`weight-${k}`} className="font-medium text-[13px]">{LABELS[k][0]}</label>
              <span className="mono text-[12.5px] text-muted">{Math.round((w[k] / sum) * 100)}%</span>
            </div>
            <input id={`weight-${k}`} type="range" min={0} max={100} disabled={!canEdit} value={Math.round(w[k] * 100)} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent)]" />
            <div className="text-[12px] text-muted">{LABELS[k][1]}</div>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-line-2">
          <div>
            <label className="label" htmlFor="max-candidates">Candidates per line</label>
            <input id="max-candidates" type="number" min={1} max={12} disabled={!canEdit} className="input mono" value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="company-name">Company name</label>
            <input id="company-name" className="input" disabled={!canEdit} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="pt-2 border-t border-line-2">
          <label className="label" htmlFor="scope-unassigned-parent">Account visibility: hospitals under an IDN nobody owns yet</label>
          <select id="scope-unassigned-parent" className="input" disabled={!canEdit} value={scope} onChange={(e) => setScope(e.target.value as ScopeUnassignedParent)}>
            <option value="inherit">Visible to every rep and manager, like the unassigned IDN (default)</option>
            <option value="own">Follow their own owner and territory — give managers territories first</option>
          </select>
          <div className="text-[12px] text-muted mt-1">Reps and managers always see the accounts they own, their territory, unassigned accounts and the members of an IDN they own or cover. This decides only what happens while the IDN itself is unassigned.</div>
        </div>
      </div>
    </Card>
  );
}

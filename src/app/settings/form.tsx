"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import type { Weights } from "@/lib/match/score";

const LABELS: Record<keyof Weights, [string, string]> = {
  bin: ["Attribute fit", "How closely the product's type, sizes, materials and features match the competitor's."],
  price: ["Competitive price", "Our unit price versus the estimated competitor price on the line (needs a competitor price)."],
  cogs: ["Cost to manufacture", "Lower COGS ranks higher among the candidates for a line (needs COGS on the SKU)."],
  margin: ["Margin", "(price − COGS) / price, saturating at 60% (needs both)."],
};

export function SettingsForm({ weights, maxCandidates, companyName }: { weights: Weights; maxCandidates: number; companyName: string }) {
  const [w, setW] = useState<Weights>(weights);
  const [max, setMax] = useState(maxCandidates);
  const [name, setName] = useState(companyName);
  const [saved, setSaved] = useState(false);
  const sum = w.bin + w.price + w.cogs + w.margin;
  async function save() {
    await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weights: w, maxCandidates: max, companyName: name }) });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }
  return (
    <Card title="Ranking" subtitle="Weights renormalise automatically when a factor is unavailable for a SKU, so unpriced products are never punished for missing data." actions={<button className="btn-primary" onClick={save}>{saved ? "Saved" : "Save"}</button>}>
      <div className="space-y-4">
        {(Object.keys(LABELS) as (keyof Weights)[]).map((k) => (
          <div key={k}>
            <div className="flex items-center justify-between mb-1">
              <label className="font-medium text-[13px]">{LABELS[k][0]}</label>
              <span className="mono text-[12.5px] text-muted">{Math.round((w[k] / sum) * 100)}%</span>
            </div>
            <input type="range" min={0} max={100} value={Math.round(w[k] * 100)} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent)]" />
            <div className="text-[12px] text-muted">{LABELS[k][1]}</div>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-line-2">
          <div>
            <label className="label">Candidates per line</label>
            <input type="number" min={1} max={12} className="input mono" value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </div>
          <div>
            <label className="label">Company name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
      </div>
    </Card>
  );
}

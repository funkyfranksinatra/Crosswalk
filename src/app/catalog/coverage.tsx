"use client";
import { useEffect, useState } from "react";

type Row = { code: string; manufacturer: string | null; description: string | null; family: string | null; lines: number; accounts: number; units: number; spend: number; sized: string | null; dims: string | null; priority: number };
type Data = { rows: Row[]; totals: { codes: number; sized: number; unsized: number; unsizedSpend: number; coveredSpendPct: number } };

/** The size worklist: which unsized competitor codes are worth sizing first, by spend seen across account lists. */
export function SizeCoverage() {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => { fetch("/api/competitor-sizes/coverage?limit=15", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => undefined); }, []);
  if (!d) return null;
  const top = d.rows.filter((r) => !r.sized);
  return (
    <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3 text-[12.5px]">
      <div className="flex items-center justify-between mb-2">
        <div><b>Worklist</b> — {d.totals.unsized} of {d.totals.codes} competitor codes seen are unsized; sized codes cover {d.totals.coveredSpendPct}% of the competitor spend Crosswalk has seen{d.totals.unsizedSpend ? ` (≈ $${d.totals.unsizedSpend.toLocaleString()} unsized)` : ""}.</div>
      </div>
      {top.length === 0 ? <div className="text-muted">Every competitor code seen has a size.</div> : (
        <table className="table text-[12px]">
          <thead><tr><th>#</th><th>Code</th><th>Manufacturer</th><th>Description</th><th className="text-right">Lists</th><th className="text-right">Units</th><th className="text-right">Est. spend</th></tr></thead>
          <tbody>{top.map((r) => <tr key={r.code}><td className="mono">{r.priority}</td><td className="mono">{r.code}</td><td>{r.manufacturer ?? ""}</td><td className="truncate max-w-[360px]" title={r.description ?? ""}>{r.description ?? ""}</td><td className="mono text-right">{r.lines}</td><td className="mono text-right">{r.units.toLocaleString()}</td><td className="mono text-right">{r.spend ? `$${r.spend.toLocaleString()}` : "—"}</td></tr>)}</tbody>
        </table>
      )}
      <div className="text-muted mt-2">The template is in this order — the top rows are where the money is.</div>
    </div>
  );
}

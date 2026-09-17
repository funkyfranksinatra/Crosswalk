"use client";
import { useCallback, useEffect, useState } from "react";

type Change = { field: string; from: string | null; to: string | null; note?: string };
type Drift = { editable: boolean; checkedAt: string; proposal: Change[]; lines: { lineId: string; lineNo: number; sku: string | null; competitorCode: string; changes: Change[] }[]; summary: { lines: number; drifted: number; byField: Record<string, number>; belowNewFloor: number } };

const FIELD: Record<string, string> = { listPrice: "list price", contractPrice: "contract price", contractPriceSource: "contract source", cost: "cost", floorPrice: "floor", policy: "pricing policy", equivalence: "published cross", product: "product status" };

/**
 * "The world moved since this draft was built." Shown on every proposal that has drifted;
 * only an unlocked draft offers the refresh (submitted proposals keep the numbers the
 * approver saw — reopen first).
 */
export function DriftBanner({ proposalId, canEdit, onRefreshed }: { proposalId: string; canEdit: boolean; onRefreshed: () => void }) {
  const [d, setD] = useState<Drift | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { try { const r = await fetch(`/api/proposals/${proposalId}/drift`, { cache: "no-store" }); if (r.ok) setD(await r.json()); } catch { /* the banner is advisory */ } }, [proposalId]);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.lines.length && !d.proposal.length)) return null;
  async function refresh() {
    setBusy(true); setMsg(null);
    const r = await fetch(`/api/proposals/${proposalId}/refresh-context`, { method: "POST" });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setMsg(j.error); return; }
    setMsg(`Refreshed ${j.refreshed} line${j.refreshed === 1 ? "" : "s"} to today's context.`);
    setD(null);
    onRefreshed();
  }
  const parts = Object.entries(d.summary.byField).map(([f, n]) => `${n} ${FIELD[f] ?? f} change${n === 1 ? "" : "s"}`);
  return (
    <div className="mb-4 rounded-lg bg-alt-soft text-alt px-4 py-3 text-[13px]">
      <div className="flex items-center gap-3 flex-wrap">
        <b>Context moved since this draft was built.</b>
        <span>{[...d.proposal.map((c) => c.note ?? FIELD[c.field] ?? c.field), ...parts].join(" · ")}{d.summary.belowNewFloor ? ` · ${d.summary.belowNewFloor} proposed price${d.summary.belowNewFloor === 1 ? " is" : "s are"} now below the new floor` : ""}.</span>
        <button className="underline" onClick={() => setOpen(!open)}>{open ? "Hide details" : "Details"}</button>
        {canEdit && d.editable && <button className="btn-secondary !py-1 !text-[12px] ml-auto" disabled={busy} onClick={refresh} title="Re-snapshot contracts, costs, policies and the crosswalk version; proposed prices are kept and audited">{busy ? "Refreshing…" : "Refresh to today's context"}</button>}
        {canEdit && !d.editable && <span className="ml-auto text-[12px]">Reopen the proposal to refresh it.</span>}
      </div>
      {msg && <div className="mt-1 text-[12px]">{msg}</div>}
      {open && (
        <ul className="mt-2 space-y-1 text-[12px]">
          {d.proposal.map((c, i) => <li key={`p${i}`}>Proposal: {c.note ?? FIELD[c.field] ?? c.field} — {c.from ?? "—"} → {c.to ?? "—"}</li>)}
          {d.lines.map((l) => <li key={l.lineId}><span className="mono">#{l.lineNo} {l.sku ?? l.competitorCode}</span>: {l.changes.map((c) => `${FIELD[c.field] ?? c.field} ${c.from ?? "—"} → ${c.to ?? "—"}${c.note ? ` (${c.note})` : ""}`).join("; ")}</li>)}
        </ul>
      )}
    </div>
  );
}

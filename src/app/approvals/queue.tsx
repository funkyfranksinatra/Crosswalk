"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, Empty } from "@/components/ui";
import { Pill, fmtMoney, fmtPct, label } from "@/components/commercial";

type Item = { id: string; requiredRole: string; reason: string; notes: string | null; requestedAt: string; snapshotJson: string | null; proposal: { id: string; reference: string; currency: string; account: { name: string } }; proposalLine: { competitorCode: string; sku: string | null; description: string | null; quantity: number; proposedPrice: number | null; recommendedPrice: number | null; floorPrice: number | null; marginPct: number | null; discountFromListPct: number | null; discountFromContractPct: number | null } | null };

export function ApprovalQueue() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const load = useCallback(async () => { const r = await fetch("/api/approvals", { cache: "no-store" }); const j = await r.json(); if (!r.ok) { setErr(j.error); setItems([]); return; } setItems(j); }, []);
  useEffect(() => { load(); }, [load]);
  async function decide(id: string, decision: string) {
    const r = await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, comments: comments[id] ?? "" }) });
    const j = await r.json(); if (!r.ok) setErr(j.error); else { setErr(null); load(); }
  }
  return (
    <>
      <PageHeader eyebrow="Deal desk" title="Pricing approvals" description="Lines routed to your authority. Each request carries the price, recommendation, floor and margin at the moment it was submitted." />
      {err && <div className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {items === null ? <div className="shimmer h-32 rounded-xl" /> : items.length === 0 ? <Card><Empty title="Nothing waiting on you">Requests appear here when a submitted line needs your authority.</Empty></Card> : (
        <div className="space-y-3">
          {items.map((it) => {
            const l = it.proposalLine; const snap = it.snapshotJson ? JSON.parse(it.snapshotJson) : {};
            const belowFloor = l && l.floorPrice != null && l.proposedPrice != null && Number(l.proposedPrice) < Number(l.floorPrice);
            return (
              <Card key={it.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap"><Link href={`/proposals/${it.proposal.id}`} className="mono font-semibold text-accent">{it.proposal.reference}</Link><span className="text-muted">{it.proposal.account.name}</span><Pill value="PENDING">needs {label(it.requiredRole)}</Pill>{belowFloor && <Pill value="REJECTED">below floor</Pill>}</div>
                    {l && <div className="mt-1 text-[13px]"><span className="mono">{l.competitorCode}</span> → <span className="mono font-medium">{l.sku}</span> <span className="text-muted">{l.description}</span> · qty {Number(l.quantity).toLocaleString()}</div>}
                    <div className="mt-1 text-[12.5px] text-muted">{it.reason}{it.notes ? ` · "${it.notes}"` : ""} · requested {it.requestedAt.slice(0, 16).replace("T", " ")}</div>
                    {l && <div className="mt-2 grid grid-cols-5 gap-3 text-[12px]">
                      <div><div className="eyebrow">Proposed</div><div className={`mono ${belowFloor ? "text-none font-semibold" : ""}`}>{fmtMoney(l.proposedPrice, it.proposal.currency)}</div></div>
                      <div><div className="eyebrow">Recommended</div><div className="mono">{fmtMoney(l.recommendedPrice, it.proposal.currency)}</div></div>
                      <div><div className="eyebrow">Floor</div><div className="mono">{fmtMoney(l.floorPrice, it.proposal.currency)}</div></div>
                      <div><div className="eyebrow">Margin</div><div className="mono">{fmtPct(l.marginPct)}</div></div>
                      <div><div className="eyebrow">Discount</div><div className="mono">{fmtPct(l.discountFromListPct)} list{l.discountFromContractPct != null ? ` · ${fmtPct(l.discountFromContractPct)} contract` : ""}</div></div>
                    </div>}
                    {snap.dealRevenue && <div className="mt-1 text-[11.5px] text-muted">Deal revenue at submission {fmtMoney(snap.dealRevenue, it.proposal.currency, { compact: true })}</div>}
                  </div>
                  <div className="w-[260px] shrink-0">
                    <textarea className="input h-16" placeholder="Decision comments" value={comments[it.id] ?? ""} onChange={(e) => setComments({ ...comments, [it.id]: e.target.value })} />
                    <div className="flex gap-2 mt-2"><button className="btn-primary flex-1 justify-center" onClick={() => decide(it.id, "APPROVED")}>Approve</button><button className="btn-secondary" onClick={() => decide(it.id, "CHANGES_REQUESTED")}>Changes</button><button className="btn-danger" onClick={() => decide(it.id, "REJECTED")}>Reject</button></div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

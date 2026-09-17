"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { Pill, label } from "@/components/commercial";

type Version = { id: string; number: number; status: string; publishedAt: string | null; notes: string | null; _count: { entries: number; proposals: number } };
type Cross = { id: string; ownSku: string; competitorName: string; competitorCode: string; matchType: string; approvalStatus: string; clinicalReviewStatus: string; marketingReviewStatus: string; equivalenceLevel: string; justification: string | null; source: string; updatedAt: string; evidenceJson?: string | null };

/** "chosen by 3 reps at 2 accounts" — the learning loop's evidence for a rep-proposed cross. */
function evidence(c: Cross): string | null {
  if (c.source !== "rep" || !c.evidenceJson) return null;
  try { const e = JSON.parse(c.evidenceJson) as { endorsements?: number; accounts?: string[]; users?: string[] }; const n = e.endorsements ?? 0; if (!n) return null; return `chosen by ${e.users?.length ?? n} rep${(e.users?.length ?? n) === 1 ? "" : "s"} at ${e.accounts?.length ?? 1} account${(e.accounts?.length ?? 1) === 1 ? "" : "s"} (${n} time${n === 1 ? "" : "s"})`; } catch { return null; }
}
const EQ = ["EXACT", "FUNCTIONAL", "CLOSEST_ALTERNATIVE", "PREMIUM_ALTERNATIVE", "PARTIAL_SUBSTITUTE", "NONE"];

/** Governance panel: versions + the review queue (rep-proposed and unapproved crosses). */
export function Governance({ canManage, canPublish, canClinical }: { canManage: boolean; canPublish: boolean; canClinical: boolean }) {
  const router = useRouter();
  const [versions, setVersions] = useState<Version[]>([]);
  const [byStatus, setByStatus] = useState<{ approvalStatus: string; _count: { _all: number } }[]>([]);
  const [queue, setQueue] = useState<Cross[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const v = await fetch("/api/crosswalk/versions", { cache: "no-store" }).then((r) => r.json());
    if (v.versions) { setVersions(v.versions); setByStatus(v.byStatus); }
    const q = await fetch("/api/crosses?status=DRAFT", { cache: "no-store" }).then((r) => r.json());
    const q2 = await fetch("/api/crosses?status=IN_REVIEW", { cache: "no-store" }).then((r) => r.json());
    setQueue([...(Array.isArray(q) ? q : []), ...(Array.isArray(q2) ? q2 : [])]);
  }, []);
  useEffect(() => { load(); }, [load]);
  async function patch(id: string, body: Record<string, unknown>) { const r = await fetch(`/api/crosses/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) setMsg(j.error); else { setMsg(null); load(); router.refresh(); } }
  async function publish() { const r = await fetch("/api/crosswalk/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: "Published from the Crosswalk page" }) }); const j = await r.json(); setMsg(r.ok ? `Published v${j.version.number} with ${j.entries} entries.` : j.error); load(); router.refresh(); }
  const published = versions.find((v) => v.status === "PUBLISHED");
  const approvedUnpublished = byStatus.find((b) => b.approvalStatus === "APPROVED")?._count._all ?? 0;
  return (
    <div className="grid grid-cols-[320px_1fr] gap-4 mb-5">
      <Card title="Published crosswalk" subtitle="Reps and proposals only ever see the published version">
        {msg && <div className="mb-2 text-[12px] text-accent-ink">{msg}</div>}
        <div className="text-[13px]">{published ? <><span className="mono font-semibold">v{published.number}</span> · {published._count.entries.toLocaleString()} entries · {published._count.proposals} proposal(s) pinned · published {published.publishedAt?.slice(0, 10)}</> : <span className="text-muted">Nothing published yet.</span>}</div>
        <div className="text-[12px] text-muted mt-1">{byStatus.map((b) => `${b._count._all} ${b.approvalStatus.toLowerCase()}`).join(" · ")}</div>
        {canPublish && <button className="btn-primary mt-3 w-full justify-center" onClick={publish} title={`Freezes ${approvedUnpublished} approved crosses into a new version`}>Publish new version</button>}
        {versions.length > 1 && <div className="mt-3 text-[12px] space-y-0.5">{versions.slice(0, 6).map((v) => <div key={v.id} className="flex justify-between"><span className="mono">v{v.number}</span><Pill value={v.status} /><span className="text-muted">{v._count.entries}</span></div>)}</div>}
      </Card>
      <Card title="Review queue" subtitle="Rep-proposed and draft crosses. Clinical + product marketing review, then approve; publishing makes them visible to reps." padded={false}>
        {queue.length === 0 ? <div className="p-5 text-[13px] text-muted">Nothing awaiting review.</div> : (
          <table className="table !text-[12.5px]"><thead><tr><th>Our SKU</th><th>Competitor</th><th>Engine verdict</th><th>Equivalence</th><th>Clinical</th><th>Marketing</th><th>Status</th><th></th></tr></thead>
            <tbody>{queue.map((c) => <tr key={c.id}><td className="mono font-semibold">{c.ownSku}</td><td>{c.competitorName} <span className="mono">{c.competitorCode}</span><div className="text-muted">{c.source}{evidence(c) ? ` · ${evidence(c)}` : ""}{c.justification ? ` · ${c.justification}` : ""}</div></td><td>{c.matchType}</td>
              <td>{canManage ? <select className="input !py-0.5 !text-[12px]" value={c.equivalenceLevel} onChange={(e) => patch(c.id, { equivalenceLevel: e.target.value })}>{EQ.map((e) => <option key={e} value={e}>{label(e)}</option>)}</select> : label(c.equivalenceLevel)}</td>
              <td>{canClinical && c.clinicalReviewStatus !== "APPROVED" ? <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => patch(c.id, { clinicalReviewStatus: "APPROVED" })}>Approve clinically</button> : <Pill value={c.clinicalReviewStatus} />}</td>
              <td>{canManage && c.marketingReviewStatus !== "APPROVED" ? <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => patch(c.id, { marketingReviewStatus: "APPROVED" })}>Approve marketing</button> : <Pill value={c.marketingReviewStatus} />}</td>
              <td><Pill value={c.approvalStatus} /></td>
              <td className="whitespace-nowrap">{canManage && <><button className="btn-secondary !py-0.5 !text-[11px]" disabled={c.clinicalReviewStatus !== "APPROVED" || c.marketingReviewStatus !== "APPROVED"} title="Both reviews must be approved first" onClick={() => patch(c.id, { approvalStatus: "APPROVED" })}>Approve</button> <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => patch(c.id, { approvalStatus: "REJECTED" })}>Reject</button></>}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

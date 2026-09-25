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

type Conflict = Cross & { competitorDescription: string | null; conflictCount: number; conflictSeenAt: string | null; conflict: { findings: string[]; suggestedSku: string | null; suggestedGrade: string | null; effective: string; sheetGrade: string; requestReference: string; lineCode: string } | null };

/**
 * Evidence conflicts: curated rows whose sheet grade the product attributes contradicted in a run.
 * The run already ranked the row at the evidence's grade; this is where the disagreement is settled
 * for good — in Crosswalk, not in a spreadsheet — with one of three decisions.
 */
function Conflicts({ rows, canManage, busy, onDecide }: { rows: Conflict[]; canManage: boolean; busy: string | null; onDecide: (id: string, decision: "RETIRE" | "REPLACE" | "KEEP", note: string) => void }) {
  const [note, setNote] = useState<Record<string, string>>({});
  return (
    <table className="table !text-[12.5px]"><thead><tr><th>Competitor code</th><th>Sheet says</th><th>Evidence found</th><th>Ranked at</th><th>Evidence suggests</th><th>Seen</th><th><span className="sr-only">Decision</span></th></tr></thead>
      <tbody>{rows.map((c) => {
        const k = c.conflict; const hard = (k?.findings ?? []).some((f) => /^(component|diameter)\b/i.test(f));
        return <tr key={c.id}>
          <td><span className="mono font-semibold">{c.competitorCode}</span><div className="text-muted">{c.competitorName}{c.competitorDescription ? ` · ${c.competitorDescription}` : ""}</div></td>
          <td><span className="mono font-semibold">{c.ownSku}</span><div className="text-muted">{c.matchType} · {c.source}</div></td>
          <td className="max-w-[320px]">{(k?.findings ?? []).length ? <ul className="list-none m-0 p-0 space-y-0.5">{k!.findings.map((f, i) => <li key={i}><span className="text-none">✗</span> {f}</li>)}</ul> : <span className="text-muted">contradicted by the product attributes</span>}</td>
          <td>{k?.effective ?? "—"}</td>
          <td>{k?.suggestedSku ? <><span className="mono font-semibold">{k.suggestedSku}</span><div className="text-muted">{k.suggestedGrade}</div></> : <span className="text-muted">no other product ranked</span>}</td>
          <td className="whitespace-nowrap text-muted">{c.conflictCount} run{c.conflictCount === 1 ? "" : "s"}{k?.requestReference ? <div className="mono">{k.requestReference} · {k.lineCode}</div> : null}</td>
          <td className="whitespace-nowrap">{canManage && <div className="flex flex-col gap-1 items-stretch">
            <input className="input !py-0.5 !text-[11px]" aria-label={`Decision note for ${c.competitorCode} → ${c.ownSku}`} placeholder="Note (optional)" value={note[c.id] ?? ""} disabled={busy !== null} onChange={(e) => setNote((n) => ({ ...n, [c.id]: e.target.value }))} />
            <div className="flex gap-1">
              <button type="button" className="btn-secondary !py-0.5 !text-[11px]" disabled={busy !== null} title="The sheet row is wrong: retire it. The matcher and the published crosswalk drop it." onClick={() => onDecide(c.id, "RETIRE", note[c.id] ?? "")}>Retire</button>
              <button type="button" className="btn-primary !py-0.5 !text-[11px]" disabled={busy !== null || !k?.suggestedSku} title={k?.suggestedSku ? `Retire the row and record ${k.suggestedSku} as the approved cross (source: evidence)` : "No evidence-based SKU was ranked for this line"} onClick={() => onDecide(c.id, "REPLACE", note[c.id] ?? "")}>Replace{k?.suggestedSku ? ` with ${k.suggestedSku}` : ""}</button>
              <button type="button" className="btn-ghost !py-0.5 !text-[11px]" disabled={busy !== null} title={hard ? "The row keeps its grade against the soft findings; a component or diameter finding still caps it" : "The sheet is right: the row keeps its grade in future runs"} onClick={() => onDecide(c.id, "KEEP", note[c.id] ?? "")}>Keep</button>
            </div>
          </div>}</td>
        </tr>;
      })}</tbody>
    </table>
  );
}

/** Governance panel: versions + the review queue (rep-proposed and unapproved crosses). */
export function Governance({ canManage, canPublish, canClinical }: { canManage: boolean; canPublish: boolean; canClinical: boolean }) {
  const router = useRouter();
  const [versions, setVersions] = useState<Version[]>([]);
  const [byStatus, setByStatus] = useState<{ approvalStatus: string; _count: { _all: number } }[]>([]);
  const [queue, setQueue] = useState<Cross[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // Each fetch reports its own failure. The queue only claims "nothing awaiting review" when
  // both queue requests actually succeeded; a 403 (a role without the API's permission) or a
  // network error is shown as such instead of an empty, reassuring queue (KN-02).
  const [errors, setErrors] = useState<{ versions: string | null; queue: string | null; conflicts: string | null }>({ versions: null, queue: null, conflicts: null });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const get = async (url: string) => {
      try { const r = await fetch(url, { cache: "no-store" }); const j = await r.json().catch(() => null); return r.ok ? { ok: true as const, data: j } : { ok: false as const, error: (j && j.error) || `HTTP ${r.status}` }; }
      catch { return { ok: false as const, error: "Could not reach the server" }; }
    };
    const [v, q, q2, k] = await Promise.all([get("/api/crosswalk/versions"), get("/api/crosses?status=DRAFT"), get("/api/crosses?status=IN_REVIEW"), get("/api/crosses?conflicts=open")]);
    if (v.ok && v.data?.versions) { setVersions(v.data.versions); setByStatus(v.data.byStatus ?? []); }
    const queueError = !q.ok ? q.error : !q2.ok ? q2.error : null;
    setErrors({ versions: v.ok ? null : v.error, queue: queueError, conflicts: k.ok ? null : k.error });
    setQueue(queueError ? [] : [...(Array.isArray(q.data) ? q.data : []), ...(Array.isArray(q2.data) ? q2.data : [])]);
    setConflicts(k.ok && Array.isArray(k.data) ? k.data : []);
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);
  async function patch(id: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(id);
    try { const r = await fetch(`/api/crosses/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) setMsg(j.error ?? `Could not update the cross (${r.status})`); else { setMsg(null); await load(); router.refresh(); } }
    catch { setMsg("Could not reach the server"); } finally { setBusy(null); }
  }
  async function decide(id: string, decision: "RETIRE" | "REPLACE" | "KEEP", note: string) {
    if (busy) return;
    setBusy(id);
    try { const r = await fetch(`/api/crosses/${id}/conflict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, note: note || null }) }); const j = await r.json().catch(() => ({})); if (!r.ok) setMsg(j.error ?? `Could not record the decision (${r.status})`); else { setMsg(decision === "REPLACE" && j.replacement ? `Replaced with ${j.replacement.ownSku}; publish a new version to carry it to reps.` : decision === "RETIRE" ? "Row retired; publish a new version to drop it from what reps see." : "Row kept; future runs rank it at the sheet grade."); await load(); router.refresh(); } }
    catch { setMsg("Could not reach the server"); } finally { setBusy(null); }
  }
  async function publish() {
    if (busy) return;
    setBusy("publish");
    try { const r = await fetch("/api/crosswalk/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: "Published from the Crosswalk page" }) }); const j = await r.json().catch(() => ({})); setMsg(r.ok ? `Published v${j.version.number} with ${j.entries} entries.` : j.error ?? `Could not publish (${r.status})`); await load(); router.refresh(); }
    catch { setMsg("Could not reach the server"); } finally { setBusy(null); }
  }
  const published = versions.find((v) => v.status === "PUBLISHED");
  const approvedUnpublished = byStatus.find((b) => b.approvalStatus === "APPROVED")?._count._all ?? 0;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 mb-5 [&>*]:min-w-0">
      <Card title="Published crosswalk" subtitle="Reps and proposals only ever see the published version">
        {msg && <div role="status" className="mb-2 text-[12px] text-accent-ink">{msg}</div>}
        {errors.versions && <div role="alert" className="mb-2 rounded-md bg-alt-soft text-alt px-3 py-2 text-[12px]">Could not load the published versions: {errors.versions}</div>}
        <div className="text-[13px]">{errors.versions ? <span className="text-muted">Version information unavailable.</span> : published ? <><span className="mono font-semibold">v{published.number}</span> · {published._count.entries.toLocaleString()} entries · {published._count.proposals} proposal(s) pinned · published {published.publishedAt?.slice(0, 10)}</> : <span className="text-muted">Nothing published yet.</span>}</div>
        <div className="text-[12px] text-muted mt-1">{byStatus.map((b) => `${b._count._all} ${b.approvalStatus.toLowerCase()}`).join(" · ")}</div>
        {canPublish && <button type="button" className="btn-primary mt-3 w-full justify-center" disabled={busy !== null} onClick={publish} title={`Freezes ${approvedUnpublished} approved crosses into a new version`}>{busy === "publish" ? "Publishing…" : "Publish new version"}</button>}
        {versions.length > 1 && <div className="mt-3 text-[12px] space-y-0.5">{versions.slice(0, 6).map((v) => <div key={v.id} className="flex justify-between"><span className="mono">v{v.number}</span><Pill value={v.status} /><span className="text-muted">{v._count.entries}</span></div>)}</div>}
      </Card>
      <Card title="Review queue" subtitle="Rep-proposed and draft crosses. Clinical + product marketing review, then approve; publishing makes them visible to reps." padded={false}>
        {!loaded ? <div className="p-5 text-[13px] text-muted">Loading the review queue…</div> : errors.queue ? <div role="alert" className="p-5 text-[13px] text-none">Could not load the review queue: {errors.queue}</div> : queue.length === 0 ? <div className="p-5 text-[13px] text-muted">Nothing awaiting review.</div> : (
          <table className="table !text-[12.5px]"><thead><tr><th>Our SKU</th><th>Competitor</th><th>Engine verdict</th><th>Equivalence</th><th>Clinical</th><th>Marketing</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{queue.map((c) => <tr key={c.id}><td className="mono font-semibold">{c.ownSku}</td><td>{c.competitorName} <span className="mono">{c.competitorCode}</span><div className="text-muted">{c.source}{evidence(c) ? ` · ${evidence(c)}` : ""}{c.justification ? ` · ${c.justification}` : ""}</div></td><td>{c.matchType}</td>
              <td>{canManage ? <select className="input !py-0.5 !text-[12px]" aria-label={`Equivalence level for ${c.ownSku}`} disabled={busy !== null} value={c.equivalenceLevel} onChange={(e) => patch(c.id, { equivalenceLevel: e.target.value })}>{EQ.map((e) => <option key={e} value={e}>{label(e)}</option>)}</select> : label(c.equivalenceLevel)}</td>
              <td>{canClinical && c.clinicalReviewStatus !== "APPROVED" ? <button type="button" className="btn-ghost !py-0.5 !text-[11px]" disabled={busy !== null} onClick={() => patch(c.id, { clinicalReviewStatus: "APPROVED" })}>Approve clinically</button> : <Pill value={c.clinicalReviewStatus} />}</td>
              <td>{canManage && c.marketingReviewStatus !== "APPROVED" ? <button type="button" className="btn-ghost !py-0.5 !text-[11px]" disabled={busy !== null} onClick={() => patch(c.id, { marketingReviewStatus: "APPROVED" })}>Approve marketing</button> : <Pill value={c.marketingReviewStatus} />}</td>
              <td><Pill value={c.approvalStatus} /></td>
              <td className="whitespace-nowrap">{canManage && <><button type="button" className="btn-secondary !py-0.5 !text-[11px]" disabled={busy !== null || c.clinicalReviewStatus !== "APPROVED" || c.marketingReviewStatus !== "APPROVED"} title={c.clinicalReviewStatus !== "APPROVED" || c.marketingReviewStatus !== "APPROVED" ? "Both reviews must be approved first" : "Approve this cross for publication"} onClick={() => patch(c.id, { approvalStatus: "APPROVED" })}>Approve</button> <button type="button" className="btn-ghost !py-0.5 !text-[11px]" disabled={busy !== null} onClick={() => patch(c.id, { approvalStatus: "REJECTED" })}>Reject</button></>}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card className="lg:col-span-2" title={`Evidence conflicts${conflicts.length ? ` (${conflicts.length})` : ""}`} subtitle="Curated rows a run's product attributes contradicted. The run already ranked them at the evidence's grade; settle the row here — retire it, replace it with what the evidence found, or keep the sheet's word. Runs never wait for this." padded={false}>
        {!loaded ? <div className="p-5 text-[13px] text-muted">Loading…</div> : errors.conflicts ? <div role="alert" className="p-5 text-[13px] text-none">Could not load the evidence conflicts: {errors.conflicts}</div> : conflicts.length === 0 ? <div className="p-5 text-[13px] text-muted">No curated row disagrees with the product evidence.</div> : <Conflicts rows={conflicts} canManage={canManage} busy={busy} onDecide={decide} />}
      </Card>
    </div>
  );
}

"use client";
/**
 * Extraction review: every extracted field with its confidence; the reviewer confirms,
 * corrects or rejects, finalises (VERIFIED), then imports the verified lines as observations.
 * Extraction confidence is shown for what it is — how sure the reader was — and never becomes
 * the commercial confidence of the observation.
 */
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Card, Chip, relTime } from "@/components/ui";
import { needs, usePermissions } from "@/components/permissions";

type Field = { id: string; scope: "HEADER" | "LINE"; lineNo: number | null; field: string; rawValue: string | null; normalizedValue: string | null; confidence: number | null; page: number | null; verificationStatus: string; correctedValue: string | null };
type Extraction = { id: string; provider: string; model: string | null; documentType: string; status: string; overallConfidence: number | null; threshold: number; completedAt: string | null; error: string | null; fields: Field[]; document: { id: string; filename: string; kind: string; uploadedAt: string } | null };

export function ExtractionReview({ id }: { id: string }) {
  const { can } = usePermissions();
  const canVerify = can("verify_competitor_pricing");
  const canImport = can("import_competitor_pricing");
  const [busy, setBusy] = useState(false);
  const [x, setX] = useState<Extraction | null>(null);
  const [edits, setEdits] = useState<Record<string, { status: "VERIFIED" | "CORRECTED" | "REJECTED"; correctedValue?: string | null }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { try { const r = await fetch(`/api/documents/extractions/${id}`, { cache: "no-store" }); const j = await r.json().catch(() => ({})); if (!r.ok) setMsg(j.error ?? `Could not load the extraction (${r.status})`); else setX(j); } catch { setMsg("Could not reach the server"); } }, [id]);
  useEffect(() => { load(); }, [load]);
  if (!x) return <PageHeader eyebrow="Competitive intelligence" title="Extraction" description={msg ?? "Loading…"} />;
  const lines = new Map<number, Field[]>();
  for (const f of x.fields) if (f.scope === "LINE" && f.lineNo) { if (!lines.has(f.lineNo)) lines.set(f.lineNo, []); lines.get(f.lineNo)!.push(f); }
  const header = x.fields.filter((f) => f.scope === "HEADER");
  const cols = [...new Set([...lines.values()].flat().map((f) => f.field))];
  const low = (f: Field) => f.confidence === null || f.confidence < x.threshold;
  const decide = (f: Field, status: "VERIFIED" | "CORRECTED" | "REJECTED", correctedValue?: string) => setEdits({ ...edits, [f.id]: { status, correctedValue: correctedValue ?? edits[f.id]?.correctedValue ?? f.correctedValue ?? f.normalizedValue } });
  const verifyAllRemaining = () => { const next = { ...edits }; for (const f of x.fields) if (!next[f.id] && f.verificationStatus === "UNVERIFIED") next[f.id] = { status: "VERIFIED" }; setEdits(next); };
  async function submit(finalize: boolean) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const decisions = Object.entries(edits).map(([fieldId, d]) => ({ fieldId, ...d }));
      const r = await fetch(`/api/documents/extractions/${id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions, finalize }) });
      const j = await r.json().catch(() => ({})); setMsg(r.ok ? `${j.verifiedFields} fields verified${finalize ? " — extraction verified; you can import the lines now" : ""}` : j.error ?? `Could not save (${r.status})`);
      if (r.ok) setEdits({});
      await load();
    } catch { setMsg("Could not reach the server"); } finally { setBusy(false); }
  }
  async function importLines() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/documents/extractions/${id}/import`, { method: "POST" });
      const j = await r.json().catch(() => ({})); setMsg(r.ok ? `${j.recorded} observations recorded from ${j.rows} verified lines${j.skipped?.length ? `; ${j.skipped.length} skipped: ${j.skipped.map((s: { row: number; reason: string }) => `row ${s.row} ${s.reason}`).join("; ")}` : ""}` : j.error ?? `Import failed (${r.status})`);
    } catch { setMsg("Could not reach the server"); } finally { setBusy(false); }
  }
  const state = (f: Field) => edits[f.id]?.status ?? f.verificationStatus;
  return (
    <>
      <PageHeader eyebrow="Competitive intelligence" title={x.document?.filename ?? "Extraction"} description={`${x.documentType} read by ${x.provider}${x.model ? ` (${x.model})` : ""} ${x.completedAt ? relTime(x.completedAt) : ""} · overall extraction confidence ${x.overallConfidence === null ? "unknown" : Math.round(x.overallConfidence * 100) + "%"} · review threshold ${Math.round(x.threshold * 100)}%`} actions={<div className="flex gap-2 items-center"><Chip tone={x.status === "VERIFIED" ? "exact" : x.status === "REVIEW" ? "alt" : x.status === "FAILED" ? "none" : "info"}>{x.status.toLowerCase()}</Chip>{x.status !== "VERIFIED" && canVerify && <><button type="button" className="btn-ghost" onClick={verifyAllRemaining}>Mark remaining as verified</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => submit(false)}>Save decisions</button><button type="button" className="btn-primary" disabled={busy} onClick={() => submit(true)}>Finalise as verified</button></>}{x.status !== "VERIFIED" && !canVerify && <span className="text-[12px] text-muted" title={needs("verify_competitor_pricing")}>Read-only: verifying needs <i>verify competitor pricing</i></span>}{x.status === "VERIFIED" && <button type="button" className="btn-primary" disabled={busy || !canImport} title={canImport ? undefined : needs("import_competitor_pricing")} onClick={importLines}>Import verified lines</button>}</div>} />
      {msg && <div role="status" className="mb-4 rounded-lg bg-accent-soft text-accent-ink px-4 py-2.5 text-[13px]">{msg}</div>}
      {x.error && <div className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{x.error}</div>}
      {header.length > 0 && (
        <Card title="Header" className="mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12.5px]">
            {header.map((f) => <div key={f.id} className={low(f) ? "rounded-md bg-alt-soft px-2 py-1" : ""}><div className="eyebrow">{f.field} <span className="normal-case text-muted">{f.confidence === null ? "" : Math.round(f.confidence * 100) + "%"}</span></div><FieldEditor f={f} state={state(f)} value={edits[f.id]?.correctedValue ?? f.correctedValue ?? f.normalizedValue ?? ""} locked={x.status === "VERIFIED" || !canVerify} onDecide={decide} /></div>)}
          </div>
        </Card>
      )}
      <Card title={`Lines (${lines.size})`} subtitle="Amber cells are below the threshold or missing a required field. Correct the value inline; reject a cell to drop it from the import." padded={false}>
        <table className="table">
          <thead><tr><th>#</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {[...lines.entries()].sort((a, b) => a[0] - b[0]).map(([no, fs]) => (
              <tr key={no}>
                <td className="mono">{no}</td>
                {cols.map((c) => { const f = fs.find((x) => x.field === c); return <td key={c} className={f && low(f) ? "bg-alt-soft" : ""}>{f ? <FieldEditor f={f} state={state(f)} value={edits[f.id]?.correctedValue ?? f.correctedValue ?? f.normalizedValue ?? ""} locked={x.status === "VERIFIED" || !canVerify} onDecide={decide} compact /> : <span className="text-muted">—</span>}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function FieldEditor({ f, state, value, locked, onDecide, compact }: { f: Field; state: string; value: string; locked: boolean; onDecide: (f: Field, s: "VERIFIED" | "CORRECTED" | "REJECTED", v?: string) => void; compact?: boolean }) {
  const tone = state === "VERIFIED" ? "text-exact" : state === "CORRECTED" ? "text-info" : state === "REJECTED" ? "text-none line-through" : "";
  if (locked) return <span className={`mono text-[12px] ${tone}`}>{state === "REJECTED" ? f.normalizedValue : value}</span>;
  return (
    <div className={compact ? "flex items-center gap-1" : "flex items-center gap-1 mt-0.5"}>
      <input className={`input mono !py-0.5 text-[12px] ${compact ? "!w-28" : ""} ${tone}`} aria-label={`${f.field}${f.lineNo ? ` line ${f.lineNo}` : ""}`} value={value} title={f.rawValue ?? ""} onChange={(e) => onDecide(f, "CORRECTED", e.target.value)} />
      <button type="button" className={`text-[11px] ${state === "VERIFIED" ? "text-exact" : "text-muted"}`} title="confirm" aria-label={`Confirm ${f.field}`} aria-pressed={state === "VERIFIED"} onClick={() => onDecide(f, "VERIFIED")}>✓</button>
      <button type="button" className={`text-[11px] ${state === "REJECTED" ? "text-none" : "text-muted"}`} title="reject" aria-label={`Reject ${f.field}`} aria-pressed={state === "REJECTED"} onClick={() => onDecide(f, "REJECTED")}>✕</button>
      {!compact && f.confidence !== null && <span className="text-[10.5px] text-muted">{Math.round(f.confidence * 100)}%</span>}
    </div>
  );
}

"use client";
/**
 * Extraction review: every extracted field with its confidence; the reviewer confirms,
 * corrects or rejects, finalises (VERIFIED), then imports the verified lines as observations.
 * Extraction confidence is shown for what it is — how sure the reader was — and never becomes
 * the commercial confidence of the observation.
 */
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Card, Chip, relTime } from "@/components/ui";

type Field = { id: string; scope: "HEADER" | "LINE"; lineNo: number | null; field: string; rawValue: string | null; normalizedValue: string | null; confidence: number | null; page: number | null; verificationStatus: string; correctedValue: string | null };
type Extraction = { id: string; provider: string; model: string | null; documentType: string; status: string; overallConfidence: number | null; threshold: number; completedAt: string | null; error: string | null; fields: Field[]; document: { id: string; filename: string; kind: string; uploadedAt: string } | null };

export function ExtractionReview({ id }: { id: string }) {
  const [x, setX] = useState<Extraction | null>(null);
  const [edits, setEdits] = useState<Record<string, { status: "VERIFIED" | "CORRECTED" | "REJECTED"; correctedValue?: string | null }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await fetch(`/api/documents/extractions/${id}`, { cache: "no-store" }); const j = await r.json(); if (!r.ok) setMsg(j.error); else setX(j); }, [id]);
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
    setMsg(null);
    const decisions = Object.entries(edits).map(([fieldId, d]) => ({ fieldId, ...d }));
    const r = await fetch(`/api/documents/extractions/${id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions, finalize }) });
    const j = await r.json(); setMsg(r.ok ? `${j.verifiedFields} fields verified${finalize ? " — extraction verified; you can import the lines now" : ""}` : j.error); setEdits({}); load();
  }
  async function importLines() {
    setMsg(null);
    const r = await fetch(`/api/documents/extractions/${id}/import`, { method: "POST" });
    const j = await r.json(); setMsg(r.ok ? `${j.recorded} observations recorded from ${j.rows} verified lines${j.skipped?.length ? `; ${j.skipped.length} skipped: ${j.skipped.map((s: { row: number; reason: string }) => `row ${s.row} ${s.reason}`).join("; ")}` : ""}` : j.error);
  }
  const state = (f: Field) => edits[f.id]?.status ?? f.verificationStatus;
  return (
    <>
      <PageHeader eyebrow="Competitive intelligence" title={x.document?.filename ?? "Extraction"} description={`${x.documentType} read by ${x.provider}${x.model ? ` (${x.model})` : ""} ${x.completedAt ? relTime(x.completedAt) : ""} · overall extraction confidence ${x.overallConfidence === null ? "unknown" : Math.round(x.overallConfidence * 100) + "%"} · review threshold ${Math.round(x.threshold * 100)}%`} actions={<div className="flex gap-2 items-center"><Chip tone={x.status === "VERIFIED" ? "exact" : x.status === "REVIEW" ? "alt" : x.status === "FAILED" ? "none" : "info"}>{x.status.toLowerCase()}</Chip>{x.status !== "VERIFIED" && <><button className="btn-ghost" onClick={verifyAllRemaining}>Mark remaining as verified</button><button className="btn-ghost" onClick={() => submit(false)}>Save decisions</button><button className="btn-primary" onClick={() => submit(true)}>Finalise as verified</button></>}{x.status === "VERIFIED" && <button className="btn-primary" onClick={importLines}>Import verified lines</button>}</div>} />
      {msg && <div className="mb-4 rounded-lg bg-accent-soft text-accent-ink px-4 py-2.5 text-[13px]">{msg}</div>}
      {x.error && <div className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{x.error}</div>}
      {header.length > 0 && (
        <Card title="Header" className="mb-4">
          <div className="grid grid-cols-3 gap-3 text-[12.5px]">
            {header.map((f) => <div key={f.id} className={low(f) ? "rounded-md bg-alt-soft px-2 py-1" : ""}><div className="eyebrow">{f.field} <span className="normal-case text-muted">{f.confidence === null ? "" : Math.round(f.confidence * 100) + "%"}</span></div><FieldEditor f={f} state={state(f)} value={edits[f.id]?.correctedValue ?? f.correctedValue ?? f.normalizedValue ?? ""} locked={x.status === "VERIFIED"} onDecide={decide} /></div>)}
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
                {cols.map((c) => { const f = fs.find((x) => x.field === c); return <td key={c} className={f && low(f) ? "bg-alt-soft" : ""}>{f ? <FieldEditor f={f} state={state(f)} value={edits[f.id]?.correctedValue ?? f.correctedValue ?? f.normalizedValue ?? ""} locked={x.status === "VERIFIED"} onDecide={decide} compact /> : <span className="text-muted">—</span>}</td>; })}
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
      <input className={`input mono !py-0.5 text-[12px] ${compact ? "!w-28" : ""} ${tone}`} value={value} title={f.rawValue ?? ""} onChange={(e) => onDecide(f, "CORRECTED", e.target.value)} />
      <button className={`text-[11px] ${state === "VERIFIED" ? "text-exact" : "text-muted"}`} title="confirm" onClick={() => onDecide(f, "VERIFIED")}>✓</button>
      <button className={`text-[11px] ${state === "REJECTED" ? "text-none" : "text-muted"}`} title="reject" onClick={() => onDecide(f, "REJECTED")}>✕</button>
      {!compact && f.confidence !== null && <span className="text-[10.5px] text-muted">{Math.round(f.confidence * 100)}%</span>}
    </div>
  );
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Card } from "@/components/ui";
import { Pill, fmtPct, label } from "@/components/commercial";
import { needs, usePermissions } from "@/components/permissions";

type Policy = { id: string; productFamily: string; version: number; status: string; name: string | null; targetMarginPct: number; minMarginPct: number; floorMethod: string; floorParams: Record<string, number>; defaultStrategy: string; defaultAdjustmentPct: number; classification: string; strategicImportance: number; authority: Record<string, number>; approvalRules: { when: Record<string, unknown>; require: string; reason?: string }[]; effectiveFrom: string; supersededAt: string | null };
const ROLES = ["SALES_REP", "REGIONAL_MANAGER", "CONTRACTING_MANAGER", "PRICING_DIRECTOR", "PRICING_COMMITTEE"];

export function PolicyEditor() {
  const { can } = usePermissions();
  const canConfigure = can("configure_pricing_rules");
  const [rows, setRows] = useState<Policy[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rulesText, setRulesText] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [edit, setEditState] = useState<Partial<Policy> & { productFamily: string } | null>(null);
  const setEdit = (e: (Partial<Policy> & { productFamily: string }) | null) => { setEditState(e); setRulesText(null); setRulesError(null); };
  const load = useCallback(async () => { try { const r = await fetch("/api/pricing-policies", { cache: "no-store" }); const j = await r.json().catch(() => ({})); if (!r.ok) setErr(j.error ?? `Could not load policies (${r.status})`); else { setRows(j); setErr(null); } } catch { setErr("Could not reach the server"); } }, []);
  useEffect(() => { load(); }, [load]);
  const families = [...new Set(rows.map((r) => r.productFamily))];
  async function saveDraft() {
    if (!edit || busy) return;
    if (rulesError) { setErr(`Approval rules: ${rulesError}`); return; }
    setBusy(true);
    try { const r = await fetch("/api/pricing-policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(edit) }); const j = await r.json().catch(() => ({})); if (!r.ok) setErr(j.error ?? `Could not save (${r.status})`); else { setErr(null); setEdit(null); load(); } }
    catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  async function activate(id: string) {
    if (busy) return;
    if (!window.confirm("Activate this draft? The active version for the family is superseded; proposals keep the version they used.")) return;
    setBusy(true);
    try { const r = await fetch(`/api/pricing-policies/${id}/activate`, { method: "POST" }); if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? `Could not activate (${r.status})`); else { setErr(null); load(); } }
    catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader eyebrow="Settings" title="Pricing policies" description="Versioned per product family; “*” is the default. Target and minimum margin define the floor; authority bands say how far each role may go below the customer's current price; approval rules add conditions. Activating a draft supersedes the active version — proposals keep the version they used." actions={<button type="button" className="btn-primary" disabled={!canConfigure} title={canConfigure ? undefined : needs("configure_pricing_rules")} onClick={() => setEdit({ productFamily: "*" })}>New draft</button>} />
      {err && <div role="alert" className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {edit && (
        <Card title="Draft policy version" className="mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-[13px]">
            <label className="label">Product family<input className="input" list="fams" value={edit.productFamily} onChange={(e) => setEdit({ ...edit, productFamily: e.target.value })} /><datalist id="fams">{["*", ...families].map((f) => <option key={f} value={f} />)}</datalist></label>
            <label className="label">Name<input className="input" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="label">Target margin<input className="input mono" value={edit.targetMarginPct ?? 0.45} onChange={(e) => setEdit({ ...edit, targetMarginPct: Number(e.target.value) })} /></label>
            <label className="label">Minimum margin (floor)<input className="input mono" value={edit.minMarginPct ?? 0.3} onChange={(e) => setEdit({ ...edit, minMarginPct: Number(e.target.value) })} /></label>
            <label className="label">Default strategy<select className="input" value={edit.defaultStrategy ?? "MATCH"} onChange={(e) => setEdit({ ...edit, defaultStrategy: e.target.value })}>{["MATCH", "UNDERCUT_PCT", "UNDERCUT_AMOUNT", "HOLD_PREMIUM", "PRESERVE_CONTRACT", "STRATEGIC_DISCOUNT", "PENETRATION"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
            <label className="label">Default adjustment (fraction)<input className="input mono" value={edit.defaultAdjustmentPct ?? 0} onChange={(e) => setEdit({ ...edit, defaultAdjustmentPct: Number(e.target.value) })} /></label>
            <label className="label">Classification<select className="input" value={edit.classification ?? "DIFFERENTIATED"} onChange={(e) => setEdit({ ...edit, classification: e.target.value })}><option>DIFFERENTIATED</option><option>COMMODITY</option></select></label>
            <label className="label">Strategic importance (1–5)<input className="input mono" type="number" min={1} max={5} value={edit.strategicImportance ?? 3} onChange={(e) => setEdit({ ...edit, strategicImportance: Number(e.target.value) })} /></label>
            <div className="sm:col-span-2 lg:col-span-4"><div className="eyebrow mb-1">Discount authority (max fraction below current price)</div><div className="grid grid-cols-2 md:grid-cols-5 gap-2">{ROLES.map((r) => <label key={r} className="label">{label(r)}<input className="input mono" value={edit.authority?.[r] ?? ""} onChange={(e) => setEdit({ ...edit, authority: { ...(edit.authority ?? {}), [r]: Number(e.target.value) } })} /></label>)}</div></div>
            <label className="label sm:col-span-2 lg:col-span-4">Approval rules (JSON)<textarea className={`input mono h-24 ${rulesError ? "!border-none" : ""}`} aria-invalid={Boolean(rulesError)} value={rulesText ?? JSON.stringify(edit.approvalRules ?? [{ when: { belowFloor: true }, require: "PRICING_COMMITTEE", reason: "below floor" }], null, 1)} onChange={(e) => { setRulesText(e.target.value); try { const parsed = JSON.parse(e.target.value); if (!Array.isArray(parsed)) throw new Error("must be a JSON array of rules"); setEditState({ ...edit, approvalRules: parsed }); setRulesError(null); } catch (ex) { setRulesError((ex as Error).message); } }} />{rulesError && <span className="block text-[11.5px] text-none font-normal mt-1">Not saved until valid: {rulesError}</span>}</label>
          </div>
          <div className="flex justify-end gap-2 mt-3"><button type="button" className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="btn-primary" disabled={busy || Boolean(rulesError)} title={rulesError ? "Fix the approval rules JSON first" : undefined} onClick={saveDraft}>{busy ? "Saving…" : "Save draft"}</button></div>
        </Card>
      )}
      <Card padded={false}>
        <table className="table !text-[12.5px]"><thead><tr><th>Family</th><th>v</th><th>Status</th><th>Target / min margin</th><th>Strategy</th><th>Class</th><th>Rep / Mgr / Dir authority</th><th>Rules</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{rows.map((p) => <tr key={p.id} className={p.status === "SUPERSEDED" ? "bg-panel-2 [&>td]:text-muted" : ""}><td><b>{p.productFamily}</b><div className="text-muted">{p.name}</div></td><td className="mono">{p.version}</td><td><Pill value={p.status} /></td><td className="mono">{fmtPct(p.targetMarginPct)} / {fmtPct(p.minMarginPct)}</td><td>{label(p.defaultStrategy)}{p.defaultAdjustmentPct ? ` ${fmtPct(p.defaultAdjustmentPct)}` : ""}</td><td className="text-muted">{p.classification.toLowerCase()} · {p.strategicImportance}/5</td><td className="mono">{fmtPct(p.authority.SALES_REP, 0)} / {fmtPct(p.authority.REGIONAL_MANAGER, 0)} / {fmtPct(p.authority.PRICING_DIRECTOR, 0)}</td><td className="text-muted">{p.approvalRules.map((r) => r.reason ?? r.require).join("; ")}</td><td className="whitespace-nowrap">{canConfigure && p.status === "DRAFT" && <button type="button" className="btn-secondary !py-0.5 !text-[11px]" disabled={busy} onClick={() => activate(p.id)}>Activate</button>}{canConfigure && p.status !== "DRAFT" && <button type="button" className="btn-ghost !py-0.5 !text-[11px]" onClick={() => setEdit({ ...p, name: p.name ?? undefined })}>New version</button>}</td></tr>)}</tbody>
        </table>
      </Card>
    </>
  );
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { fmtMoney } from "@/components/commercial";

type L = { freightMode: string; freightValue: string | null; taxMode: string; taxRate: string | null; taxExemptionNo: string | null; shipTo: Record<string, string | null> | null; taxProvider: string | null; totals: { currency: string; subtotal: string; freight: string; tax: string | null; total: string; taxCalculatedAt: string | null; taxStale: boolean; taxNote: string | null }; summary: { jurisdiction: string; taxName: string; rate: number | null; tax: string }[] | null; service: { provider: string; avatax: { configured: boolean; env: string; dryRun: boolean }; note: string } };

/** Freight & tax: quote-level, never in margin. Collapsed to one line of totals until opened. */
export function LogisticsPanel({ id, editable, version }: { id: string; editable: boolean; version: string }) {
  const [d, setD] = useState<L | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ freightMode: "NONE", freightValue: "", taxMode: "NONE", taxRate: "", taxExemptionNo: "", line1: "", city: "", region: "", postalCode: "" });
  const load = useCallback(async () => {
    const r = await fetch(`/api/proposals/${id}/logistics`, { cache: "no-store" }); if (!r.ok) return;
    const j: L = await r.json(); setD(j);
    setForm({ freightMode: j.freightMode, freightValue: j.freightValue ?? "", taxMode: j.taxMode, taxRate: j.taxRate ?? "", taxExemptionNo: j.taxExemptionNo ?? "", line1: j.shipTo?.line1 ?? "", city: j.shipTo?.city ?? "", region: j.shipTo?.region ?? "", postalCode: j.shipTo?.postalCode ?? "" });
  }, [id]);
  useEffect(() => { load(); }, [load, version]);
  async function save() {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/proposals/${id}/logistics`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ freightMode: form.freightMode, freightValue: form.freightValue || null, taxMode: form.taxMode, taxRate: form.taxRate || null, taxExemptionNo: form.taxExemptionNo || null, shipTo: { line1: form.line1, city: form.city, region: form.region, postalCode: form.postalCode, country: "US" } }) });
    const j = await r.json(); setBusy(false); if (!r.ok) { setErr(j.error); return; } setD(j);
  }
  async function calculate() {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/proposals/${id}/logistics`, { method: "POST" }); const j = await r.json(); setBusy(false);
    if (!r.ok) { setErr(j.error); return; } setD(j);
  }
  if (!d) return null;
  const t = d.totals;
  const needsCalc = (d.taxMode === "MANUAL" || d.taxMode === "PROVIDER") && (t.tax === null || t.taxStale);
  return (
    <div className="card mb-3 text-[12.5px]">
      <div className="flex items-center gap-4 px-4 py-2.5">
        <span className="font-medium">Freight &amp; tax</span>
        <span className="text-muted">Subtotal <b className="mono text-ink">{fmtMoney(t.subtotal, t.currency)}</b></span>
        <span className="text-muted">Freight <b className="mono text-ink">{d.freightMode === "NONE" ? "—" : fmtMoney(t.freight, t.currency)}</b>{d.freightMode === "PCT" ? ` (${d.freightValue}%)` : ""}</span>
        <span className="text-muted">Tax <b className={`mono ${needsCalc ? "text-alt" : "text-ink"}`}>{d.taxMode === "NONE" ? "excluded" : d.taxMode === "EXEMPT" ? "exempt" : t.tax === null ? "not calculated" : t.taxStale ? `${fmtMoney(t.tax, t.currency)} (stale)` : fmtMoney(t.tax, t.currency)}</b></span>
        <span className="text-muted">Quote total <b className="mono text-ink">{fmtMoney(t.total, t.currency)}</b></span>
        {needsCalc && editable && <button className="btn-secondary !py-1 !text-[12px]" disabled={busy} onClick={calculate}>{busy ? "Calculating…" : t.tax === null ? "Calculate tax" : "Recalculate tax"}</button>}
        <button className="btn-ghost !py-1 !text-[12px] ml-auto" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>
      </div>
      {err && <div className="px-4 pb-2 text-none">{err}</div>}
      {open && (
        <div className="border-t border-line-2 px-4 py-3 grid grid-cols-[160px_120px_160px_120px_1fr] gap-3 items-end">
          <div><label className="label">Freight</label><select className="input" value={form.freightMode} disabled={!editable} onChange={(e) => setForm({ ...form, freightMode: e.target.value })}><option value="NONE">Not included</option><option value="FLAT">Flat amount</option><option value="PCT">% of subtotal</option></select></div>
          <div><label className="label">{form.freightMode === "PCT" ? "Percent" : "Amount"}</label><input className="input mono" disabled={!editable || form.freightMode === "NONE"} value={form.freightValue} onChange={(e) => setForm({ ...form, freightValue: e.target.value })} /></div>
          <div><label className="label">Tax</label><select className="input" value={form.taxMode} disabled={!editable} onChange={(e) => setForm({ ...form, taxMode: e.target.value })}><option value="NONE">Excluded (stated on quote)</option><option value="EXEMPT">Exempt customer</option><option value="MANUAL">Manual rate</option><option value="PROVIDER" disabled={!d.service.avatax.configured}>Tax service{d.service.avatax.configured ? ` (AvaTax ${d.service.avatax.env}${d.service.avatax.dryRun ? ", dry run" : ""})` : " — not configured"}</option></select></div>
          <div><label className="label">{form.taxMode === "EXEMPT" ? "Certificate #" : "Rate (0.0825)"}</label>{form.taxMode === "EXEMPT" ? <input className="input mono" disabled={!editable} value={form.taxExemptionNo} onChange={(e) => setForm({ ...form, taxExemptionNo: e.target.value })} /> : <input className="input mono" disabled={!editable || form.taxMode !== "MANUAL"} value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />}</div>
          <div className="grid grid-cols-[1fr_120px_60px_90px] gap-2">
            <div><label className="label">Ship-to street</label><input className="input" disabled={!editable} value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} /></div>
            <div><label className="label">City</label><input className="input" disabled={!editable} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
            <div><label className="label">State</label><input className="input" disabled={!editable} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
            <div><label className="label">ZIP</label><input className="input mono" disabled={!editable} value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></div>
          </div>
          <div className="col-span-5 flex items-center gap-3 text-[11.5px] text-muted">
            {editable && <button className="btn-primary !py-1 !text-[12px]" disabled={busy} onClick={save}>Save</button>}
            <span>{d.service.note}. Freight and tax sit under the subtotal on the quote and never enter margin, floors or approvals.</span>
            {t.taxCalculatedAt && <span>Tax last calculated {new Date(t.taxCalculatedAt).toLocaleString()}{d.taxProvider ? ` via ${d.taxProvider}` : ""}{t.taxNote ? ` · ${t.taxNote}` : ""}</span>}
          </div>
          {d.summary && d.summary.length > 0 && <div className="col-span-5 flex flex-wrap gap-2 text-[11.5px]">{d.summary.map((s, i) => <span key={i} className="chip bg-line-2">{s.jurisdiction} {s.taxName} {s.rate != null ? `${(s.rate * 100).toFixed(3)}%` : ""} · {fmtMoney(s.tax, t.currency)}</span>)}</div>}
        </div>
      )}
    </div>
  );
}

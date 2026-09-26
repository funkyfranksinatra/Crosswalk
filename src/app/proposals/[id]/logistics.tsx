"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtMoney } from "@/components/commercial";

type L = { freightMode: string; freightValue: string | null; taxMode: string; taxRate: string | null; taxExemptionNo: string | null; shipTo: Record<string, string | null> | null; taxProvider: string | null; totals: { currency: string; subtotal: string; freight: string; tax: string | null; total: string; taxCalculatedAt: string | null; taxStale: boolean; taxNote: string | null }; summary: { jurisdiction: string; taxName: string; rate: number | null; tax: string }[] | null; service: { provider: string; avatax: { configured: boolean; env: string; dryRun: boolean }; note: string } };

/** Freight & tax: quote-level, never in margin. Collapsed to one line of totals until opened. */
export function LogisticsPanel({ id, editable, version }: { id: string; editable: boolean; version: string }) {
  const [d, setD] = useState<L | null>(null);
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const setOpen = (v: boolean) => { openRef.current = v; setOpenState(v); };
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ freightMode: "NONE", freightValue: "", taxMode: "NONE", taxRate: "", taxExemptionNo: "", line1: "", city: "", region: "", postalCode: "" });
  const load = useCallback(async () => {
    let r: Response; try { r = await fetch(`/api/proposals/${id}/logistics`, { cache: "no-store" }); } catch { return; }
    if (!r.ok) return;
    const j: L = await r.json().catch(() => null); if (!j) return; setD(j);
    // Never overwrite an open form with a colleague's change; the totals line updates regardless.
    if (!openRef.current) setForm({ freightMode: j.freightMode, freightValue: j.freightValue ?? "", taxMode: j.taxMode, taxRate: j.taxRate ?? "", taxExemptionNo: j.taxExemptionNo ?? "", line1: j.shipTo?.line1 ?? "", city: j.shipTo?.city ?? "", region: j.shipTo?.region ?? "", postalCode: j.shipTo?.postalCode ?? "" });
  }, [id]);
  useEffect(() => { load(); }, [load, version]);
  async function save() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const blankShipTo = ![form.line1, form.city, form.region, form.postalCode].some((v) => v.trim());
      const r = await fetch(`/api/proposals/${id}/logistics`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ freightMode: form.freightMode, freightValue: form.freightValue || null, taxMode: form.taxMode, taxRate: form.taxRate || null, taxExemptionNo: form.taxExemptionNo || null, shipTo: blankShipTo ? null : { line1: form.line1, city: form.city, region: form.region, postalCode: form.postalCode, country: "US" } }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) { setErr(j.error ?? `Could not save (${r.status})`); return; } setD(j); setOpen(false);
    } catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  async function calculate() {
    if (busy) return;
    setBusy(true); setErr(null);
    try { const r = await fetch(`/api/proposals/${id}/logistics`, { method: "POST" }); const j = await r.json().catch(() => ({})); if (!r.ok) { setErr(j.error ?? `Could not calculate (${r.status})`); return; } setD(j); }
    catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  if (!d) return null;
  const t = d.totals;
  const needsCalc = (d.taxMode === "MANUAL" || d.taxMode === "PROVIDER") && (t.tax === null || t.taxStale);
  return (
    <div className="card mb-3 text-[12.5px]">
      <div className="flex items-center gap-4 px-4 py-2.5 flex-wrap">
        <span className="font-medium">Freight &amp; tax</span>
        <span className="text-muted">Subtotal <b className="mono text-ink">{fmtMoney(t.subtotal, t.currency)}</b></span>
        <span className="text-muted">Freight <b className="mono text-ink">{d.freightMode === "NONE" ? "—" : fmtMoney(t.freight, t.currency)}</b>{d.freightMode === "PCT" ? ` (${d.freightValue}%)` : ""}</span>
        <span className="text-muted">Tax <b className={`mono ${needsCalc ? "text-alt" : "text-ink"}`}>{d.taxMode === "NONE" ? "excluded" : d.taxMode === "EXEMPT" ? "exempt" : t.tax === null ? "not calculated" : t.taxStale ? `${fmtMoney(t.tax, t.currency)} (stale)` : fmtMoney(t.tax, t.currency)}</b></span>
        <span className="text-muted">Quote total <b className="mono text-ink">{fmtMoney(t.total, t.currency)}</b></span>
        {needsCalc && editable && <button type="button" className="btn-secondary !py-1 !text-[12px]" disabled={busy} onClick={calculate}>{busy ? "Calculating…" : t.tax === null ? "Calculate tax" : "Recalculate tax"}</button>}
        <button type="button" className="btn-ghost !py-1 !text-[12px] ml-auto" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : editable ? "Edit" : "Details"}</button>
      </div>
      {err && <div role="alert" className="px-4 pb-2 text-none">{err}</div>}
      {open && (
        <div className="border-t border-line-2 px-4 py-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[160px_120px_160px_120px_1fr] gap-3 items-end">
          <div><label className="label" htmlFor="lg-freight">Freight</label><select id="lg-freight" className="input" value={form.freightMode} disabled={!editable} onChange={(e) => setForm({ ...form, freightMode: e.target.value })}><option value="NONE">Not included</option><option value="FLAT">Flat amount</option><option value="PCT">% of subtotal</option></select></div>
          <div><label className="label" htmlFor="lg-freight-value">{form.freightMode === "PCT" ? "Percent" : "Amount"}</label><input id="lg-freight-value" className="input mono" inputMode="decimal" disabled={!editable || form.freightMode === "NONE"} value={form.freightValue} onChange={(e) => setForm({ ...form, freightValue: e.target.value })} /></div>
          <div><label className="label" htmlFor="lg-tax">Tax</label><select id="lg-tax" className="input" value={form.taxMode} disabled={!editable} onChange={(e) => setForm({ ...form, taxMode: e.target.value })}><option value="NONE">Excluded (stated on quote)</option><option value="EXEMPT">Exempt customer</option><option value="MANUAL">Manual rate</option><option value="PROVIDER" disabled={!d.service.avatax.configured}>Tax service{d.service.avatax.configured ? ` (AvaTax ${d.service.avatax.env}${d.service.avatax.dryRun ? ", dry run" : ""})` : " — not configured"}</option></select></div>
          <div><label className="label" htmlFor="lg-tax-value">{form.taxMode === "EXEMPT" ? "Certificate #" : "Rate (0.0825)"}</label>{form.taxMode === "EXEMPT" ? <input id="lg-tax-value" className="input mono" disabled={!editable} value={form.taxExemptionNo} onChange={(e) => setForm({ ...form, taxExemptionNo: e.target.value })} /> : <input id="lg-tax-value" className="input mono" inputMode="decimal" disabled={!editable || form.taxMode !== "MANUAL"} value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />}</div>
          <div className="md:col-span-2 xl:col-span-1 grid grid-cols-2 md:grid-cols-[1fr_120px_60px_90px] gap-2">
            <div><label className="label" htmlFor="lg-ship-to-street">Ship-to street</label><input id="lg-ship-to-street" className="input" disabled={!editable} value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} /></div>
            <div><label className="label" htmlFor="lg-city">City</label><input id="lg-city" className="input" disabled={!editable} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
            <div><label className="label" htmlFor="lg-state">State</label><input id="lg-state" className="input" disabled={!editable} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
            <div><label className="label" htmlFor="lg-zip">ZIP</label><input id="lg-zip" className="input mono" disabled={!editable} value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></div>
          </div>
          <div className="md:col-span-2 xl:col-span-5 flex items-center gap-3 text-[11.5px] text-muted">
            {editable && <button type="button" className="btn-primary !py-1 !text-[12px]" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>}
            <span>{d.service.note}. Freight and tax sit under the subtotal on the quote and never enter margin, floors or approvals.</span>
            {t.taxCalculatedAt && <span>Tax last calculated {new Date(t.taxCalculatedAt).toLocaleString()}{d.taxProvider ? ` via ${d.taxProvider}` : ""}{t.taxNote ? ` · ${t.taxNote}` : ""}</span>}
          </div>
          {d.summary && d.summary.length > 0 && <div className="md:col-span-2 xl:col-span-5 flex flex-wrap gap-2 text-[11.5px]">{d.summary.map((s, i) => <span key={i} className="chip bg-line-2">{s.jurisdiction} {s.taxName} {s.rate != null ? `${(s.rate * 100).toFixed(3)}%` : ""} · {fmtMoney(s.tax, t.currency)}</span>)}</div>}
        </div>
      )}
    </div>
  );
}

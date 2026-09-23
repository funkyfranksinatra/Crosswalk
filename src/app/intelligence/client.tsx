"use client";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Card, Empty } from "@/components/ui";
import { Pill, fmtMoney, label } from "@/components/commercial";

type Row = { id: string; competitorSku: string; price: string; currency: string; observedAt: string; sourceType: string; sourceRef: string | null; rawConfidence: number; verificationStatus: string; notes: string | null; competitor: { name: string }; account: { name: string } | null; gpo: { name: string } | null; document: { filename: string } | null };
type Summary = { basis: string; reference: string | null; confidence: number; explanation: string; median: string | null; min: string | null; max: string | null; count: number; countUsed: number; trend: string; observations: { id: string; currentConfidence: number; relevance: number; relation: string; ageDays: number }[] };

export function Intelligence({ sku: initialSku, accountId }: { sku: string; accountId: string }) {
  const [sku, setSku] = useState(initialSku);
  const [data, setData] = useState<{ summary?: Summary; rows?: Row[]; recent?: Row[]; bySku?: { competitorSku: string; competitor: string; _count: { _all: number }; _max: { observedAt: string | null }; _min: { price: string | null }; _avg: { price: string | null } }[]; sourceTypes?: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ competitorName: "", competitorSku: initialSku, price: "", sourceType: "REP_OBSERVED", accountNumber: "", observedAt: new Date().toISOString().slice(0, 10), sourceRef: "", notes: "" });
  const load = useCallback(async () => { const r = await fetch(`/api/intelligence?${sku ? `sku=${encodeURIComponent(sku)}&` : ""}${accountId ? `accountId=${accountId}` : ""}`, { cache: "no-store" }); const j = await r.json(); if (!r.ok) setErr(j.error); else { setData(j); setErr(null); } }, [sku, accountId]);
  useEffect(() => { load(); }, [load]);
  async function record() {
    let acc: string | null = null;
    if (form.accountNumber) { const a = await fetch(`/api/accounts?q=${encodeURIComponent(form.accountNumber)}`).then((r) => r.json()); acc = a[0]?.id ?? null; }
    const r = await fetch("/api/intelligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, accountId: acc }) });
    const j = await r.json(); if (!r.ok) setMsg(j.error); else { setMsg("Observation recorded."); setForm({ ...form, price: "", sourceRef: "", notes: "" }); load(); }
  }
  async function verify(id: string, status: string) { const r = await fetch(`/api/intelligence/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }); if (!r.ok) setMsg((await r.json()).error); else load(); }
  async function extractFile(f: File) { const fd = new FormData(); fd.append("file", f); fd.append("documentType", /po|purchase/i.test(f.name) ? "PO" : /bid/i.test(f.name) ? "BID_LIST" : /contract/i.test(f.name) ? "CONTRACT_TABLE" : "INVOICE"); const r = await fetch("/api/documents/extract", { method: "POST", body: fd }); const j = await r.json(); if (!r.ok) { setMsg(j.error); return; } window.location.href = `/intelligence/extractions/${j.extractionId}`; }
  async function importFile(f: File) { const fd = new FormData(); fd.append("file", f); const r = await fetch("/api/intelligence/import", { method: "POST", body: fd }); const j = await r.json(); setMsg(r.ok ? `${j.recorded} observations recorded from ${j.rows} rows${j.skipped.length ? `; ${j.skipped.length} skipped` : ""}` : j.error); load(); }
  const s = data?.summary; const rows = data?.rows ?? data?.recent ?? [];
  return (
    <>
      <PageHeader eyebrow="Competitive intelligence" title="Competitor pricing" description="Append-only, dated observations with provenance. Confidence decays by source half-life; the summary says whether a price is known for this account, a market estimate, or weak." actions={<div className="flex gap-2"><label className="btn-secondary cursor-pointer">Import .xlsx / .csv<input type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }} /></label><label className="btn-ghost cursor-pointer" title="Invoice, PO, bid list or contract table → extraction → review → observations">Extract a document…<input type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) extractFile(f); e.target.value = ""; }} /></label></div>} />
      {err && <div className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {msg && <div className="mb-4 rounded-lg bg-accent-soft text-accent-ink px-4 py-2.5 text-[13px]">{msg}</div>}
      <div className="grid grid-cols-[1fr_340px] gap-4">
        <div className="space-y-4">
          <Card>
            <div className="flex gap-2 items-center"><input className="input mono !w-64" placeholder="Competitor code, e.g. 1190500" value={sku} onChange={(e) => setSku(e.target.value)} /><span className="text-[12px] text-muted">{accountId ? "in the context of the selected account" : "market-wide context"}</span></div>
            {s && <div className="mt-3"><Pill value={s.basis} /> <span className="text-[13px]">{s.explanation}</span><div className="mt-2 grid grid-cols-5 gap-3 text-[12px]"><div><div className="eyebrow">Reference</div><div className="mono">{fmtMoney(s.reference)}</div></div><div><div className="eyebrow">Confidence</div><div className="mono">{Math.round(s.confidence * 100)}%</div></div><div><div className="eyebrow">Median</div><div className="mono">{fmtMoney(s.median)}</div></div><div><div className="eyebrow">Range</div><div className="mono">{fmtMoney(s.min)} – {fmtMoney(s.max)}</div></div><div><div className="eyebrow">Trend</div><div className="mono">{label(s.trend)}</div></div></div></div>}
          </Card>
          <Card padded={false} title={sku ? `Observations for ${sku}` : "Recent observations"}>
            {rows.length === 0 ? <Empty title="No observations">Record one on the right, or import a sheet.</Empty> : (
              <table className="table !text-[12.5px]"><thead><tr><th>Competitor</th><th>Code</th><th className="text-right">Price</th><th>Observed</th><th>Where</th><th>Source</th><th>Now</th><th>Status</th><th></th></tr></thead>
                <tbody>{rows.map((o) => { const w = s?.observations.find((x) => x.id === o.id); return <tr key={o.id}><td>{o.competitor.name}</td><td className="mono">{o.competitorSku}</td><td className="mono text-right">{fmtMoney(o.price, o.currency)}</td><td className="mono">{o.observedAt.slice(0, 10)}</td><td className="text-muted">{o.account?.name ?? o.gpo?.name ?? "market"}</td><td className="text-muted">{label(o.sourceType)}{o.sourceRef ? ` · ${o.sourceRef}` : ""}{o.document ? ` · ${o.document.filename}` : ""}</td><td className="mono">{w ? `${Math.round(w.currentConfidence * 100)}% · ${w.relation.toLowerCase()}` : `${Math.round(o.rawConfidence * 100)}% raw`}</td><td><Pill value={o.verificationStatus} /></td><td className="whitespace-nowrap">{o.verificationStatus !== "VERIFIED" && <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => verify(o.id, "VERIFIED")}>Verify</button>}{o.verificationStatus !== "DISPUTED" && <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => verify(o.id, "DISPUTED")}>Dispute</button>}</td></tr>; })}</tbody>
              </table>
            )}
          </Card>
          {!sku && data?.bySku && <Card padded={false} title="Coverage by competitor code"><table className="table !text-[12.5px]"><thead><tr><th>Competitor</th><th>Code</th><th className="text-right">Obs.</th><th>Latest</th><th className="text-right">Min</th><th className="text-right">Avg</th></tr></thead><tbody>{data.bySku.map((b) => <tr key={b.competitorSku + b.competitor}><td>{b.competitor}</td><td className="mono"><button className="text-accent" onClick={() => setSku(b.competitorSku)}>{b.competitorSku}</button></td><td className="mono text-right">{b._count._all}</td><td className="mono">{b._max.observedAt?.slice(0, 10)}</td><td className="mono text-right">{fmtMoney(b._min.price)}</td><td className="mono text-right">{fmtMoney(b._avg.price)}</td></tr>)}</tbody></table></Card>}
        </div>
        <Card title="Record an observation" subtitle="Provenance is mandatory — say where the price came from">
          <div className="space-y-2">
            <input className="input" placeholder="Competitor (e.g. BD - Bard)" value={form.competitorName} onChange={(e) => setForm({ ...form, competitorName: e.target.value })} />
            <input className="input mono" placeholder="Competitor code" value={form.competitorSku} onChange={(e) => setForm({ ...form, competitorSku: e.target.value })} />
            <input className="input mono" placeholder="Price (USD)" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            <select className="input" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>{(data?.sourceTypes ?? ["CUSTOMER_INVOICE", "CUSTOMER_PO", "CUSTOMER_BID_FILE", "GPO_CONTRACT_FILE", "WIN_LOSS_RECORD", "INTERNAL_VERIFIED", "REP_OBSERVED", "ANECDOTAL"]).map((t) => <option key={t} value={t}>{label(t)}</option>)}</select>
            <input className="input" placeholder="Account number or name (optional)" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
            <input className="input" type="date" value={form.observedAt} onChange={(e) => setForm({ ...form, observedAt: e.target.value })} />
            <input className="input" placeholder="Source reference (invoice #, file name…)" value={form.sourceRef} onChange={(e) => setForm({ ...form, sourceRef: e.target.value })} />
            <input className="input" placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <button className="btn-primary w-full justify-center" disabled={!form.competitorName || !form.competitorSku || !form.price} onClick={record}>Record</button>
          </div>
        </Card>
      </div>
    </>
  );
}

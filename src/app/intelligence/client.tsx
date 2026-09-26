"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader, Card, Empty } from "@/components/ui";
import { Pill, fmtMoney, label } from "@/components/commercial";
import { needs, usePermissions } from "@/components/permissions";

type Row = { id: string; competitorSku: string; price: string; currency: string; observedAt: string; sourceType: string; sourceRef: string | null; rawConfidence: number; verificationStatus: string; notes: string | null; competitor: { name: string }; account: { name: string } | null; gpo: { name: string } | null; document: { filename: string } | null };
type Summary = { basis: string; reference: string | null; confidence: number; explanation: string; median: string | null; min: string | null; max: string | null; count: number; countUsed: number; trend: string; observations: { id: string; currentConfidence: number; relevance: number; relation: string; ageDays: number }[] };

export function Intelligence({ sku: initialSku, accountId }: { sku: string; accountId: string }) {
  const { can } = usePermissions();
  const canRecord = can("import_competitor_pricing");
  const canVerify = can("verify_competitor_pricing");
  const [busy, setBusy] = useState(false);
  const [sku, setSku] = useState(initialSku);
  const [data, setData] = useState<{ summary?: Summary; rows?: Row[]; recent?: Row[]; bySku?: { competitorSku: string; competitor: string; _count: { _all: number }; _max: { observedAt: string | null }; _min: { price: string | null }; _avg: { price: string | null } }[]; sourceTypes?: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ competitorName: "", competitorSku: initialSku, price: "", sourceType: "REP_OBSERVED", accountNumber: "", observedAt: new Date().toISOString().slice(0, 10), sourceRef: "", notes: "" });
  // Search is debounced and out-of-order replies are dropped, so typing a code quickly never
  // shows the results of an earlier keystroke over the latest one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch(`/api/intelligence?${sku ? `sku=${encodeURIComponent(sku)}&` : ""}${accountId ? `accountId=${encodeURIComponent(accountId)}` : ""}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!r.ok) setErr(j.error ?? `Could not load observations (${r.status})`); else { setData(j); setErr(null); }
    } catch { if (mine === seq.current) setErr("Could not reach the server"); }
  }, [sku, accountId]);
  useEffect(() => { const t = setTimeout(load, sku ? 250 : 0); return () => clearTimeout(t); }, [load, sku]);
  async function record() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      let acc: string | null = null;
      if (form.accountNumber) {
        const q = form.accountNumber.trim();
        const r = await fetch(`/api/accounts?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const a = (await r.json().catch(() => null)) as { id: string; name: string; accountNumber: string | null }[] | null;
        const hit = Array.isArray(a) ? a.find((x) => x.accountNumber === q) ?? a.find((x) => x.name.toLowerCase() === q.toLowerCase()) ?? (a.length === 1 ? a[0] : undefined) : undefined;
        if (!hit) { setMsg(Array.isArray(a) && a.length ? `Account "${q}" is ambiguous — ${a.length} matches; use the account number` : `Account "${q}" not found`); return; }
        acc = hit.id;
      }
      const r = await fetch("/api/intelligence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, accountId: acc }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg(j.error ?? `Could not record (${r.status})`); else { setMsg("Observation recorded."); setForm({ ...form, price: "", sourceRef: "", notes: "" }); load(); }
    } catch { setMsg("Could not reach the server"); } finally { setBusy(false); }
  }
  async function verify(id: string, status: string) {
    if (busy) return;
    setBusy(true);
    try { const r = await fetch(`/api/intelligence/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }); if (!r.ok) setMsg((await r.json().catch(() => ({}))).error ?? `Could not update (${r.status})`); else { setMsg(null); await load(); } }
    catch { setMsg("Could not reach the server"); } finally { setBusy(false); }
  }
  async function extractFile(f: File) {
    setMsg(null);
    const fd = new FormData(); fd.append("file", f); fd.append("documentType", /po|purchase/i.test(f.name) ? "PO" : /bid/i.test(f.name) ? "BID_LIST" : /contract/i.test(f.name) ? "CONTRACT_TABLE" : "INVOICE");
    try { const r = await fetch("/api/documents/extract", { method: "POST", body: fd }); const j = await r.json().catch(() => ({})); if (!r.ok) { setMsg(j.error ?? `Extraction failed (${r.status})`); return; } window.location.href = `/intelligence/extractions/${j.extractionId}`; }
    catch { setMsg("Could not reach the server"); }
  }
  async function importFile(f: File) {
    setMsg(null);
    const fd = new FormData(); fd.append("file", f);
    try { const r = await fetch("/api/intelligence/import", { method: "POST", body: fd }); const j = await r.json().catch(() => ({})); setMsg(r.ok ? `${j.recorded} observations recorded from ${j.rows} rows${j.skipped?.length ? `; ${j.skipped.length} skipped` : ""}` : j.error ?? `Import failed (${r.status})`); load(); }
    catch { setMsg("Could not reach the server"); }
  }
  const s = data?.summary; const rows = data?.rows ?? data?.recent ?? [];
  return (
    <>
      <PageHeader eyebrow="Competitive intelligence" title="Competitor pricing" description="Append-only, dated observations with provenance. Confidence decays by source half-life; the summary says whether a price is known for this account, a market estimate, or weak." actions={canRecord ? <div className="flex gap-2 flex-wrap"><label className="btn-secondary cursor-pointer">Import .xlsx / .csv<input type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} /></label><label className="btn-ghost cursor-pointer" title="Invoice, PO, bid list or contract table → extraction → review → observations">Extract a document…<input type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.xlsx,.csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) extractFile(f); e.target.value = ""; }} /></label></div> : <span className="text-[12px] text-muted" title={needs("import_competitor_pricing")}>Read-only: importing needs <i>import competitor pricing</i></span>} />
      {err && <div role="alert" className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {msg && <div role="status" className="mb-4 rounded-lg bg-accent-soft text-accent-ink px-4 py-2.5 text-[13px]">{msg}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="flex gap-2 items-center"><input className="input mono !w-64" aria-label="Competitor code" placeholder="Competitor code, e.g. 1190500" value={sku} onChange={(e) => setSku(e.target.value)} /><span className="text-[12px] text-muted">{accountId ? "in the context of the selected account" : "market-wide context"}</span></div>
            {s && <div className="mt-3"><Pill value={s.basis} /> <span className="text-[13px]">{s.explanation}</span><div className="mt-2 grid grid-cols-2 md:grid-cols-5 gap-3 text-[12px]"><div><div className="eyebrow">Reference</div><div className="mono">{fmtMoney(s.reference)}</div></div><div><div className="eyebrow">Confidence</div><div className="mono">{Math.round(s.confidence * 100)}%</div></div><div><div className="eyebrow">Median</div><div className="mono">{fmtMoney(s.median)}</div></div><div><div className="eyebrow">Range</div><div className="mono">{fmtMoney(s.min)} – {fmtMoney(s.max)}</div></div><div><div className="eyebrow">Trend</div><div className="mono">{label(s.trend)}</div></div></div></div>}
          </Card>
          <Card padded={false} title={sku ? `Observations for ${sku}` : "Recent observations"}>
            {rows.length === 0 ? <Empty title="No observations">Record one on the right, or import a sheet.</Empty> : (
              <table className="table !text-[12.5px]"><thead><tr><th>Competitor</th><th>Code</th><th className="text-right">Price</th><th>Observed</th><th>Where</th><th>Source</th><th>Now</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{rows.map((o) => { const w = s?.observations.find((x) => x.id === o.id); return <tr key={o.id}><td>{o.competitor.name}</td><td className="mono">{o.competitorSku}</td><td className="mono text-right">{fmtMoney(o.price, o.currency)}</td><td className="mono">{o.observedAt.slice(0, 10)}</td><td className="text-muted">{o.account?.name ?? o.gpo?.name ?? "market"}</td><td className="text-muted">{label(o.sourceType)}{o.sourceRef ? ` · ${o.sourceRef}` : ""}{o.document ? ` · ${o.document.filename}` : ""}</td><td className="mono">{w ? `${Math.round(w.currentConfidence * 100)}% · ${w.relation.toLowerCase()}` : `${Math.round(o.rawConfidence * 100)}% raw`}</td><td><Pill value={o.verificationStatus} /></td><td className="whitespace-nowrap">{canVerify ? <>{o.verificationStatus !== "VERIFIED" && <button type="button" className="btn-ghost !py-0.5 !text-[11px]" disabled={busy} onClick={() => verify(o.id, "VERIFIED")}>Verify</button>}{o.verificationStatus !== "DISPUTED" && <button type="button" className="btn-ghost !py-0.5 !text-[11px]" disabled={busy} onClick={() => verify(o.id, "DISPUTED")}>Dispute</button>}</> : null}</td></tr>; })}</tbody>
              </table>
            )}
          </Card>
          {!sku && data?.bySku && <Card padded={false} title="Coverage by competitor code"><table className="table !text-[12.5px]"><thead><tr><th>Competitor</th><th>Code</th><th className="text-right">Obs.</th><th>Latest</th><th className="text-right">Min</th><th className="text-right">Avg</th></tr></thead><tbody>{data.bySku.map((b) => <tr key={b.competitorSku + b.competitor}><td>{b.competitor}</td><td className="mono"><button type="button" className="text-accent" onClick={() => setSku(b.competitorSku)}>{b.competitorSku}</button></td><td className="mono text-right">{b._count._all}</td><td className="mono">{b._max.observedAt?.slice(0, 10)}</td><td className="mono text-right">{fmtMoney(b._min.price)}</td><td className="mono text-right">{fmtMoney(b._avg.price)}</td></tr>)}</tbody></table></Card>}
        </div>
        <Card title="Record an observation" subtitle="Provenance is mandatory — say where the price came from">
          {canRecord ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); record(); }}>
            <input className="input" aria-label="Competitor" placeholder="Competitor (e.g. BD - Bard)" value={form.competitorName} onChange={(e) => setForm({ ...form, competitorName: e.target.value })} />
            <input className="input mono" aria-label="Competitor code" placeholder="Competitor code" value={form.competitorSku} onChange={(e) => setForm({ ...form, competitorSku: e.target.value })} />
            <input className="input mono" aria-label="Price (USD)" placeholder="Price (USD)" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            <select className="input" aria-label="Source type" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>{(data?.sourceTypes ?? ["CUSTOMER_INVOICE", "CUSTOMER_PO", "CUSTOMER_BID_FILE", "GPO_CONTRACT_FILE", "WIN_LOSS_RECORD", "INTERNAL_VERIFIED", "REP_OBSERVED", "ANECDOTAL"]).map((t) => <option key={t} value={t}>{label(t)}</option>)}</select>
            <input className="input" aria-label="Account number or name (optional)" placeholder="Account number or name (optional)" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
            <input className="input" aria-label="Observed on" type="date" value={form.observedAt} onChange={(e) => setForm({ ...form, observedAt: e.target.value })} />
            <input className="input" aria-label="Source reference" placeholder="Source reference (invoice #, file name…)" value={form.sourceRef} onChange={(e) => setForm({ ...form, sourceRef: e.target.value })} />
            <input className="input" aria-label="Notes" placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <button type="submit" className="btn-primary w-full justify-center" disabled={busy || !form.competitorName || !form.competitorSku || !form.price}>{busy ? "Recording…" : "Record"}</button>
          </form>
          ) : <div className="text-[12.5px] text-muted">Recording an observation needs the <i>import competitor pricing</i> permission.</div>}
        </Card>
      </div>
    </>
  );
}

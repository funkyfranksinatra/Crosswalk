"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, Empty } from "@/components/ui";
import { Pill, fmtMoney, fmtPct, label } from "@/components/commercial";
import { needs, usePermissions } from "@/components/permissions";

type Contract = { id: string; contractNumber: string; name: string; type: string; status: string; tier: string | null; currency: string; effectiveFrom: string; effectiveTo: string | null; precedence: number; committedValue: string | null; notes: string | null; sourceSystem: string; account: { id: string; name: string } | null; gpo: { name: string } | null; renewal: Record<string, unknown> | null; priceProtection: Record<string, unknown> | null; escalation: Record<string, unknown> | null; scopes: { id: string; productFamily: string | null; productId: string | null }[]; entries: { id: string; price: string; currency: string; effectiveFrom: string; effectiveTo: string | null; minQty: string | null; maxQty: string | null; volumeTierName: string | null; status: string; product: { sku: string; description: string; category: string | null } }[]; commitments: { id: string; productFamily: string | null; committedUnits: string | null; committedValue: string | null; periodStart: string; periodEnd: string }[]; rebates: { id: string; type: string; basis: string; productFamily: string | null; tiersJson: string; periodMonths: number }[]; bundles: { id: string; name: string; description: string | null; conditionJson: string; benefitJson: string }[]; proposals: { id: string; reference: string; status: string }[]; performance: { asOf: string; commitments: { commitmentId: string; productFamily: string | null; committedUnits: string | null; committedValue: string | null; actualUnits: string; actualValue: string; unitsPct: string | null; valuePct: string | null; elapsedPct: string; status: string }[]; rebates: { rebateId: string; measured: string; rebate: string; net: string; toNext: string | null }[]; flags: string[]; totalActualValue: string } | null };

export function ContractView({ id }: { id: string }) {
  const { can } = usePermissions();
  const canManage = can("manage_contracts");
  const canEditPricing = can("edit_contract_pricing");
  const [c, setC] = useState<Contract | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entriesText, setEntriesText] = useState("");
  const [term, setTerm] = useState<"commitment" | "rebate" | null>(null);
  const [tf, setTf] = useState({ productFamily: "", committedValue: "", committedUnits: "", periodStart: new Date().toISOString().slice(0, 10), periodEnd: "" });
  const [rf, setRf] = useState({ type: "VOLUME", basis: "VALUE", productFamily: "", periodMonths: "12", tiers: "" });
  const load = useCallback(async () => {
    try { const r = await fetch(`/api/contracts/${id}`, { cache: "no-store" }); const j = await r.json().catch(() => ({})); if (!r.ok) setErr(j.error ?? `Could not load the contract (${r.status})`); else { setC(j); setErr(null); } }
    catch { setErr("Could not reach the server"); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  async function post(path: string, body: unknown, method = "POST") {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.error ?? `Request failed (${r.status})`); else { setErr(null); await load(); }
      return j;
    } catch { setErr("Could not reach the server"); return null; } finally { setBusy(false); }
  }
  if (err && !c) return <Empty title="Contract not available">{err}</Empty>;
  if (!c) return <div className="shimmer h-40 rounded-xl" />;
  const perf = c.performance;
  const closed = c.status === "TERMINATED" || c.status === "SUPERSEDED";
  return (
    <>
      <PageHeader eyebrow={`Contract · ${c.type}${c.tier ? ` · ${c.tier}` : ""}`} title={<span className="mono">{c.contractNumber} <span className="font-normal text-[16px] text-muted">· {c.name}</span></span>}
        description={<span>{c.account ? <Link className="text-accent" href={`/accounts/${c.account.id}`}>{c.account.name}</Link> : c.gpo ? `GPO ${c.gpo.name}` : "All accounts"} · {c.effectiveFrom.slice(0, 10)} → {c.effectiveTo?.slice(0, 10) ?? "open"} · {c.currency} · source {c.sourceSystem}{c.precedence ? ` · precedence ${c.precedence}` : ""}</span>}
        actions={<div className="flex gap-2 flex-wrap"><Pill value={c.status} /><button type="button" className="btn-secondary" disabled={busy} onClick={() => post(`/api/contracts/${id}/performance`, undefined, "GET")}>Refresh performance</button>{c.status === "ACTIVE" && canManage && <button type="button" className="btn-ghost" disabled={busy} onClick={() => { if (window.confirm(`Terminate ${c.contractNumber}? A terminated contract can never be reactivated.`)) post(`/api/contracts/${id}`, { status: "TERMINATED" }, "PATCH"); }}>Terminate</button>}{c.status === "DRAFT" && canManage && <button type="button" className="btn-primary" disabled={busy} onClick={() => post(`/api/contracts/${id}`, { status: "ACTIVE" }, "PATCH")}>Activate</button>}{(c.status === "ACTIVE" || c.status === "DRAFT") && !canManage && <span className="text-[11.5px] text-muted self-center" title={needs("manage_contracts")}>Status changes need <i>manage contracts</i></span>}</div>} />
      {err && <div role="alert" className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {perf?.flags.length ? <div className="mb-4 rounded-lg bg-alt-soft text-alt px-4 py-2.5 text-[13px]">{perf.flags.join(" · ")}</div> : null}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4 [&>*]:min-w-0">
        <Card title="Clauses" subtitle="Structured, validated — the engine can reason about them">
          <div className="text-[12.5px] space-y-1.5">
            <div><span className="eyebrow">Renewal</span> {c.renewal ? `${label(String(c.renewal.kind))}${c.renewal.termMonths ? ` · ${c.renewal.termMonths} mo` : ""}${c.renewal.noticeDays ? ` · ${c.renewal.noticeDays}d notice` : ""}${c.renewal.increasePct ? ` · +${fmtPct(c.renewal.increasePct as number)} at renewal` : ""}` : <span className="text-muted">none</span>}</div>
            <div><span className="eyebrow">Price protection</span> {c.priceProtection ? `${label(String(c.priceProtection.kind))}${c.priceProtection.maxAnnualPct ? ` · max ${fmtPct(c.priceProtection.maxAnnualPct as number)}/yr` : ""}${c.priceProtection.years ? ` · ${c.priceProtection.years} yrs` : ""}` : <span className="text-muted">none</span>}</div>
            <div><span className="eyebrow">Escalation</span> {c.escalation ? `${label(String(c.escalation.kind))}${c.escalation.annualPct ? ` · ${fmtPct(c.escalation.annualPct as number)}/yr` : ""}` : <span className="text-muted">none</span>}</div>
            <div><span className="eyebrow">Scope</span> {c.scopes.length ? c.scopes.map((s) => s.productFamily ?? s.productId).join(", ") : "whole catalog"}</div>
            {c.notes && <div className="text-muted">{c.notes}</div>}
          </div>
        </Card>
        <Card title="Commitments" subtitle={perf ? `Performance as of ${perf.asOf.slice(0, 10)}` : "No performance snapshot yet"} actions={canManage && !closed ? <button type="button" className="btn-ghost !py-0.5 !text-[11px]" aria-expanded={term === "commitment"} onClick={() => setTerm(term === "commitment" ? null : "commitment")}>{term === "commitment" ? "Close" : "Add commitment"}</button> : undefined}>
          {term === "commitment" && (
            <form className="mb-3 grid grid-cols-2 gap-2 text-[12px]" onSubmit={(e) => { e.preventDefault(); post(`/api/contracts/${id}/terms`, { kind: "commitment", data: { productFamily: tf.productFamily || null, committedValue: tf.committedValue || null, committedUnits: tf.committedUnits || null, periodStart: tf.periodStart || null, periodEnd: tf.periodEnd || null } }).then((j) => { if (j && !j.error) setTerm(null); }); }}>
              <label className="label">Product family (blank = whole contract)<input className="input font-normal" value={tf.productFamily} onChange={(e) => setTf({ ...tf, productFamily: e.target.value })} /></label>
              <label className="label">Committed value<input className="input mono font-normal" inputMode="decimal" value={tf.committedValue} onChange={(e) => setTf({ ...tf, committedValue: e.target.value })} /></label>
              <label className="label">…or committed units<input className="input mono font-normal" inputMode="numeric" value={tf.committedUnits} onChange={(e) => setTf({ ...tf, committedUnits: e.target.value })} /></label>
              <div className="grid grid-cols-2 gap-2"><label className="label">Period start<input className="input font-normal" type="date" value={tf.periodStart} onChange={(e) => setTf({ ...tf, periodStart: e.target.value })} /></label><label className="label">Period end<input className="input font-normal" type="date" value={tf.periodEnd} onChange={(e) => setTf({ ...tf, periodEnd: e.target.value })} /></label></div>
              <div className="col-span-2 flex justify-end"><button type="submit" className="btn-primary !py-1 !text-[12px]" disabled={busy || (!tf.committedValue && !tf.committedUnits)} title={!tf.committedValue && !tf.committedUnits ? "Enter a committed value or units" : undefined}>Save commitment</button></div>
            </form>
          )}
          {c.commitments.length === 0 ? <div className="text-muted text-[13px]">No commitments.</div> : <table className="table !text-[12px]"><thead><tr><th>Scope</th><th>Committed</th><th>Actual</th><th>Status</th>{canManage && <th><span className="sr-only">Actions</span></th>}</tr></thead><tbody>{c.commitments.map((k) => { const s = perf?.commitments.find((x) => x.commitmentId === k.id); return <tr key={k.id}><td>{k.productFamily ?? "contract"}<div className="text-muted">{k.periodStart.slice(0, 10)} → {k.periodEnd.slice(0, 10)}</div></td><td className="mono">{k.committedValue ? fmtMoney(k.committedValue, c.currency, { compact: true }) : `${Number(k.committedUnits).toLocaleString()} u`}</td><td className="mono">{s ? (k.committedValue ? fmtMoney(s.actualValue, c.currency, { compact: true }) : `${Number(s.actualUnits).toLocaleString()} u`) : "—"}{s && (s.valuePct ?? s.unitsPct) ? <div className="text-muted">{fmtPct(s.valuePct ?? s.unitsPct, 0)} · {fmtPct(s.elapsedPct, 0)} elapsed</div> : null}</td><td>{s ? <Pill value={s.status} /> : "—"}</td>{canManage && <td className="text-right"><button type="button" className="text-none text-[11px]" disabled={busy || closed} aria-label={`Remove commitment ${k.productFamily ?? "contract"}`} onClick={() => { if (window.confirm("Remove this commitment?")) post(`/api/contracts/${id}/terms`, { kind: "commitment", termId: k.id }, "DELETE"); }}>remove</button></td>}</tr>; })}</tbody></table>}
        </Card>
        <Card title="Rebates & bundles" subtitle="Invoice price stays; effective net is computed" actions={canManage && !closed ? <button type="button" className="btn-ghost !py-0.5 !text-[11px]" aria-expanded={term === "rebate"} onClick={() => setTerm(term === "rebate" ? null : "rebate")}>{term === "rebate" ? "Close" : "Add rebate"}</button> : undefined}>
          {term === "rebate" && (
            <form className="mb-3 grid grid-cols-2 gap-2 text-[12px]" onSubmit={(e) => { e.preventDefault(); const tiers = rf.tiers.split(/\n|;/).map((l) => l.split(",").map((x) => x.trim())).filter((x) => x[0]).map(([threshold, pct]) => ({ threshold: Number(threshold), rebatePct: Number(pct) })); post(`/api/contracts/${id}/terms`, { kind: "rebate", data: { type: rf.type, basis: rf.basis, productFamily: rf.productFamily || null, periodMonths: Number(rf.periodMonths) || 12, tiers } }).then((j) => { if (j && !j.error) setTerm(null); }); }}>
              <label className="label">Type<select className="input font-normal" value={rf.type} onChange={(e) => setRf({ ...rf, type: e.target.value })}>{["VOLUME", "GROWTH", "COMPLIANCE", "FAMILY", "BUNDLE"].map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="label">Basis<select className="input font-normal" value={rf.basis} onChange={(e) => setRf({ ...rf, basis: e.target.value })}>{["VALUE", "UNITS", "COMPLIANCE_PCT", "GROWTH_PCT"].map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="label">Product family (optional)<input className="input font-normal" value={rf.productFamily} onChange={(e) => setRf({ ...rf, productFamily: e.target.value })} /></label>
              <label className="label">Period (months)<input className="input mono font-normal" inputMode="numeric" value={rf.periodMonths} onChange={(e) => setRf({ ...rf, periodMonths: e.target.value })} /></label>
              <label className="label col-span-2">Tiers, one per line: <span className="mono">threshold, rebate fraction</span> (e.g. <span className="mono">100000, 0.02</span>)<textarea className="input mono font-normal h-16" value={rf.tiers} onChange={(e) => setRf({ ...rf, tiers: e.target.value })} /></label>
              <div className="col-span-2 flex justify-end"><button type="submit" className="btn-primary !py-1 !text-[12px]" disabled={busy || !rf.tiers.trim()}>Save rebate</button></div>
            </form>
          )}
          {c.rebates.length === 0 && c.bundles.length === 0 ? <div className="text-muted text-[13px]">None.</div> : <div className="text-[12.5px] space-y-2">
            {c.rebates.map((r) => { const s = perf?.rebates.find((x) => x.rebateId === r.id); return <div key={r.id}><b>{label(r.type)} rebate</b> on {r.basis.toLowerCase()}{r.productFamily ? ` · ${r.productFamily}` : ""}: {JSON.parse(r.tiersJson).map((t: { threshold: number; rebatePct?: number; rebateAmount?: number }) => `${t.threshold.toLocaleString()} → ${t.rebatePct != null ? fmtPct(t.rebatePct) : fmtMoney(t.rebateAmount, c.currency)}`).join(", ")}{canManage && <button type="button" className="text-none text-[11px] ml-2" disabled={busy || closed} aria-label={`Remove ${label(r.type)} rebate`} onClick={() => { if (window.confirm("Remove this rebate?")) post(`/api/contracts/${id}/terms`, { kind: "rebate", termId: r.id }, "DELETE"); }}>remove</button>}{s ? <div className="text-muted">measured {Number(s.measured).toLocaleString()} · rebate {fmtMoney(s.rebate, c.currency)} · net {fmtMoney(s.net, c.currency, { compact: true })}{s.toNext ? ` · ${Number(s.toNext).toLocaleString()} to next tier` : ""}</div> : null}</div>; })}
            {c.bundles.map((b) => <div key={b.id}><b>{b.name}</b><div className="text-muted">{b.description ?? `${b.conditionJson} → ${b.benefitJson}`}</div></div>)}
          </div>}
        </Card>
      </div>
      <Card title="Price entries" subtitle="Effective-dated; replacing an entry supersedes the old one (history is kept)" padded={false} actions={<span className="text-[12px] text-muted">{c.entries.length} entries</span>}>
        <table className="table !text-[12.5px]"><thead><tr><th>SKU</th><th>Family</th><th className="text-right">Price</th><th>Band</th><th>Effective</th><th>Status</th></tr></thead>
          <tbody>{c.entries.map((e) => <tr key={e.id} className={e.status !== "ACTIVE" ? "bg-panel-2 [&>td]:text-muted" : ""}><td className="mono">{e.product.sku}<div className="text-muted font-sans truncate max-w-[300px]">{e.product.description}</div></td><td className="text-muted">{e.product.category}</td><td className="mono text-right">{fmtMoney(e.price, e.currency)}</td><td className="mono text-muted">{e.volumeTierName ?? (e.minQty ? `${e.minQty}–${e.maxQty ?? "∞"}` : "any")}</td><td className="mono text-muted">{e.effectiveFrom.slice(0, 10)} → {e.effectiveTo?.slice(0, 10) ?? "open"}</td><td><Pill value={e.status} /></td></tr>)}</tbody>
        </table>
        <div className="p-4 border-t border-line-2">
          <div className="eyebrow mb-1">Add / replace entries</div>
          <p className="text-[12px] text-muted mb-2">One per line: <span className="mono">SKU, price[, minQty, maxQty, tier name]</span>. Requires <i>edit contract pricing</i>{!canEditPricing ? " — your role does not hold it" : c.status === "TERMINATED" || c.status === "SUPERSEDED" ? ` — not possible on a ${c.status.toLowerCase()} contract` : ""}.</p>
          <textarea className="input mono h-20" aria-label="Price entries, one per line" disabled={!canEditPricing || c.status === "TERMINATED" || c.status === "SUPERSEDED"} placeholder={"PPM1510X3, 72.50\nEGIA60AMT, 932.10, 0, 999, 0–999"} value={entriesText} onChange={(e) => setEntriesText(e.target.value)} />
          <div className="flex justify-end mt-2"><button type="button" className="btn-primary" disabled={!entriesText.trim() || busy || !canEditPricing || c.status === "TERMINATED" || c.status === "SUPERSEDED"} title={!canEditPricing ? needs("edit_contract_pricing") : c.status === "TERMINATED" || c.status === "SUPERSEDED" ? `Entries cannot be added to a ${c.status.toLowerCase()} contract` : undefined} onClick={async () => { const entries = entriesText.split("\n").map((l) => l.split(",").map((x) => x.trim())).filter((x) => x[0] && x[1]).map(([sku, price, minQty, maxQty, volumeTierName]) => ({ sku, price, minQty: minQty || undefined, maxQty: maxQty || undefined, volumeTierName: volumeTierName || undefined })); const j = await post(`/api/contracts/${id}/entries`, { entries }); if (j && !j.error) setEntriesText(""); }}>Save entries</button></div>
        </div>
      </Card>
      {c.proposals.length > 0 && <div className="mt-4 text-[12.5px] text-muted">Proposals referencing this contract: {c.proposals.map((p) => <Link key={p.id} className="text-accent mono mr-2" href={`/proposals/${p.id}`}>{p.reference}</Link>)}</div>}
    </>
  );
}

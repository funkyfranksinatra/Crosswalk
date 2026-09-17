"use client";

/**
 * Proposal workspace — the contracting/pricing surface.
 * Sticky deal summary · line table with inline proposed-price editing · line drawer
 * (cross evidence, competitor prices, waterfall, cost basis, recommendation, approvals)
 * · scenarios · submit / approve / export / outcome.
 * No money arithmetic happens here: every figure comes from the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, Empty } from "@/components/ui";
import { DriftBanner } from "./drift-banner";
import { Pill, ProposalStatus, fmtMoney, fmtPct, label } from "@/components/commercial";

type Line = {
  id: string; lineNo: number; included: boolean; competitorCode: string; competitorDescription: string | null; competitorName: string | null; sku: string | null; description: string | null; productFamily: string | null;
  equivalenceLevel: string | null; matchType: string | null; crossId: string | null; quantity: number; listPrice: number | null; contractPrice: number | null; contractPriceSource: string | null; waterfallJson: string | null;
  competitorPrice: number | null; competitorPriceConfidence: number | null; competitorPriceBasis: string | null; competitorIntelJson: string | null; cost: number | null; costBasisJson: string | null;
  floorPrice: number | null; targetPrice: number | null; ceilingPrice: number | null; recommendedPrice: number | null; recommendationJson: string | null; proposedPrice: number | null;
  marginAmount: number | null; marginPct: number | null; discountFromListPct: number | null; discountFromContractPct: number | null; requiredAuthority: string | null; approvalState: string; justification: string | null; notes: string | null;
};
type Econ = { revenue: string; listValue: string; currentContractValue: string; competitorSpend: string; customerSavings: string; customerSavingsPct: string | null; grossProfit: string | null; blendedMarginPct: string | null; discountFromListPct: string | null; discountFromContractPct: string | null; shareOfWalletPct: string | null; linesProposed: number; linesTotal: number; approvalsPending: number; approvalsRequired: number; byFamily: { family: string; lines: number; revenue: string; grossProfit: string | null; marginPct: string | null; competitorSpend: string; customerSavings: string }[] };
type Approval = { id: string; proposalLineId: string | null; requiredRole: string; reason: string; status: string; requestedAt: string; decidedAt: string | null; decisionComments: string | null };
type Proposal = {
  id: string; reference: string; version: number; status: string; currency: string; validThrough: string | null; lockedAt: string | null; gpoNameSnapshot: string | null; objectivesJson: string | null;
  account: { id: string; name: string; accountNumber: string | null; isStrategic: boolean; parent: { name: string } | null }; contract: { contractNumber: string; name: string } | null; crosswalkVersion: { number: number } | null; request: { id: string; reference: string } | null;
  lines: Line[]; scenarios: { id: string; name: string; kind: string }[]; approvals: Approval[]; outcome: { outcome: string; priceReason: string | null; commercialReason: string | null } | null; economics: Econ | null;
  finalize: { ok: boolean; reason: string }; permissions: { editPricing: boolean; viewCost: boolean; viewMargin: boolean; approve: boolean; export: boolean; outcomes: boolean }; integrations: { crm: { note: string } };
};
type ScenarioView = { scenario: { id: string; name: string; kind: string }; economics: Econ; lines: { id: string; proposedPrice: string | null; marginPct: string | null; discountFromListPct: string | null; requiredAuthority: string | null; belowFloor: boolean }[] };

export function ProposalWorkspace({ id }: { id: string }) {
  const [p, setP] = useState<Proposal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [scenario, setScenario] = useState<ScenarioView | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioView[]>([]);
  const [showExcluded, setShowExcluded] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proposals/${id}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "Failed to load"); return; }
    setP(j); setErr(null);
    const s = await fetch(`/api/proposals/${id}/scenarios`, { cache: "no-store" }).then((x) => x.json());
    if (Array.isArray(s)) { setScenarios(s); setScenario((cur) => (cur ? s.find((x: ScenarioView) => x.scenario.id === cur.scenario.id) ?? null : null)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function call(path: string, init?: RequestInit) {
    setBusy(true);
    try {
      const r = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
      const j = await r.json().catch(() => ({}));
      // On a refusal (locked by someone else, request voided, conflict) reload too, so the screen
      // shows the state the server actually has rather than the one the user was editing.
      if (!r.ok) { setErr(j.error ?? "Request failed"); await load(); return null; }
      setErr(null); await load(); return j;
    } finally { setBusy(false); }
  }

  const editable = Boolean(p && p.permissions.editPricing && ["DRAFT", "CHANGES_REQUESTED"].includes(p.status) && !p.lockedAt);
  const lines = useMemo(() => (p ? p.lines.filter((l) => showExcluded || l.included) : []), [p, showExcluded]);
  const econ = scenario ? scenario.economics : p?.economics ?? null;
  const scenarioLine = (lineId: string) => scenario?.lines.find((l) => l.id === lineId);

  if (err && !p) return <Empty title="Could not open proposal">{err}</Empty>;
  if (!p) return <div className="shimmer h-40 rounded-xl" />;

  return (
    <>
      <PageHeader
        eyebrow={<span>Proposal · v{p.version}{p.request ? <> · from <Link className="text-accent" href={`/requests/${p.request.id}`}>{p.request.reference}</Link></> : null}</span>}
        title={<span className="mono">{p.reference} <span className="text-muted font-normal text-[16px]">· {p.account.name}</span></span>}
        description={<span>{p.account.parent ? `${p.account.parent.name} · ` : ""}{p.gpoNameSnapshot ?? "No GPO"}{p.contract ? ` · local contract ${p.contract.contractNumber}` : ""} · crosswalk v{p.crosswalkVersion?.number ?? "—"} · valid through {p.validThrough?.slice(0, 10) ?? "—"}{p.account.isStrategic ? " · strategic account" : ""}</span>}
        actions={<Actions p={p} busy={busy} editable={editable} call={call} />}
      />
      {err && <div className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {!["WON", "LOST"].includes(p.status) && <DriftBanner proposalId={id} canEdit={p.permissions.editPricing} onRefreshed={load} />}
      {p.outcome && <div className={`mb-4 rounded-lg px-4 py-2.5 text-[13px] ${p.outcome.outcome === "WON" ? "bg-exact-soft text-exact" : "bg-none-soft text-none"}`}>Deal {p.outcome.outcome.toLowerCase()}{p.outcome.priceReason ? ` — ${p.outcome.priceReason}` : ""}{p.outcome.commercialReason ? ` · ${p.outcome.commercialReason}` : ""}</div>}

      {/* Sticky deal summary */}
      <div className="sticky top-0 z-10 -mx-2 px-2 pb-3 pt-1 bg-paper/95 backdrop-blur">
        <div className="grid grid-cols-6 gap-3">
          <Kpi label="Contract value" value={fmtMoney(econ?.revenue, p.currency, { compact: true })} hint={`${econ?.linesProposed ?? 0} of ${econ?.linesTotal ?? 0} lines priced`} />
          <Kpi label="Customer savings" value={fmtMoney(econ?.customerSavings, p.currency, { compact: true })} hint={econ?.customerSavingsPct ? `${fmtPct(econ.customerSavingsPct)} vs competitor` : "vs competitor spend"} tone={Number(econ?.customerSavings) < 0 ? "none" : "exact"} />
          <Kpi label="Gross profit" value={p.permissions.viewMargin ? fmtMoney(econ?.grossProfit, p.currency, { compact: true }) : "•••"} hint={p.permissions.viewMargin ? `${fmtPct(econ?.discountFromListPct)} off list` : "restricted"} />
          <Kpi label="Blended margin" value={p.permissions.viewMargin ? fmtPct(econ?.blendedMarginPct) : "•••"} hint={p.permissions.viewMargin && econ?.discountFromContractPct ? `${fmtPct(econ.discountFromContractPct)} below current contract` : ""} tone={Number(econ?.blendedMarginPct) < 0.3 ? "alt" : "exact"} />
          <Kpi label="Share of wallet" value={fmtPct(econ?.shareOfWalletPct, 0)} hint={`competitor spend ${fmtMoney(econ?.competitorSpend, p.currency, { compact: true })}`} />
          <Kpi label="Approvals" value={<ProposalStatus status={p.status} />} hint={econ ? `${econ.approvalsPending} pending · ${econ.approvalsRequired} required` : ""} />
        </div>
        {scenario && <div className="mt-2 text-[12px] text-info">Viewing scenario <b>{scenario.scenario.name}</b> — the proposal&apos;s own prices are unchanged. <button className="underline" onClick={() => setScenario(null)}>Back to proposal</button></div>}
      </div>

      {/* Scenarios + view toggles */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="eyebrow">Scenarios</span>
        <button className={`chip ${!scenario ? "bg-accent-soft text-accent-ink" : "bg-line-2 text-muted"}`} onClick={() => setScenario(null)}>Proposal</button>
        {scenarios.map((s) => <button key={s.scenario.id} className={`chip ${scenario?.scenario.id === s.scenario.id ? "bg-accent-soft text-accent-ink" : "bg-line-2 text-muted"}`} onClick={() => setScenario(s)}>{s.scenario.name}</button>)}
        {p.permissions.editPricing && (
          <select className="input !w-auto !py-1 !text-[12px]" value="" onChange={(e) => { if (e.target.value) call(`/api/proposals/${id}/scenarios`, { method: "POST", body: JSON.stringify({ kind: e.target.value }) }); }}>
            <option value="">+ New scenario…</option>
            <option value="RECOMMENDED">Recommended</option><option value="AGGRESSIVE">Aggressive</option><option value="MARGIN_OPTIMIZED">Margin optimized</option><option value="CUSTOMER_REQUESTED">Customer requested</option><option value="CUSTOM">Custom</option>
          </select>
        )}
        {scenario && editable && <button className="btn-secondary !py-1 !text-[12px]" disabled={busy} onClick={() => call(`/api/proposals/${id}/scenarios/${scenario.scenario.id}/apply`, { method: "POST" }).then(() => setScenario(null))}>Apply scenario to proposal</button>}
        {scenario && p.permissions.editPricing && <button className="btn-ghost !py-1 !text-[12px]" onClick={() => call(`/api/proposals/${id}/scenarios/${scenario.scenario.id}`, { method: "DELETE" }).then(() => setScenario(null))}>Delete</button>}
        <label className="ml-auto text-[12px] text-muted flex items-center gap-1.5"><input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} /> show excluded</label>
        <button className="btn-ghost !py-1 !text-[12px]" onClick={() => setShowAudit((v) => !v)}>{showAudit ? "Hide" : "Show"} audit trail</button>
      </div>

      {econ && econ.byFamily.length > 0 && (
        <div className="flex gap-2 mb-3 flex-wrap">
          {econ.byFamily.map((f) => <span key={f.family} className="chip bg-panel border border-line text-[11.5px]"><b>{f.family}</b> · {fmtMoney(f.revenue, p.currency, { compact: true })}{p.permissions.viewMargin && f.marginPct ? ` · ${fmtPct(f.marginPct)} margin` : ""} · saves {fmtMoney(f.customerSavings, p.currency, { compact: true })}</span>)}
        </div>
      )}

      <Card padded={false}>
        <table className="table">
          <thead>
            <tr>
              <th>Competitor item</th><th>Cross</th><th className="text-right">Qty</th><th className="text-right">Competitor</th><th className="text-right">Current</th><th className="text-right">Recommended</th><th className="text-right">Proposed</th>
              {p.permissions.viewCost && <th className="text-right">Floor</th>}{p.permissions.viewMargin && <th className="text-right">Margin</th>}<th>Approval</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const sl = scenarioLine(l.id);
              const proposed = scenario ? (sl?.proposedPrice ?? null) : l.proposedPrice;
              const margin = scenario ? sl?.marginPct ?? null : l.marginPct;
              const auth = scenario ? sl?.requiredAuthority ?? null : l.requiredAuthority;
              const belowFloor = l.floorPrice != null && proposed != null && Number(proposed) < Number(l.floorPrice);
              return (
                <LineRow key={l.id} l={l} p={p} proposed={proposed} margin={margin} auth={auth} belowFloor={belowFloor} editable={scenario ? p.permissions.editPricing : editable} isOpen={open === l.id} onOpen={() => setOpen(open === l.id ? null : l.id)}
                  onPrice={(v) => scenario ? call(`/api/proposals/${id}/scenarios/${scenario.scenario.id}`, { method: "PATCH", body: JSON.stringify({ lineId: l.id, proposedPrice: v }) }) : call(`/api/proposals/${id}/lines/${l.id}`, { method: "PATCH", body: JSON.stringify({ proposedPrice: v, reason: "edited in workspace" }) })}
                  onInclude={(v) => call(`/api/proposals/${id}/lines/${l.id}`, { method: "PATCH", body: JSON.stringify({ included: v }) })}
                  onRecommend={(strategy, adj, just) => call(`/api/proposals/${id}/lines/${l.id}/recommend`, { method: "POST", body: JSON.stringify({ strategy, adjustmentPct: adj, justification: just, apply: true }) })}
                  approvals={p.approvals.filter((a) => a.proposalLineId === l.id)} />
              );
            })}
          </tbody>
        </table>
      </Card>
      {showAudit && <AuditTrail id={id} />}
    </>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "exact" | "alt" | "none" }) {
  const color = tone === "exact" ? "text-exact" : tone === "alt" ? "text-alt" : tone === "none" ? "text-none" : "text-ink";
  return <div className="card px-4 py-3"><div className="eyebrow">{label}</div><div className={`mono text-[20px] font-semibold tracking-tight mt-0.5 ${color}`}>{value}</div>{hint && <div className="text-[11.5px] text-muted mt-0.5 truncate">{hint}</div>}</div>;
}

function Actions({ p, busy, editable, call }: { p: Proposal; busy: boolean; editable: boolean; call: (path: string, init?: RequestInit) => Promise<unknown> }) {
  const [outcome, setOutcome] = useState(false);
  const id = p.id;
  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {editable && <button className="btn-primary" disabled={busy} onClick={() => call(`/api/proposals/${id}/submit`, { method: "POST", body: JSON.stringify({}) })}>Submit for approval</button>}
      {!editable && p.permissions.editPricing && !["WON", "LOST"].includes(p.status) && <button className="btn-secondary" disabled={busy} onClick={() => call(`/api/proposals/${id}/reopen`, { method: "POST", body: JSON.stringify({ reason: "reopened from workspace" }) })}>Reopen</button>}
      {p.permissions.export && (
        <a className={`btn-secondary ${p.finalize.ok ? "" : "opacity-50 pointer-events-none"}`} href={`/api/proposals/${id}/export?format=xlsx`} title={p.finalize.ok ? "Download the approved quote" : `Locked: ${p.finalize.reason}`}>Export quote</a>
      )}
      {p.permissions.export && p.finalize.ok && <button className="btn-secondary" disabled={busy} onClick={() => call(`/api/proposals/${id}/push-crm`, { method: "POST" })} title={p.integrations.crm.note}>Push to CRM</button>}
      {p.permissions.outcomes && p.finalize.ok && !p.outcome && <button className="btn-secondary" onClick={() => setOutcome(true)}>Record outcome</button>}
      {p.permissions.editPricing && ["WON", "LOST", "APPROVED", "REJECTED"].includes(p.status) && <button className="btn-ghost" disabled={busy} onClick={() => call(`/api/proposals/${id}/version`, { method: "POST" }).then((r) => { const v = r as { id?: string } | null; if (v?.id) window.location.href = `/proposals/${v.id}`; })}>New version</button>}
      {!p.finalize.ok && <span className="text-[11.5px] text-muted max-w-[260px] text-right">{p.finalize.reason}</span>}
      {outcome && <OutcomeDialog p={p} onClose={() => setOutcome(false)} call={call} />}
    </div>
  );
}

function OutcomeDialog({ p, onClose, call }: { p: Proposal; onClose: () => void; call: (path: string, init?: RequestInit) => Promise<unknown> }) {
  const [form, setForm] = useState({ outcome: "WON", competitorName: "", priceReason: "", commercialReason: "", contractMonths: 12 });
  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-center justify-center" onClick={onClose}>
      <div className="card p-5 w-[460px]" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold mb-1">Record outcome for {p.reference}</div>
        <p className="text-[12.5px] text-muted mb-3">A win turns the approved prices into a local contract with commitments. A loss records the competitor and the reason as pricing intelligence.</p>
        <select className="input mb-2" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}><option value="WON">Won</option><option value="LOST">Lost</option><option value="NO_DECISION">No decision</option></select>
        {form.outcome === "LOST" && <input className="input mb-2" placeholder="Winning competitor" value={form.competitorName} onChange={(e) => setForm({ ...form, competitorName: e.target.value })} />}
        <input className="input mb-2" placeholder="Price reason (e.g. 8% above competitor on mesh)" value={form.priceReason} onChange={(e) => setForm({ ...form, priceReason: e.target.value })} />
        <input className="input mb-2" placeholder="Commercial reason (e.g. incumbent bundle, clinical preference)" value={form.commercialReason} onChange={(e) => setForm({ ...form, commercialReason: e.target.value })} />
        {form.outcome === "WON" && <label className="label">Contract term (months)<input className="input" type="number" value={form.contractMonths} onChange={(e) => setForm({ ...form, contractMonths: Number(e.target.value) })} /></label>}
        <div className="flex justify-end gap-2 mt-3"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={() => call(`/api/proposals/${p.id}/outcome`, { method: "POST", body: JSON.stringify(form) }).then(onClose)}>Save</button></div>
      </div>
    </div>
  );
}

function LineRow({ l, p, proposed, margin, auth, belowFloor, editable, isOpen, onOpen, onPrice, onInclude, onRecommend, approvals }: { l: Line; p: Proposal; proposed: string | number | null; margin: string | number | null; auth: string | null; belowFloor: boolean; editable: boolean; isOpen: boolean; onOpen: () => void; onPrice: (v: string | null) => void; onInclude: (v: boolean) => void; onRecommend: (strategy: string, adj: number | null, just: string | null) => void; approvals: Approval[] }) {
  const [draft, setDraft] = useState(proposed == null ? "" : String(proposed));
  useEffect(() => { setDraft(proposed == null ? "" : String(proposed)); }, [proposed]);
  const commit = () => { const v = draft.trim(); if (v === (proposed == null ? "" : String(proposed))) return; onPrice(v === "" ? null : v); };
  const unapproved = l.sku && l.equivalenceLevel === "NONE";
  return (
    <>
      <tr className={`${!l.included ? "opacity-50" : ""} ${isOpen ? "bg-accent-soft/30" : ""}`}>
        <td onClick={onOpen} className="cursor-pointer"><div className="mono font-medium">{l.competitorCode}</div><div className="text-[11.5px] text-muted truncate max-w-[260px]">{l.competitorName ? `${l.competitorName} · ` : ""}{l.competitorDescription}</div></td>
        <td onClick={onOpen} className="cursor-pointer">{l.sku ? <><div className="mono font-medium">{l.sku}</div><div className="text-[11.5px] truncate max-w-[220px]"><Pill value={unapproved ? "WEAK" : l.equivalenceLevel ?? "NONE"}>{unapproved ? `unapproved · ${l.matchType ?? "?"}` : label(l.equivalenceLevel)}</Pill> <span className="text-muted">{l.productFamily}</span></div></> : <span className="text-muted">no product</span>}</td>
        <td className="mono text-right">{Number(l.quantity).toLocaleString()}</td>
        <td className="mono text-right">{fmtMoney(l.competitorPrice, p.currency)}{l.competitorPriceBasis && l.competitorPriceBasis !== "NONE" && <div className="text-[10.5px]"><Pill value={l.competitorPriceBasis}>{l.competitorPriceBasis === "KNOWN_ACCOUNT" ? "known" : l.competitorPriceBasis === "MARKET_ESTIMATE" ? "market" : "weak"}</Pill></div>}</td>
        <td className="mono text-right">{fmtMoney(l.contractPrice ?? l.listPrice, p.currency)}<div className="text-[10.5px] text-muted">{l.contractPriceSource ?? (l.listPrice != null ? "LIST" : "")}</div></td>
        <td className="mono text-right">{fmtMoney(l.recommendedPrice, p.currency)}</td>
        <td className="text-right">
          {editable ? <input className={`input mono !w-28 text-right !py-1 ${belowFloor ? "!border-none-soft !bg-none-soft/40" : ""}`} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /> : <span className={`mono ${belowFloor ? "text-none" : ""}`}>{fmtMoney(proposed, p.currency)}</span>}
          {l.discountFromContractPct != null && !editable && <div className="text-[10.5px] text-muted">{fmtPct(l.discountFromContractPct)} below current</div>}
        </td>
        {p.permissions.viewCost && <td className={`mono text-right ${belowFloor ? "text-none font-semibold" : ""}`}>{fmtMoney(l.floorPrice, p.currency)}</td>}
        {p.permissions.viewMargin && <td className={`mono text-right ${margin != null && Number(margin) < 0.3 ? "text-alt" : ""}`}>{fmtPct(margin)}</td>}
        <td>
          {!l.included ? <Pill value="NOT_REQUIRED">excluded</Pill> : auth ? <Pill value={l.approvalState === "APPROVED" ? "APPROVED" : l.approvalState === "PENDING" ? "PENDING" : l.approvalState === "REJECTED" ? "REJECTED" : "REQUIRED"}>{l.approvalState === "APPROVED" ? "approved" : `${label(auth)}${l.approvalState === "PENDING" ? " · pending" : ""}`}</Pill> : <Pill value="APPROVED">within authority</Pill>}
        </td>
      </tr>
      {isOpen && <tr><td colSpan={10} className="!p-0"><LineDrawer l={l} p={p} editable={editable} onInclude={onInclude} onRecommend={onRecommend} approvals={approvals} /></td></tr>}
    </>
  );
}

function LineDrawer({ l, p, editable, onInclude, onRecommend, approvals }: { l: Line; p: Proposal; editable: boolean; onInclude: (v: boolean) => void; onRecommend: (s: string, adj: number | null, just: string | null) => void; approvals: Approval[] }) {
  const [tab, setTab] = useState<"rec" | "waterfall" | "intel" | "cost" | "cross" | "approvals">("rec");
  const [strategy, setStrategy] = useState("MATCH"); const [adj, setAdj] = useState("2.5"); const [just, setJust] = useState(l.justification ?? "");
  const rec = l.recommendationJson ? JSON.parse(l.recommendationJson) : null;
  const wf = l.waterfallJson ? JSON.parse(l.waterfallJson) : null;
  const intel = l.competitorIntelJson ? JSON.parse(l.competitorIntelJson) : null;
  const cost = l.costBasisJson ? JSON.parse(l.costBasisJson) : null;
  const tabs: [typeof tab, string][] = [["rec", "Recommendation"], ["waterfall", "Price waterfall"], ["intel", "Competitor prices"], ...(p.permissions.viewCost ? [["cost", "Cost basis"] as [typeof tab, string]] : []), ["cross", "Cross evidence"], ["approvals", "Approvals"]];
  return (
    <div className="bg-panel border-t border-line-2 px-5 py-4 text-[13px]">
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {tabs.map(([k, t]) => <button key={k} className={`chip ${tab === k ? "bg-accent-soft text-accent-ink" : "bg-line-2 text-muted"}`} onClick={() => setTab(k)}>{t}</button>)}
        <span className="ml-auto flex items-center gap-2">
          {l.notes && <span className="text-[11.5px] text-muted max-w-[420px] truncate" title={l.notes}>{l.notes}</span>}
          {editable && <button className="btn-ghost !py-1 !text-[12px]" onClick={() => onInclude(!l.included)}>{l.included ? "Exclude line" : "Include line"}</button>}
        </span>
      </div>
      {tab === "rec" && (
        <div className="grid grid-cols-[1fr_320px] gap-5">
          <div>
            <p className="leading-relaxed">{rec?.explanation ?? "No recommendation — the engine lacked a list price, cost or competitor price for this line."}</p>
            {rec && <div className="mt-3 grid grid-cols-4 gap-3 text-[12px]">
              <Fact k="Strategy" v={label(rec.strategy)} /><Fact k="Target price" v={fmtMoney(rec.targetPrice, p.currency)} /><Fact k="Competitor reference" v={fmtMoney(rec.ceilingPrice, p.currency)} /><Fact k="Anchored to" v={fmtMoney(rec.referencePrice, p.currency)} />
              {p.permissions.viewCost && <Fact k="Floor" v={fmtMoney(rec.floorPrice, p.currency)} />}<Fact k="Discount from list" v={fmtPct(rec.discountFromListPct)} /><Fact k="Below current contract" v={fmtPct(rec.discountFromContractPct)} /><Fact k="Engine confidence" v={`${Math.round((rec.confidence ?? 0) * 100)}%`} />
            </div>}
          </div>
          {editable && (
            <div className="card p-3 bg-paper">
              <div className="eyebrow mb-1.5">Re-recommend with a strategy</div>
              <select className="input mb-2" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                {["MATCH", "UNDERCUT_PCT", "UNDERCUT_AMOUNT", "HOLD_PREMIUM", "PRESERVE_CONTRACT", "STRATEGIC_DISCOUNT", "PENETRATION"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
              {["UNDERCUT_PCT", "HOLD_PREMIUM", "STRATEGIC_DISCOUNT"].includes(strategy) && <label className="label">Adjustment %<input className="input mono" value={adj} onChange={(e) => setAdj(e.target.value)} /></label>}
              {strategy === "HOLD_PREMIUM" && <label className="label">Clinical / product justification<input className="input" value={just} onChange={(e) => setJust(e.target.value)} placeholder="e.g. barrier construction, IFU-supported indication" /></label>}
              <button className="btn-primary w-full justify-center mt-2" onClick={() => onRecommend(strategy, Number(adj) / 100 || null, just || null)}>Apply to this line</button>
            </div>
          )}
        </div>
      )}
      {tab === "waterfall" && (wf ? (
        <div>
          <table className="table !text-[12.5px]"><thead><tr><th>Level</th><th>Contract</th><th className="text-right">Price</th><th>Why</th></tr></thead>
            <tbody>{wf.steps.map((s: { level: string; contractNumber?: string; contractName?: string; price: string | null; applied: boolean; reason: string; volumeTier?: string | null }, i: number) => <tr key={i} className={s.applied ? "bg-exact-soft/40" : ""}><td className="mono">{s.level}{s.applied ? " ✓" : ""}</td><td>{s.contractNumber ? `${s.contractNumber} — ${s.contractName}` : "catalog"}{s.volumeTier ? ` · band ${s.volumeTier}` : ""}</td><td className="mono text-right">{s.price !== null ? fmtMoney(s.price, p.currency) : "—"}</td><td className="text-muted">{s.reason}</td></tr>)}</tbody>
          </table>
          <div className="text-[11.5px] text-muted mt-2">{wf.explanation} · as of {String(wf.asOf).slice(0, 10)}</div>
        </div>
      ) : <span className="text-muted">No product on this line.</span>)}
      {tab === "intel" && (
        <div>
          {intel ? <>
            <p><Pill value={intel.basis} /> {intel.explanation}</p>
            <div className="mt-3 grid grid-cols-5 gap-3 text-[12px]"><Fact k="Observations" v={`${intel.countUsed} used of ${intel.count}`} /><Fact k="Median" v={fmtMoney(intel.median, p.currency)} /><Fact k="Range" v={`${fmtMoney(intel.min, p.currency)} – ${fmtMoney(intel.max, p.currency)}`} /><Fact k="Trend" v={label(intel.trend)} /><Fact k="Same-GPO price" v={fmtMoney(intel.gpoPrice, p.currency)} /></div>
            {intel.mostRecent && <div className="text-[11.5px] text-muted mt-2">Most recent: {fmtMoney(intel.mostRecent.price, p.currency)} on {String(intel.mostRecent.observedAt).slice(0, 10)} ({label(intel.mostRecent.sourceType)}, {intel.mostRecent.relation.toLowerCase()})</div>}
          </> : <span className="text-muted">No competitor price intelligence for {l.competitorCode}. Record one under Competitor pricing.</span>}
          <div className="mt-2"><Link className="text-accent text-[12px]" href={`/intelligence?sku=${encodeURIComponent(l.competitorCode)}&accountId=${p.account.id}`}>Open observations →</Link></div>
        </div>
      )}
      {tab === "cost" && (cost ? <div className="grid grid-cols-4 gap-3 text-[12px]"><Fact k="Cost" v={fmtMoney(l.cost, p.currency)} /><Fact k="Basis" v={label(cost.kind)} /><Fact k="Specificity" v={cost.specificity ?? "—"} /><Fact k="Note" v={cost.note} /><Fact k="Margin / unit" v={fmtMoney(l.marginAmount, p.currency)} /><Fact k="Margin %" v={fmtPct(l.marginPct)} /><Fact k="Floor" v={fmtMoney(l.floorPrice, p.currency)} /><Fact k="Target" v={fmtMoney(l.targetPrice, p.currency)} /></div> : <span className="text-muted">No cost on file — margin unknown.</span>)}
      {tab === "cross" && (
        <div className="grid grid-cols-4 gap-3 text-[12px]">
          <Fact k="Cross-reference verdict" v={l.matchType ?? "—"} /><Fact k="Published equivalence" v={l.equivalenceLevel === "NONE" && l.sku ? "not in published crosswalk" : label(l.equivalenceLevel)} /><Fact k="Crosswalk version" v={`v${p.crosswalkVersion?.number ?? "—"}`} /><Fact k="Governed cross id" v={l.crossId ?? "—"} />
          <div className="col-span-4 text-[11.5px] text-muted">Only entries in the published crosswalk may be represented to a customer as an equivalence. {l.equivalenceLevel === "NONE" && l.sku ? "This pairing was produced by the cross-reference engine but is not yet approved: ask product marketing to review it under Crosswalk." : ""}</div>
        </div>
      )}
      {tab === "approvals" && (approvals.length ? <table className="table !text-[12.5px]"><thead><tr><th>Requested</th><th>Needs</th><th>Reason</th><th>Status</th><th>Decision</th></tr></thead><tbody>{approvals.map((a) => <tr key={a.id}><td>{a.requestedAt.slice(0, 16).replace("T", " ")}</td><td>{label(a.requiredRole)}</td><td>{a.reason}</td><td><Pill value={a.status} /></td><td className="text-muted">{a.decisionComments ?? (a.decidedAt ? a.decidedAt.slice(0, 10) : "")}</td></tr>)}</tbody></table> : <span className="text-muted">No approval requests on this line.</span>)}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) { return <div><div className="eyebrow">{k}</div><div className="mono mt-0.5">{v}</div></div>; }

function AuditTrail({ id }: { id: string }) {
  const [rows, setRows] = useState<{ id: string; at: string; actorName: string; entityType: string; action: string; reason: string | null; beforeJson: string | null; afterJson: string | null; contextJson: string | null }[]>([]);
  useEffect(() => { fetch(`/api/proposals/${id}/audit`).then((r) => r.json()).then((j) => setRows(Array.isArray(j) ? j : [])); }, [id]);
  return (
    <Card title="Audit trail" subtitle="Every price change, submission, decision and export — with the recommendation, floor and margin at the time" className="mt-4" padded={false}>
      <table className="table !text-[12px]"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Before → after</th><th>Context</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td className="mono whitespace-nowrap">{r.at.slice(0, 16).replace("T", " ")}</td><td>{r.actorName}</td><td>{r.entityType} · {label(r.action)}{r.reason ? <div className="text-muted">{r.reason}</div> : null}</td><td className="mono text-[11px] text-muted max-w-[260px] truncate">{r.beforeJson ?? ""} {r.afterJson ? `→ ${r.afterJson}` : ""}</td><td className="mono text-[11px] text-muted max-w-[360px] truncate" title={r.contextJson ?? ""}>{r.contextJson ?? ""}</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

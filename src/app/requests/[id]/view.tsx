"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, Chip, MatchChip, ScoreBar, StatusPill, Stat, money, num, relTime, Empty } from "@/components/ui";
import { needs, usePermissions } from "@/components/permissions";
import { useDismiss } from "@/components/dismiss";
import type { Bin } from "@/lib/match/bin";

type Candidate = { id: string; rank: number; matchType: string; source: string; score: number; scoreBin: number | null; scorePrice: number | null; scoreCogs: number | null; scoreMargin: number | null; confidence: number | null; priceSource: string | null; factorsJson: string | null; rationale: string | null; additionalProducts: string | null; unitPrice: number | null; ownProduct: { id: string; sku: string; description: string; category: string | null; brand: string | null; binJson: string | null; listPrice: number | null; cogs: number | null; gudidDi: string | null; status: string | null } };
type Competitor = { id: string; cfnNorm: string; cfnMatched: string | null; manufacturer: string | null; brand: string | null; description: string | null; gudidDi: string | null; gmdnName: string | null; status: string | null; resolution: string; resolutionNote: string | null; confidence: number | null; alternatesJson: string | null; binJson: string | null; binSource: string | null };
type Line = { id: string; lineNo: number; rawCode: string; cfnNorm: string; quantity: number; estCompetitorPrice: number | null; resolutionStatus: string; resolutionNote: string | null; matchStatus: string; selectedCandidateId: string | null; overrideNote: string | null; customerNote: string | null; flag: string | null; reviewed: boolean; competitorProduct: Competitor | null; candidates: Candidate[] };
type RequestData = { id: string; reference: string; accountName: string | null; accountNumber: string | null; accountType: string | null; reportType: string; status: string; stage: string | null; progress: number; attempt: number; error: string | null; useLlm: boolean; sourceFileName: string | null; createdAt: string; completedAt: string | null; llmAvailable: boolean; modelStatus: { requested: boolean; used: boolean; model: string; error?: string } | null; google: { configured: boolean; canWrite: boolean; email: string | null }; sourceUrl: string | null; xrefSheetUrl: string | null; offerSheetUrl: string | null; company: { name: string }; pricebook: { name: string } | null; lines: Line[]; summary: { total: number; resolved: number; matched: number; exact: number; close: number; alternative: number; reviewed: number; ourExtended: number; competitorExtended: number; priced: number }; log: { t: string; m: string }[] };

type Filter = "all" | "attention" | "flagged" | "exact" | "close" | "alt" | "retain";

export function RequestView({ id }: { id: string }) {
  const { can } = usePermissions();
  const [data, setData] = useState<RequestData | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showLog, setShowLog] = useState(false);

  // Every load carries a sequence number; a reply that arrives after a newer one is dropped,
  // so a slow poll can never overwrite fresher state (a stale 60 % over a finished 100 %).
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(`/api/requests/${id}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (res.ok) { setData(j); setLoadError(null); } else setLoadError({ status: res.status, message: j.error ?? `HTTP ${res.status}` });
    } catch { if (mine === seq.current) setLoadError({ status: 0, message: "Could not reach the server" }); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // Progress polling (1.2 s) only while the run is active and the tab is visible; the interval
  // is cleared on unmount and on navigation, and a hidden tab catches up when it becomes visible.
  const running = Boolean(data && ["running", "queued"].includes(data.status));
  useEffect(() => {
    if (!running) return;
    const tick = () => { if (document.visibilityState === "visible") load(); };
    const t = setInterval(tick, 1200);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [running, load]);

  const us = data?.company.name ?? "Our";

  const lines = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.lines.filter((l) => {
      const sel = l.candidates.find((c) => c.id === l.selectedCandidateId);
      const cp = l.competitorProduct;
      if (filter === "attention" && !(l.resolutionStatus !== "resolved" || !sel || (cp?.confidence ?? 1) < 0.75 || (sel.confidence ?? 1) < 0.75)) return false;
      if (filter === "flagged" && l.flag !== "verify") return false;
      if (filter === "exact" && sel?.matchType !== "Exact Match") return false;
      if (filter === "close" && sel?.matchType !== "Close Match") return false;
      if (filter === "alt" && sel?.matchType !== "Alternative Match") return false;
      if (filter === "retain" && sel?.source !== "identity") return false;
      if (needle) {
        const hay = [l.rawCode, cp?.manufacturer, cp?.description, sel?.ownProduct.sku, sel?.ownProduct.description].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [data, filter, q]);

  /** One JSON call with the error surfaced in the banner instead of swallowed. */
  async function call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setActionError((j as { error?: string }).error ?? `Request failed (${res.status})`); return null; }
      setActionError(null); return j;
    } catch { setActionError("Could not reach the server"); return null; }
  }
  async function patchLine(lineId: string, body: Record<string, unknown>) {
    // Optimistic: the radio / checkbox / flag reflects the click at once (a controlled input
    // otherwise snaps back until the server replies); the reload below reconciles with the
    // server's answer, and a refusal is reported in the banner.
    setData((prev) => (prev ? { ...prev, lines: prev.lines.map((l) => (l.id === lineId ? { ...l, ...(body as Partial<Line>) } : l)) } : prev));
    await call(`/api/requests/${id}/lines/${lineId}`, { method: "PATCH", body: JSON.stringify(body) });
    load();
  }
  async function cancel() {
    await call(`/api/requests/${id}/cancel`, { method: "POST" });
    load();
  }
  async function rerun(useLlm?: boolean, freshGrades = false) {
    await call(`/api/requests/${id}/run`, { method: "POST", body: JSON.stringify({ ...(useLlm == null ? {} : { useLlm }), freshGrades }) });
    load();
  }
  const [compare, setCompare] = useState<{ lineId: string; candidateId: string | null } | null>(null);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  async function bulk(action: string) {
    setBulkMsg(null);
    const j = await call(`/api/requests/${id}/bulk`, { method: "POST", body: JSON.stringify({ action }) });
    if (j) setBulkMsg(`${j.changed} line${j.changed === 1 ? "" : "s"} changed`);
    load();
  }
  async function chooseAlternate(cp: Competitor, di: string) {
    if (await call(`/api/competitor/${cp.id}`, { method: "PATCH", body: JSON.stringify({ di }) })) await rerun();
  }

  if (!data && loadError) return <Empty title={loadError.status === 404 ? "Request not found" : loadError.status === 403 ? "You cannot open this request" : "Could not load the request"}>{loadError.status === 404 ? "It may have been deleted, or it is outside your book of business." : loadError.message} <Link className="text-accent" href="/requests">Back to requests</Link></Empty>;
  if (!data) return <div className="space-y-3" aria-busy="true" aria-label="Loading request"><div className="h-8 w-64 rounded shimmer" /><div className="h-24 rounded shimmer" /><div className="h-96 rounded shimmer" /></div>;
  const s = data.summary;
  const attention = data.lines.filter((l) => { const sel = l.candidates.find((c) => c.id === l.selectedCandidateId); return l.resolutionStatus !== "resolved" || !sel || (l.competitorProduct?.confidence ?? 1) < 0.75 || (sel.confidence ?? 1) < 0.75; }).length;
  const retain = data.lines.filter((l) => l.candidates.find((c) => c.id === l.selectedCandidateId)?.source === "identity").length;
  const flagged = data.lines.filter((l) => l.flag === "verify").length;

  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6 mb-5">
        <div className="min-w-0">
          <div className="eyebrow mb-1.5 flex items-center gap-2"><Link href="/requests" className="hover:text-accent">Requests</Link><span>/</span><span className="mono">{data.reference}</span></div>
          <h1 className="text-[22px] font-semibold tracking-tight leading-tight flex items-center gap-3">
            {data.accountName ?? "Unnamed account"} <StatusPill status={data.status} />
          </h1>
          <div className="text-muted mt-1 text-[13px] flex flex-wrap gap-x-3 gap-y-0.5">
            {data.accountNumber && <span className="mono">{data.accountNumber}</span>}
            {data.accountType && <span>{data.accountType}</span>}
            <span>{data.reportType}</span>
            <span>Pricebook: {data.pricebook?.name ?? "List price"}</span>
            <span>{data.modelStatus ? (data.modelStatus.used ? `Model-assisted · ${data.modelStatus.model}` : "Heuristic matching") : data.useLlm && data.llmAvailable ? "Model-assisted" : "Heuristic matching"}</span>
            {data.sourceFileName && (data.sourceUrl ? <a className="truncate max-w-[260px] text-accent" href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceFileName} ↗</a> : <span className="truncate max-w-[260px]">{data.sourceFileName}</span>)}
            <span>{relTime(data.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap md:justify-end">
          <button type="button" className="btn-secondary" onClick={() => rerun()} disabled={running} title="Replays cached model verdicts for unchanged lines — results cannot flip">{running ? (data.status === "queued" ? "Queued…" : "Running…") : "Re-run"}</button>
          {running && <button type="button" className="btn-ghost" onClick={cancel} title="Stop at the next checkpoint; the previous results stay visible">Cancel</button>}
          {data.llmAvailable && <button type="button" className="btn-ghost" onClick={() => rerun(undefined, true)} disabled={running} title="Ask the model again for every line (ignores cached verdicts)">Re-grade fresh</button>}
          <ExportMenu id={id} />
          <SheetsButton id={id} google={data.google} xrefUrl={data.xrefSheetUrl} offerUrl={data.offerSheetUrl} onDone={load} />
          {data.status === "complete" && <CreateProposal requestId={id} allowed={can("edit_proposed_pricing")} hasAccount={Boolean(data.accountNumber)} />}
        </div>
      </div>
      {actionError && <div role="alert" className="rounded-lg bg-none-soft text-none px-4 py-3 mb-4 text-[13px]">{actionError}</div>}
      {loadError && data && <div role="alert" className="rounded-lg bg-alt-soft text-alt px-4 py-2.5 mb-4 text-[13px]">Showing the last loaded state — the latest refresh failed: {loadError.message}</div>}

      {running && (
        <div className="card px-5 py-4 mb-4" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-[13px] mb-2">
            <div className="flex items-center gap-2 font-medium"><span className="h-2 w-2 rounded-full bg-info pulse-dot" aria-hidden />{data.stage ?? "Queued"}</div>
            <span className="mono text-muted">{data.progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-line-2 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.progress} aria-label="Run progress"><div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${data.progress}%` }} /></div>
        </div>
      )}
      {data.status === "failed" && <div className="rounded-lg bg-none-soft text-none px-4 py-3 mb-4 text-[13px]"><b>Run failed:</b> {data.error}{data.attempt > 1 ? <span className="block text-[12px] mt-1 opacity-90">Attempt {data.attempt}; the queue retried from the last completed stage.</span> : null}</div>}
      {data.status === "cancelled" && <div className="rounded-lg bg-alt-soft text-alt px-4 py-3 mb-4 text-[13px]"><b>Run cancelled.</b> The results shown are from the last completed run. Re-run when ready.</div>}
      {data.modelStatus?.requested && !data.modelStatus.used && (
        <div className="rounded-lg bg-alt-soft text-alt px-4 py-3 mb-4 text-[13px]">
          <b>The model was not used on this run</b> — it fell back to heuristic matching. {data.modelStatus.error}
          <span className="block text-[12px] mt-1 opacity-90">Fix <span className="mono">OPENAI_API_KEY</span> / <span className="mono">LLM_MODEL</span> in .env, restart the server, then Re-run. Settings → Model shows every call and its error.</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <Stat label="Lines" value={s.total} hint={`${num(data.lines.reduce((a, l) => a + l.quantity, 0))} units`} />
        <Stat label="Resolved in GUDID" value={`${s.resolved}/${s.total}`} tone="accent" hint={s.total ? `${Math.round((s.resolved / s.total) * 100)}%` : ""} />
        <Stat label="Matched" value={s.matched} hint={<span><span className="text-exact">{s.exact} exact</span> · <span className="text-close">{s.close} close</span> · <span className="text-alt">{s.alternative} alt</span></span>} />
        <Stat label="Needs attention" value={attention} tone={attention ? "alt" : "exact"} hint={retain ? `${retain} already ours` : "unresolved, unmatched, low confidence"} />
        <Stat label={`${us} extended`} value={money(s.ourExtended, { compact: true })} hint={`${s.priced} of ${s.matched} priced`} />
        <Stat label="Reviewed" value={`${s.reviewed}/${s.total}`} hint="rep sign-off" />
      </div>

      <Card padded={false}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Filter lines">
            {([["all", "All", data.lines.length], ["attention", "Needs attention", attention], ["flagged", "Flagged", flagged], ["exact", "Exact", s.exact], ["close", "Close", s.close], ["alt", "Alternative", s.alternative], ["retain", "Already ours", retain]] as [Filter, string, number][]).map(([k, label, n]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${filter === k ? "bg-ink text-white" : "text-ink-2 hover:bg-line-2"}`}>{label} <span className={`mono ${filter === k ? "text-white/70" : "text-muted"}`}>{n}</span></button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {bulkMsg && <span role="status" className="text-[12px] text-muted">{bulkMsg}</span>}
            {!running && <BulkMenu onAction={bulk} counts={{ exact: s.exact, matched: s.matched, attention, flagged }} />}
            <input className="input w-full sm:w-[260px]" aria-label="Search lines" placeholder="Search code, product, manufacturer…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="button" className="btn-ghost" onClick={() => setOpen(open.size ? new Set() : new Set(lines.map((l) => l.id)))}>{open.size ? "Collapse all" : "Expand all"}</button>
          </div>
        </div>
        {lines.length === 0 ? (
          <Empty title={running ? "Working…" : "Nothing here"}>{running ? "Results appear as each stage completes." : "Try another filter."}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Expand</span></th>
                <th className="w-8">#</th>
                <th>Competitor product</th>
                <th className="text-right w-16">Qty</th>
                <th>{us} best fit</th>
                <th className="w-[120px]">Fit</th>
                <th className="text-right w-24">Unit</th>
                <th className="text-right w-28">Extended</th>
                <th className="w-16 text-center">Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const cp = l.competitorProduct;
                const sel = l.candidates.find((c) => c.id === l.selectedCandidateId) ?? null;
                const isOpen = open.has(l.id);
                const notFound = !cp || cp.resolution === "not-found";
                const lowConf = cp && !notFound && (cp.confidence ?? 1) < 0.75;
                return (
                  <LineRows key={l.id} l={l} cp={cp} sel={sel} isOpen={isOpen} notFound={notFound} lowConf={Boolean(lowConf)} us={us}
                    toggle={() => setOpen((o) => { const n = new Set(o); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })}
                    onSelect={(cid) => patchLine(l.id, { selectedCandidateId: cid })}
                    onReviewed={(v) => patchLine(l.id, { reviewed: v })}
                    onNote={(v) => patchLine(l.id, { overrideNote: v })}
                    onCustomerNote={(v) => patchLine(l.id, { customerNote: v })}
                    onFlag={(v) => patchLine(l.id, { flag: v ? "verify" : null })}
                    onCompare={(cid) => setCompare({ lineId: l.id, candidateId: cid })}
                    onPrice={(v) => patchLine(l.id, { estCompetitorPrice: v })}
                    onAlternate={(di) => cp && chooseAlternate(cp, di)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {compare && <CompareModal requestId={id} lineId={compare.lineId} candidateId={compare.candidateId} onClose={() => setCompare(null)} us={us} />}
      <div className="mt-4">
        <button type="button" className="btn-ghost text-[12.5px]" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>{showLog ? "Hide" : "Show"} run log ({data.log.length})</button>
        {showLog && (
          <div className="card mt-2 p-4 mono text-[12px] text-ink-2 space-y-1 max-h-72 overflow-auto">
            {data.log.map((e, i) => <div key={i}><span className="text-faint">{new Date(e.t).toLocaleTimeString()}</span>  {e.m}</div>)}
          </div>
        )}
      </div>
    </>
  );
}

function LineRows({ l, cp, sel, isOpen, notFound, lowConf, us, toggle, onSelect, onReviewed, onNote, onCustomerNote, onFlag, onCompare, onPrice, onAlternate }: {
  l: Line; cp: Competitor | null; sel: Candidate | null; isOpen: boolean; notFound: boolean; lowConf: boolean; us: string;
  toggle: () => void; onSelect: (id: string | null) => void; onReviewed: (v: boolean) => void; onNote: (v: string) => void; onCustomerNote: (v: string) => void; onFlag: (v: boolean) => void; onCompare: (candidateId: string | null) => void; onPrice: (v: number | null) => void; onAlternate: (di: string) => void;
}) {
  const [note, setNote] = useState(l.overrideNote ?? "");
  const [cnote, setCnote] = useState(l.customerNote ?? "");
  const [price, setPrice] = useState(l.estCompetitorPrice != null ? String(l.estCompetitorPrice) : "");
  const compBin = parseBinSafe(cp?.binJson);
  const alternates: { company: string; brand: string; cfn: string; description: string; status: string; key: string }[] = cp?.alternatesJson ? JSON.parse(cp.alternatesJson) : [];
  const ext = sel?.unitPrice != null ? sel.unitPrice * l.quantity : null;
  return (
    <>
      <tr className={isOpen ? "bg-panel-2" : ""}>
        <td className="text-muted"><button type="button" className="p-1 rounded hover:bg-line-2" aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} line ${l.lineNo} ${l.rawCode}`} onClick={toggle}><Chevron open={isOpen} /></button></td>
        <td className="mono text-muted">{l.lineNo}</td>
        <td className="cursor-pointer" onClick={toggle}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono font-semibold">{l.rawCode}</span>
            {cp?.cfnMatched && cp.cfnMatched !== l.cfnNorm && <span className="mono text-[11px] text-muted">→ {cp.cfnMatched}</span>}
            {notFound ? <Chip tone="none">Not in GUDID</Chip> : lowConf ? <Chip tone="alt">Verify · {Math.round((cp?.confidence ?? 0) * 100)}%</Chip> : cp?.resolution === "manual" ? <Chip tone="info">Rep-corrected</Chip> : null}
            {cp?.status && /not in/i.test(cp.status) && <Chip tone="alt">Discontinued</Chip>}
            {l.flag === "verify" && <Chip tone="alt">Flagged</Chip>}
          </div>
          <div className="text-[12.5px] text-ink-2 mt-0.5 line-clamp-2">
            {cp?.manufacturer && <span className="font-medium text-ink">{cp.manufacturer} · </span>}
            {cp?.description ?? <span className="text-muted">{l.resolutionNote ?? "—"}</span>}
          </div>
        </td>
        <td className="mono text-right">{num(l.quantity)}</td>
        <td className="cursor-pointer" onClick={toggle}>
          {sel ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="mono font-semibold">{sel.ownProduct.sku}</span>
                <MatchChip type={sel.matchType} />
                {sel.source === "identity" && <Chip tone="info">Already ours</Chip>}
                {sel.source === "known-cross" && <Chip>Curated{curatedOf(sel)?.contradicted ? " · contradicted" : ""}</Chip>}
                {sel.confidence != null && sel.confidence < 0.75 && sel.source !== "identity" && <Chip tone="alt" title="Match confidence: how much evidence supports this grade">Verify match · {Math.round(sel.confidence * 100)}%</Chip>}
                {l.candidates.length > 1 && <span className="text-[11.5px] text-muted">+{l.candidates.length - 1} more</span>}
              </div>
              <div className="text-[12.5px] text-ink-2 mt-0.5 line-clamp-2">{sel.ownProduct.description}</div>
              {mismatchOf(sel) && <div className="text-[12px] text-alt mt-0.5 line-clamp-1">{mismatchOf(sel)}</div>}
            </>
          ) : (
            <div className="text-muted text-[12.5px]">{notFound ? "Resolve the competitor product first" : l.candidates.length ? "No acceptable match — review candidates" : "No candidates in catalog"}</div>
          )}
        </td>
        <td>{sel ? <ScoreBar value={sel.score} tone={sel.matchType === "Exact Match" ? "exact" : sel.matchType === "Alternative Match" ? "alt" : "accent"} /> : null}</td>
        <td className="mono text-right" title={sel?.priceSource ?? undefined}>{sel ? money(sel.unitPrice) : ""}{sel?.priceSource && !sel.priceSource.startsWith("no price") && <div className="text-[10.5px] text-muted font-sans whitespace-nowrap">{sel.priceSource.replace(/^LIST · catalog list price$/, "list price")}</div>}{sel && sel.unitPrice == null && sel.priceSource && <div className="text-[10.5px] text-alt font-sans">no price</div>}</td>
        <td className="mono text-right">{sel ? money(ext) : ""}</td>
        <td className="text-center"><input type="checkbox" className="accent-[var(--accent)] h-4 w-4" aria-label={`Line ${l.lineNo} reviewed`} checked={l.reviewed} onChange={(e) => onReviewed(e.target.checked)} /></td>
      </tr>
      {isOpen && (
        <tr className="bg-panel-2">
          <td colSpan={9} className="!p-0">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-0 border-t border-line-2">
              {/* Competitor pane */}
              <div className="p-5 border-b lg:border-b-0 lg:border-r border-line-2">
                <div className="eyebrow mb-2">Competitor product</div>
                {cp && !notFound ? (
                  <>
                    <div className="text-[13px] font-medium text-ink">{cp.brand ? `${cp.brand} · ` : ""}{cp.manufacturer}</div>
                    <div className="text-[12.5px] text-ink-2 mb-3">{cp.description}</div>
                    <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-[12.5px]">
                      <dt className="text-muted">Resolution</dt><dd>{cp.resolutionNote} <span className="text-muted">({Math.round((cp.confidence ?? 0) * 100)}%)</span></dd>
                      {cp.gudidDi && <><dt className="text-muted">GUDID DI</dt><dd><a className="mono text-accent" target="_blank" rel="noreferrer" href={`https://accessgudid.nlm.nih.gov/devices/${cp.gudidDi}`}>{cp.gudidDi}</a></dd></>}
                      {cp.gmdnName && <><dt className="text-muted">GMDN</dt><dd>{cp.gmdnName}</dd></>}
                      {cp.status && <><dt className="text-muted">Status</dt><dd>{cp.status}</dd></>}
                      {cp.binSource && <><dt className="text-muted">Binned by</dt><dd>{cp.binSource === "llm" ? "model" : "heuristics"}</dd></>}
                    </dl>
                    {compBin && <BinView bin={compBin} className="mt-3" />}
                    {alternates.length > 0 && (
                      <div className="mt-4">
                        <div className="eyebrow mb-1.5">Other GUDID records for this code</div>
                        <ul className="space-y-1">
                          {alternates.map((a) => (
                            <li key={a.key} className="flex items-center justify-between gap-2 text-[12px] rounded-md border border-line px-2.5 py-1.5 bg-panel">
                              <span className="min-w-0 truncate"><b>{a.company}</b> · {a.brand} · <span className="mono">{a.cfn}</span> <span className="text-muted">{a.description}</span></span>
                              <button type="button" className="text-accent font-medium shrink-0" onClick={() => onAlternate(a.key)}>Use this</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[12.5px] text-muted">{cp?.resolutionNote ?? l.resolutionNote ?? "This code could not be found in GUDID."} {cp?.manufacturer && <div className="mt-1">Model's guess: <b>{cp.manufacturer}</b> — {cp.description}</div>}</div>
                )}
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label" htmlFor={`price-${l.id}`}>Est. competitor unit price</label>
                    <input id={`price-${l.id}`} className="input mono" inputMode="decimal" placeholder="—" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={() => { const v = price.trim() === "" ? null : Number(price); if (v !== null && !Number.isFinite(v)) return; if (v !== (l.estCompetitorPrice ?? null)) onPrice(v); }} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`note-${l.id}`}>Rep note (internal)</label>
                    <input id={`note-${l.id}`} className="input" placeholder="Why you chose this" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== (l.overrideNote ?? "")) onNote(note); }} />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-[1fr_auto] gap-3 items-end">
                  <div>
                    <label className="label" htmlFor={`cnote-${l.id}`}>Note for the customer (printed on the offer and quote)</label>
                    <input id={`cnote-${l.id}`} className="input" placeholder="e.g. same platform as current reload; trim to size" value={cnote} onChange={(e) => setCnote(e.target.value)} onBlur={() => { if ((cnote || "") !== (l.customerNote ?? "")) onCustomerNote(cnote); }} />
                  </div>
                  <button type="button" className={`btn-ghost text-[12px] ${l.flag === "verify" ? "text-alt" : ""}`} aria-pressed={l.flag === "verify"} onClick={() => onFlag(l.flag !== "verify")} title="Flag for a second look; cleared when you mark the line reviewed">{l.flag === "verify" ? "Unflag" : "Flag to verify"}</button>
                </div>
              </div>
              {/* Candidates pane */}
              <div className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="eyebrow">{us} candidates</div>
                  <span className="flex items-center gap-3">
                    {cp && !notFound && l.candidates.length > 0 && <button type="button" className="text-[12px] text-accent font-medium" onClick={() => onCompare(sel?.id ?? null)}>Side-by-side</button>}
                    {sel && <button type="button" className="text-[12px] text-muted hover:text-none" onClick={() => onSelect(null)}>Clear selection</button>}
                  </span>
                </div>
                {l.candidates.length === 0 ? (
                  <div className="text-[12.5px] text-muted">No candidates. Add the right SKU to the catalog and re-run.</div>
                ) : (
                  <ul className="space-y-2">
                    {l.candidates.map((c) => <CandidateRow key={c.id} c={c} lineId={l.id} selected={c.id === l.selectedCandidateId} qty={l.quantity} onSelect={() => onSelect(c.id)} compBin={compBin} />)}
                  </ul>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type Factors = { used: string[]; notes: string[]; evidence?: { kind: "hard" | "soft" | "agree" | "unknown"; field: string; text: string }[]; curated?: { source: string; grade: string; effective: string; contradicted: boolean; preferred: boolean }; cap?: string };
const factorsOf = (c: Candidate): Factors | null => { if (!c.factorsJson) return null; try { return JSON.parse(c.factorsJson) as Factors; } catch { return null; } };
const curatedOf = (c: Candidate) => factorsOf(c)?.curated ?? null;
/** The first contradiction, for the line row ("length 150 mm vs 100 mm"). */
const mismatchOf = (c: Candidate): string | null => { const e = factorsOf(c)?.evidence?.find((x) => x.kind === "hard" || x.kind === "soft"); return e ? `${e.kind === "hard" ? "✗" : "≠"} ${e.text}` : null; };

function EvidenceList({ f }: { f: Factors }) {
  const ev = f.evidence ?? [];
  if (!ev.length && !f.curated) return null;
  const glyph = { hard: "✗", soft: "≠", agree: "=", unknown: "?" } as const;
  const tone = { hard: "text-alt", soft: "text-alt", agree: "text-exact", unknown: "text-muted" } as const;
  const order = { hard: 0, soft: 1, agree: 2, unknown: 3 } as const;
  return (
    <ul className="mt-2 text-[12px] space-y-0.5">
      {f.curated && <li className="text-ink-2">📄 Curated cross: <span className="font-medium">{f.curated.source}</span> says {f.curated.grade}{f.curated.preferred ? " (reviewer's preferred cross)" : ""}{f.curated.contradicted ? ` — ranked as ${f.curated.effective}: the attributes contradict it` : ""}</li>}
      {[...ev].sort((a, b) => order[a.kind] - order[b.kind]).map((e, i) => <li key={i} className={tone[e.kind]}><span className="mono">{glyph[e.kind]}</span> <span className="text-muted">{e.field}:</span> {e.text}</li>)}
    </ul>
  );
}

function CandidateRow({ c, lineId, selected, qty, onSelect, compBin }: { c: Candidate; lineId: string; selected: boolean; qty: number; onSelect: () => void; compBin: Bin | null }) {
  const [more, setMore] = useState(false);
  const factors = factorsOf(c);
  const bin = parseBinSafe(c.ownProduct.binJson);
  return (
    <li className={`rounded-lg border px-3.5 py-3 bg-panel transition-colors ${selected ? "border-accent ring-2 ring-accent/15" : "border-line hover:border-faint"}`}>
      <div className="flex items-start gap-3">
        <input type="radio" name={`cand-${lineId}`} className="mt-1 accent-[var(--accent)]" aria-label={`Select ${c.ownProduct.sku} for this line`} checked={selected} onChange={onSelect} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-[11px] text-muted">#{c.rank}</span>
            <span className="mono font-semibold">{c.ownProduct.sku}</span>
            <MatchChip type={c.matchType} />
            {c.source === "identity" && <Chip tone="info">Already ours</Chip>}
            {c.source === "known-cross" && <Chip>Curated cross{factors?.curated ? ` · ${factors.curated.source}` : ""}</Chip>}
            {c.confidence != null && c.source !== "identity" && <Chip tone={c.confidence < 0.75 ? "alt" : "none"} title="How much evidence supports this grade (not the same as fit)">{c.confidence < 0.75 ? "Verify · " : "Confidence "}{Math.round(c.confidence * 100)}%</Chip>}
            {c.ownProduct.status && /not in/i.test(c.ownProduct.status) && <Chip tone="alt">Discontinued</Chip>}
            <span className="ml-auto mono text-[12.5px] text-right">{money(c.unitPrice)}{c.unitPrice != null && <span className="text-muted"> · {money(c.unitPrice * qty)}</span>}{c.priceSource && <div className={`text-[10.5px] font-sans ${c.priceSource.startsWith("no price") ? "text-alt" : "text-muted"}`} title={c.priceSource}>{c.priceSource.startsWith("no price") ? "no price on file" : c.priceSource.replace(/^LIST · catalog list price$/, "list price")}</div>}</span>
          </div>
          <div className="text-[12.5px] text-ink-2 mt-0.5">{c.ownProduct.description}</div>
          {c.rationale && !factors?.evidence?.length && <div className="text-[12.5px] text-muted mt-1 italic">{c.rationale}</div>}
          {factors?.evidence?.length ? <EvidenceList f={factors} /> : null}
          {c.priceSource?.startsWith("no price") && <div className="text-[11.5px] text-muted mt-1">{c.priceSource.replace(/^no price: /, "Why no price: ")}</div>}
          {c.additionalProducts && <div className="text-[12px] mt-1"><span className="text-muted">Also needs:</span> <span className="mono">{c.additionalProducts}</span></div>}
          <div className="flex items-center gap-4 mt-2 text-[11.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1.5">Fit <ScoreBar value={c.scoreBin} width={48} /></span>
            <span className="flex items-center gap-1.5">Price <ScoreBar value={c.scorePrice} width={48} tone={c.scorePrice == null ? "none" : "accent"} /></span>
            <span className="flex items-center gap-1.5">Cost <ScoreBar value={c.scoreCogs} width={48} /></span>
            <span className="flex items-center gap-1.5">Margin <ScoreBar value={c.scoreMargin} width={48} /></span>
            <span className="flex items-center gap-1.5 font-medium text-ink-2">Overall <ScoreBar value={c.score} width={48} /></span>
            <button type="button" className="ml-auto text-accent font-medium" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Hide attributes" : "Compare attributes"}</button>
          </div>
          {more && bin && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <BinView bin={bin} title={`${c.ownProduct.sku}`} />
              {compBin ? <BinView bin={compBin} title="Competitor" /> : <div className="text-[12px] text-muted">Competitor not binned.</div>}
            </div>
          )}
          {factors && factors.used.length < 4 && <div className="text-[11px] text-faint mt-1.5">Ranked on {factors.used.join(", ")} — {["price", "cogs", "margin"].filter((f) => !factors.used.includes(f)).join(", ")} unavailable for this SKU.</div>}
        </div>
      </div>
    </li>
  );
}

export function BinView({ bin, title, className = "" }: { bin: Bin; title?: string; className?: string }) {
  return (
    <div className={`rounded-lg bg-panel border border-line-2 p-3 text-[12px] ${className}`}>
      {title && <div className="font-semibold text-ink mb-1">{title}</div>}
      <div className="grid grid-cols-[86px_1fr] gap-y-1">
        <span className="text-muted">Type</span><span className="text-ink">{bin.productType} <span className="text-muted">· {bin.family}</span></span>
        {bin.dimensions.length > 0 && <><span className="text-muted">Sizes</span><span className="mono">{bin.dimensions.map((d) => `${d.name} ${d.value}${d.unit === "count" ? "" : " " + d.unit}`).join(" · ")}</span></>}
        {bin.materials.length > 0 && <><span className="text-muted">Materials</span><span>{bin.materials.join(", ")}</span></>}
        {bin.features.length > 0 && <><span className="text-muted">Features</span><span className="flex flex-wrap gap-1">{bin.features.map((f) => <Chip key={f}>{f}</Chip>)}</span></>}
        {bin.compatibility.length > 0 && <><span className="text-muted">Platform</span><span>{bin.compatibility.join(", ")}</span></>}
        <span className="text-muted">Function</span><span className="text-ink-2">{bin.function}</span>
      </div>
    </div>
  );
}

function parseBinSafe(json: string | null | undefined): Bin | null {
  if (!json) return null;
  try { return JSON.parse(json) as Bin; } catch { return null; }
}

function ExportMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box, trigger);
  const items: [string, string][] = [
    ["Cross-reference workbook (.xlsx)", `/api/requests/${id}/export?type=xref`],
    ["Cross-reference sheet (.csv)", `/api/requests/${id}/export?type=xref&format=csv`],
    ["Contract offer (.xlsx)", `/api/requests/${id}/export?type=offer`],
    ["Contract offer (.csv)", `/api/requests/${id}/export?type=offer&format=csv`],
    ["Contract offer (branded PDF)", `/api/requests/${id}/export?type=offer&format=pdf`],
  ];
  return (
    <div className="relative" ref={box}>
      <button ref={trigger} type="button" className="btn-secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><IconDownload /> Download <span className="text-muted" aria-hidden>▾</span></button>
      {open && (
        <div role="menu" aria-label="Download" className="absolute right-0 top-11 z-20 w-[min(300px,calc(100vw-2rem))] card p-1.5" style={{ boxShadow: "var(--shadow-lg)" }}>
          {items.map(([label, href]) => <a key={href} role="menuitem" href={href} className="block rounded-md px-3 py-2 text-[13px] hover:bg-line-2" onClick={() => setOpen(false)}>{label}</a>)}
          <div className="px-3 pt-2 pb-1 text-[11.5px] text-muted border-t border-line-2 mt-1">.xlsx and .csv both open in Google Sheets for free (Drive → New → File upload).</div>
        </div>
      )}
    </div>
  );
}

function SheetsButton({ id, google, xrefUrl, offerUrl, onDone }: { id: string; google: { configured: boolean; canWrite: boolean; email: string | null }; xrefUrl: string | null; offerUrl: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box, trigger);
  async function send() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/requests/${id}/sheets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error ?? `Could not write to Drive (${res.status})`); setOpen(true); return; }
      setOpen(true);
      onDone();
    } catch { setErr("Could not reach the server"); setOpen(true); } finally { setBusy(false); }
  }
  return (
    <div className="relative" ref={box}>
      {google.canWrite ? (
        <button ref={trigger} type="button" className="btn-primary" aria-haspopup="dialog" aria-expanded={open} onClick={xrefUrl || offerUrl ? () => setOpen(!open) : send} disabled={busy}>
          <IconSheets /> {busy ? "Writing to Drive…" : xrefUrl || offerUrl ? "Google Sheets" : "Send to Google Sheets"}
        </button>
      ) : (
        <button ref={trigger} type="button" className="btn-primary" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><IconSheets /> Google Sheets</button>
      )}
      {open && (
        <div role="dialog" aria-label="Google Sheets" className="absolute right-0 top-11 z-20 w-[min(340px,calc(100vw-2rem))] card p-4 text-[13px]" style={{ boxShadow: "var(--shadow-lg)" }}>
          {google.canWrite ? (
            <>
              <div className="font-semibold mb-2">In your Drive folder</div>
              {xrefUrl ? <a className="block text-accent font-medium mb-1" href={xrefUrl} target="_blank" rel="noreferrer">Open cross-reference sheet ↗</a> : null}
              {offerUrl ? <a className="block text-accent font-medium mb-1" href={offerUrl} target="_blank" rel="noreferrer">Open contract offer sheet ↗</a> : null}
              <button type="button" className="btn-secondary mt-2 w-full justify-center" onClick={send} disabled={busy}>{busy ? "Writing…" : "Write fresh copies"}</button>
              {err && <div role="alert" className="text-none mt-2 text-[12.5px]">{err}</div>}
            </>
          ) : (
            <>
              <div className="font-semibold mb-1">Open in Google Sheets</div>
              <p className="text-muted text-[12.5px] mb-3">Download either file below, then in Google Drive choose <b>New → File upload</b> — Sheets opens .xlsx and .csv for free and keeps the tabs and formatting.</p>
              <a className="btn-secondary w-full justify-center mb-1.5" href={`/api/requests/${id}/export?type=xref`}><IconDownload /> Cross-reference .xlsx</a>
              <a className="btn-secondary w-full justify-center" href={`/api/requests/${id}/export?type=offer`}><IconDownload /> Contract offer .xlsx</a>
              <p className="text-[11.5px] text-muted mt-3 pt-2 border-t border-line-2">Want one-click write-back into a Drive folder? Add a Google service account in <a className="text-accent" href="/settings">Settings</a>{google.configured ? " and set GOOGLE_DRIVE_FOLDER_ID" : ""}.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function IconSheets() {
  return <svg aria-hidden width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="2.5" width="12" height="15" rx="1.5" /><path d="M7 8h6M7 11h6M7 14h6M10 8v6" strokeLinecap="round" /></svg>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg aria-hidden width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={`transition-transform ${open ? "rotate-90" : ""}`}><path d="M7 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconDownload() {
  return <svg aria-hidden width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 15v1a1 1 0 001 1h10a1 1 0 001-1v-1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}


/** Hand the cross-reference to the commercial workspace: waterfall pricing, competitor intelligence, recommendations, approvals. */
function CreateProposal({ requestId, allowed, hasAccount }: { requestId: string; allowed: boolean; hasAccount: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; accountNumber: string | null }[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closePick = useCallback(() => setPick(false), []);
  useDismiss(pick, closePick, box, trigger);
  // Account search for a request that carries no account number: the API cannot infer one.
  useEffect(() => {
    if (!pick) return;
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/accounts?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" }); const j = await r.json().catch(() => null); setHits(r.ok && Array.isArray(j) ? j.slice(0, 8) : []); }
      catch { setHits([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [pick, q]);
  async function go(accountId?: string) {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(accountId ? { requestId, accountId } : { requestId }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? `Could not create proposal (${r.status})`); return; }
      window.location.href = `/proposals/${j.id}`;
    } catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  return (
    <span className="relative" ref={box}>
      <button ref={trigger} type="button" className="btn-primary" onClick={() => (hasAccount ? go() : setPick((v) => !v))} disabled={busy || !allowed} aria-haspopup={hasAccount ? undefined : "dialog"} aria-expanded={hasAccount ? undefined : pick} title={allowed ? "Creates a versioned proposal: applicable contract prices, competitor intelligence, recommended prices and approval requirements for every selected line" : needs("edit_proposed_pricing")}>{busy ? "Pricing…" : "Create proposal"}</button>
      {pick && !hasAccount && (
        <div role="dialog" aria-label="Choose the account for this proposal" className="absolute right-0 top-11 z-20 w-[min(340px,calc(100vw-2rem))] card p-3 text-[13px] text-left" style={{ boxShadow: "var(--shadow-lg)" }}>
          <div className="font-semibold mb-1">Which account is this proposal for?</div>
          <p className="text-[12px] text-muted mb-2">This request was created without an account number, so choose the account the quote belongs to.</p>
          <input className="input" autoFocus aria-label="Search accounts" placeholder="Account name or number" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="mt-2 max-h-48 overflow-auto divide-y divide-line-2" aria-label="Matching accounts">
            {hits === null ? <li className="py-1.5 text-muted">Searching…</li> : hits.length === 0 ? <li className="py-1.5 text-muted">No account matches.</li> : hits.map((a) => <li key={a.id}><button type="button" className="w-full text-left py-1.5 hover:text-accent" disabled={busy} onClick={() => go(a.id)}>{a.name} <span className="mono text-[11.5px] text-muted">{a.accountNumber ?? "no number"}</span></button></li>)}
          </ul>
        </div>
      )}
      {err && <span role="alert" className="absolute right-0 top-11 z-20 w-64 text-[11.5px] text-none bg-none-soft rounded px-2 py-1">{err}</span>}
    </span>
  );
}


/** Bulk actions (Tier 3.1): the same per-line changes, applied to every line the server says qualifies. */
function BulkMenu({ onAction, counts }: { onAction: (a: string) => void; counts: { exact: number; matched: number; attention: number; flagged: number } }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box, trigger);
  const items: [string, string, string][] = [
    ["review_exact", `Mark all Exact matches reviewed (${counts.exact})`, "Records each as an accepted top pick"],
    ["review_matched", `Mark every matched line reviewed (${counts.matched})`, "Exact, Close and Alternative selections"],
    ["select_top", "Select the top candidate where nothing is selected", "Skips lines with no acceptable candidate"],
    ["flag_verify", `Flag everything needing attention to verify (${counts.attention})`, "Unresolved, low-confidence, unselected or Alternative"],
    ["clear_flags", `Clear all verify flags (${counts.flagged})`, ""],
    ["unreview_all", "Clear all reviewed marks", ""],
  ];
  return (
    <div className="relative" ref={box}>
      <button ref={trigger} type="button" className="btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Bulk actions <span className="text-muted" aria-hidden>▾</span></button>
      {open && (
        <div role="menu" aria-label="Bulk actions" className="absolute right-0 top-10 z-20 w-[min(360px,calc(100vw-2rem))] card p-1.5" style={{ boxShadow: "var(--shadow-lg)" }}>
          {items.map(([a, label, hint]) => <button key={a} type="button" role="menuitem" className="block w-full text-left rounded-md px-3 py-2 text-[13px] hover:bg-line-2" onClick={() => { setOpen(false); onAction(a); }}>{label}{hint && <span className="block text-[11.5px] text-muted">{hint}</span>}</button>)}
        </div>
      )}
    </div>
  );
}

type CompareData = { line: { id: string; rawCode: string; quantity: number }; candidate: { id: string; rank: number; matchType: string; score: number; rationale: string | null; additionalProducts: string | null; unitPrice: number | null }; competitor: { sku: string; brand: string | null; manufacturer: string | null; description: string | null; gudidUrl: string | null; binSource: string | null }; ours: { sku: string; brand: string | null; manufacturer: string | null; description: string | null; gudidUrl: string | null; binSource: string | null; listPrice: number | null }; rows: { attribute: string; competitor: string | null; ours: string | null; same: boolean | null; group: string }[]; similarity: { score: number } | null; candidates: { id: string; sku: string; rank: number; matchType: string }[] };

/** Side-by-side (Tier 3.2): GUDID record vs GUDID record, bin vs bin, one attribute per row. */
function CompareModal({ requestId, lineId, candidateId, onClose, us }: { requestId: string; lineId: string; candidateId: string | null; onClose: () => void; us: string }) {
  const [cid, setCid] = useState<string | null>(candidateId);
  const [d, setD] = useState<CompareData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null); setErr(null);
    const ac = new AbortController();
    fetch(`/api/requests/${requestId}/lines/${lineId}/compare${cid ? `?candidateId=${encodeURIComponent(cid)}` : ""}`, { cache: "no-store", signal: ac.signal }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) setErr(j.error ?? `Could not load the comparison (${r.status})`); else setD(j); }).catch((e) => { if ((e as Error).name !== "AbortError") setErr("Could not reach the server"); });
    return () => ac.abort();
  }, [requestId, lineId, cid]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  // Focus moves into the dialog on open and back to the opener on close; Tab stays inside.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button, select, a")?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>("button, select, a[href], input, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", trap);
    return () => { window.removeEventListener("keydown", trap); opener?.focus?.(); };
  }, []);
  const groups = d ? [...new Set(d.rows.map((r) => r.group))] : [];
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-auto" onClick={onClose}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="compare-title" className="card w-full max-w-[1080px] p-0 mt-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-3 border-b border-line-2 flex-wrap">
          <div className="font-semibold" id="compare-title">Side-by-side</div>
          {d && <div className="text-[12.5px] text-muted">{d.line.rawCode} vs <span className="mono text-ink">{d.ours.sku}</span> · <MatchChip type={d.candidate.matchType} />{d.similarity && <span className="ml-2">attribute similarity {Math.round(d.similarity.score * 100)}%</span>}</div>}
          {d && d.candidates.length > 1 && <select className="input !w-auto !py-1 !text-[12px] ml-auto" aria-label="Candidate to compare" value={cid ?? d.candidate.id} onChange={(e) => setCid(e.target.value)}>{d.candidates.map((c) => <option key={c.id} value={c.id}>#{c.rank} {c.sku} — {c.matchType}</option>)}</select>}
          <button type="button" className="btn-ghost !py-1" onClick={onClose}>Close</button>
        </div>
        {err && <div role="alert" className="p-5 text-none text-[13px]">{err}</div>}
        {!d && !err && <div className="p-5" aria-busy="true"><div className="h-40 shimmer" /></div>}
        {d && (
          <div className="p-5">
            <div className="grid grid-cols-[120px_1fr_1fr] sm:grid-cols-[180px_1fr_1fr] gap-x-4 text-[12.5px]">
              <div />
              <div className="pb-2"><div className="eyebrow">Competitor</div><div className="font-semibold">{d.competitor.brand ? `${d.competitor.brand} · ` : ""}{d.competitor.manufacturer}</div><div className="text-ink-2">{d.competitor.description}</div>{d.competitor.gudidUrl && <a className="text-accent text-[12px]" href={d.competitor.gudidUrl} target="_blank" rel="noreferrer">GUDID record ↗</a>}</div>
              <div className="pb-2"><div className="eyebrow">{us}</div><div className="font-semibold"><span className="mono">{d.ours.sku}</span>{d.ours.brand ? ` · ${d.ours.brand}` : ""}</div><div className="text-ink-2">{d.ours.description}</div>{d.ours.gudidUrl && <a className="text-accent text-[12px]" href={d.ours.gudidUrl} target="_blank" rel="noreferrer">GUDID record ↗</a>}{d.candidate.unitPrice != null && <div className="mono text-[12px] mt-0.5">{money(d.candidate.unitPrice)} / unit</div>}</div>
            </div>
            {groups.map((g) => (
              <div key={g} className="mt-3">
                <div className="eyebrow mb-1">{g === "Bin" ? "Attribute bin (what the matcher compared)" : "GUDID"}</div>
                <table className="table !text-[12.5px]">
                  <tbody>
                    {d.rows.filter((r) => r.group === g).map((r) => (
                      <tr key={r.attribute} className={r.same === false ? "bg-alt-soft/40" : ""}>
                        <td className="w-[180px] text-muted">{r.attribute}</td>
                        <td className={r.same === false ? "text-alt" : ""}>{r.competitor ?? <span className="text-faint">—</span>}</td>
                        <td className={r.same === false ? "text-alt" : r.same ? "text-exact" : ""}>{r.ours ?? <span className="text-faint">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {d.candidate.rationale && <div className="mt-3 text-[12.5px] italic text-muted">{d.candidate.rationale}</div>}
            {d.candidate.additionalProducts && <div className="mt-1 text-[12px]"><span className="text-muted">Also needs:</span> <span className="mono">{d.candidate.additionalProducts}</span></div>}
          </div>
        )}
      </div>
    </div>
  );
}

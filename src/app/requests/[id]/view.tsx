"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Chip, MatchChip, ScoreBar, StatusPill, Stat, money, num, relTime, Empty } from "@/components/ui";
import type { Bin } from "@/lib/match/bin";

type Candidate = { id: string; rank: number; matchType: string; source: string; score: number; scoreBin: number | null; scorePrice: number | null; scoreCogs: number | null; scoreMargin: number | null; factorsJson: string | null; rationale: string | null; additionalProducts: string | null; unitPrice: number | null; ownProduct: { id: string; sku: string; description: string; category: string | null; brand: string | null; binJson: string | null; listPrice: number | null; cogs: number | null; gudidDi: string | null; status: string | null } };
type Competitor = { id: string; cfnNorm: string; cfnMatched: string | null; manufacturer: string | null; brand: string | null; description: string | null; gudidDi: string | null; gmdnName: string | null; status: string | null; resolution: string; resolutionNote: string | null; confidence: number | null; alternatesJson: string | null; binJson: string | null; binSource: string | null };
type Line = { id: string; lineNo: number; rawCode: string; cfnNorm: string; quantity: number; estCompetitorPrice: number | null; resolutionStatus: string; resolutionNote: string | null; matchStatus: string; selectedCandidateId: string | null; overrideNote: string | null; reviewed: boolean; competitorProduct: Competitor | null; candidates: Candidate[] };
type RequestData = { id: string; reference: string; accountName: string | null; accountNumber: string | null; accountType: string | null; reportType: string; status: string; stage: string | null; progress: number; error: string | null; useLlm: boolean; sourceFileName: string | null; createdAt: string; completedAt: string | null; llmAvailable: boolean; modelStatus: { requested: boolean; used: boolean; model: string; error?: string } | null; google: { configured: boolean; canWrite: boolean; email: string | null }; sourceUrl: string | null; xrefSheetUrl: string | null; offerSheetUrl: string | null; company: { name: string }; pricebook: { name: string } | null; lines: Line[]; summary: { total: number; resolved: number; matched: number; exact: number; close: number; alternative: number; reviewed: number; ourExtended: number; competitorExtended: number; priced: number }; log: { t: string; m: string }[] };

type Filter = "all" | "attention" | "exact" | "close" | "alt" | "retain";

export function RequestView({ id }: { id: string }) {
  const [data, setData] = useState<RequestData | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/requests/${id}`, { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data || !["running", "queued"].includes(data.status)) return;
    const t = setInterval(load, 1200);
    return () => clearInterval(t);
  }, [data, load]);

  const us = data?.company.name ?? "Our";

  const lines = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.lines.filter((l) => {
      const sel = l.candidates.find((c) => c.id === l.selectedCandidateId);
      const cp = l.competitorProduct;
      if (filter === "attention" && !(l.resolutionStatus !== "resolved" || !sel || (cp?.confidence ?? 1) < 0.75)) return false;
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

  async function patchLine(lineId: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/requests/${id}/lines/${lineId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) load();
  }
  async function rerun(useLlm?: boolean, freshGrades = false) {
    await fetch(`/api/requests/${id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(useLlm == null ? {} : { useLlm }), freshGrades }) });
    load();
  }
  async function chooseAlternate(cp: Competitor, di: string) {
    await fetch(`/api/competitor/${cp.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ di }) });
    await rerun();
  }

  if (!data) return <div className="space-y-3"><div className="h-8 w-64 rounded shimmer" /><div className="h-24 rounded shimmer" /><div className="h-96 rounded shimmer" /></div>;
  const s = data.summary;
  const running = ["running", "queued"].includes(data.status);
  const attention = data.lines.filter((l) => l.resolutionStatus !== "resolved" || !l.candidates.some((c) => c.id === l.selectedCandidateId) || (l.competitorProduct?.confidence ?? 1) < 0.75).length;
  const retain = data.lines.filter((l) => l.candidates.find((c) => c.id === l.selectedCandidateId)?.source === "identity").length;

  return (
    <>
      <div className="flex items-start justify-between gap-6 mb-5">
        <div>
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
        <div className="flex items-center gap-2 shrink-0">
          <button className="btn-secondary" onClick={() => rerun()} disabled={running} title="Replays cached model verdicts for unchanged lines — results cannot flip">{running ? "Running…" : "Re-run"}</button>
          {data.llmAvailable && <button className="btn-ghost" onClick={() => rerun(undefined, true)} disabled={running} title="Ask the model again for every line (ignores cached verdicts)">Re-grade fresh</button>}
          <ExportMenu id={id} />
          <SheetsButton id={id} google={data.google} xrefUrl={data.xrefSheetUrl} offerUrl={data.offerSheetUrl} onDone={load} />
          {data.status === "complete" && <CreateProposal requestId={id} />}
        </div>
      </div>

      {running && (
        <div className="card px-5 py-4 mb-4">
          <div className="flex items-center justify-between text-[13px] mb-2">
            <div className="flex items-center gap-2 font-medium"><span className="h-2 w-2 rounded-full bg-info pulse-dot" />{data.stage ?? "Queued"}</div>
            <span className="mono text-muted">{data.progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-line-2 overflow-hidden"><div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${data.progress}%` }} /></div>
        </div>
      )}
      {data.status === "failed" && <div className="rounded-lg bg-none-soft text-none px-4 py-3 mb-4 text-[13px]"><b>Run failed:</b> {data.error}</div>}
      {data.modelStatus?.requested && !data.modelStatus.used && (
        <div className="rounded-lg bg-alt-soft text-alt px-4 py-3 mb-4 text-[13px]">
          <b>The model was not used on this run</b> — it fell back to heuristic matching. {data.modelStatus.error}
          <span className="block text-[12px] mt-1 opacity-90">Fix <span className="mono">OPENAI_API_KEY</span> / <span className="mono">LLM_MODEL</span> in .env, restart the server, then Re-run. Settings → Model shows every call and its error.</span>
        </div>
      )}

      <div className="grid grid-cols-6 gap-3 mb-5">
        <Stat label="Lines" value={s.total} hint={`${num(data.lines.reduce((a, l) => a + l.quantity, 0))} units`} />
        <Stat label="Resolved in GUDID" value={`${s.resolved}/${s.total}`} tone="accent" hint={s.total ? `${Math.round((s.resolved / s.total) * 100)}%` : ""} />
        <Stat label="Matched" value={s.matched} hint={<span><span className="text-exact">{s.exact} exact</span> · <span className="text-close">{s.close} close</span> · <span className="text-alt">{s.alternative} alt</span></span>} />
        <Stat label="Needs attention" value={attention} tone={attention ? "alt" : "exact"} hint={retain ? `${retain} already ours` : "unresolved, unmatched, low confidence"} />
        <Stat label={`${us} extended`} value={money(s.ourExtended, { compact: true })} hint={`${s.priced} of ${s.matched} priced`} />
        <Stat label="Reviewed" value={`${s.reviewed}/${s.total}`} hint="rep sign-off" />
      </div>

      <Card padded={false}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2">
          <div className="flex items-center gap-1">
            {([["all", "All", data.lines.length], ["attention", "Needs attention", attention], ["exact", "Exact", s.exact], ["close", "Close", s.close], ["alt", "Alternative", s.alternative], ["retain", "Already ours", retain]] as [Filter, string, number][]).map(([k, label, n]) => (
              <button key={k} onClick={() => setFilter(k)} className={`rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${filter === k ? "bg-ink text-white" : "text-ink-2 hover:bg-line-2"}`}>{label} <span className={`mono ${filter === k ? "text-white/70" : "text-muted"}`}>{n}</span></button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input className="input w-[260px]" placeholder="Search code, product, manufacturer…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-ghost" onClick={() => setOpen(open.size ? new Set() : new Set(lines.map((l) => l.id)))}>{open.size ? "Collapse all" : "Expand all"}</button>
          </div>
        </div>
        {lines.length === 0 ? (
          <Empty title={running ? "Working…" : "Nothing here"}>{running ? "Results appear as each stage completes." : "Try another filter."}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="w-8"></th>
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
                    onPrice={(v) => patchLine(l.id, { estCompetitorPrice: v })}
                    onAlternate={(di) => cp && chooseAlternate(cp, di)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-4">
        <button className="btn-ghost text-[12.5px]" onClick={() => setShowLog(!showLog)}>{showLog ? "Hide" : "Show"} run log ({data.log.length})</button>
        {showLog && (
          <div className="card mt-2 p-4 mono text-[12px] text-ink-2 space-y-1 max-h-72 overflow-auto">
            {data.log.map((e, i) => <div key={i}><span className="text-faint">{new Date(e.t).toLocaleTimeString()}</span>  {e.m}</div>)}
          </div>
        )}
      </div>
    </>
  );
}

function LineRows({ l, cp, sel, isOpen, notFound, lowConf, us, toggle, onSelect, onReviewed, onNote, onPrice, onAlternate }: {
  l: Line; cp: Competitor | null; sel: Candidate | null; isOpen: boolean; notFound: boolean; lowConf: boolean; us: string;
  toggle: () => void; onSelect: (id: string | null) => void; onReviewed: (v: boolean) => void; onNote: (v: string) => void; onPrice: (v: number | null) => void; onAlternate: (di: string) => void;
}) {
  const [note, setNote] = useState(l.overrideNote ?? "");
  const [price, setPrice] = useState(l.estCompetitorPrice != null ? String(l.estCompetitorPrice) : "");
  const compBin = parseBinSafe(cp?.binJson);
  const alternates: { company: string; brand: string; cfn: string; description: string; status: string; key: string }[] = cp?.alternatesJson ? JSON.parse(cp.alternatesJson) : [];
  const ext = sel?.unitPrice != null ? sel.unitPrice * l.quantity : null;
  return (
    <>
      <tr className={isOpen ? "bg-panel-2" : ""}>
        <td className="cursor-pointer text-muted" onClick={toggle}><Chevron open={isOpen} /></td>
        <td className="mono text-muted">{l.lineNo}</td>
        <td className="cursor-pointer" onClick={toggle}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono font-semibold">{l.rawCode}</span>
            {cp?.cfnMatched && cp.cfnMatched !== l.cfnNorm && <span className="mono text-[11px] text-muted">→ {cp.cfnMatched}</span>}
            {notFound ? <Chip tone="none">Not in GUDID</Chip> : lowConf ? <Chip tone="alt">Verify · {Math.round((cp?.confidence ?? 0) * 100)}%</Chip> : cp?.resolution === "manual" ? <Chip tone="info">Rep-corrected</Chip> : null}
            {cp?.status && /not in/i.test(cp.status) && <Chip tone="alt">Discontinued</Chip>}
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
                {sel.source === "known-cross" && <Chip>Curated</Chip>}
                {l.candidates.length > 1 && <span className="text-[11.5px] text-muted">+{l.candidates.length - 1} more</span>}
              </div>
              <div className="text-[12.5px] text-ink-2 mt-0.5 line-clamp-2">{sel.ownProduct.description}</div>
            </>
          ) : (
            <div className="text-muted text-[12.5px]">{notFound ? "Resolve the competitor product first" : l.candidates.length ? "No acceptable match — review candidates" : "No candidates in catalog"}</div>
          )}
        </td>
        <td>{sel ? <ScoreBar value={sel.score} tone={sel.matchType === "Exact Match" ? "exact" : sel.matchType === "Alternative Match" ? "alt" : "accent"} /> : null}</td>
        <td className="mono text-right">{sel ? money(sel.unitPrice) : ""}</td>
        <td className="mono text-right">{sel ? money(ext) : ""}</td>
        <td className="text-center"><input type="checkbox" className="accent-[var(--accent)] h-4 w-4" checked={l.reviewed} onChange={(e) => onReviewed(e.target.checked)} /></td>
      </tr>
      {isOpen && (
        <tr className="bg-panel-2">
          <td colSpan={9} className="!p-0">
            <div className="grid grid-cols-[1fr_1.4fr] gap-0 border-t border-line-2">
              {/* Competitor pane */}
              <div className="p-5 border-r border-line-2">
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
                              <button className="text-accent font-medium shrink-0" onClick={() => onAlternate(a.key)}>Use this</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[12.5px] text-muted">{cp?.resolutionNote ?? l.resolutionNote ?? "This code could not be found in GUDID."} {cp?.manufacturer && <div className="mt-1">Model's guess: <b>{cp.manufacturer}</b> — {cp.description}</div>}</div>
                )}
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Est. competitor unit price</label>
                    <input className="input mono" placeholder="—" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={() => onPrice(price === "" ? null : Number(price))} />
                  </div>
                  <div>
                    <label className="label">Rep note</label>
                    <input className="input" placeholder="Why you chose this" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => onNote(note)} />
                  </div>
                </div>
              </div>
              {/* Candidates pane */}
              <div className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="eyebrow">{us} candidates</div>
                  {sel && <button className="text-[12px] text-muted hover:text-none" onClick={() => onSelect(null)}>Clear selection</button>}
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

function CandidateRow({ c, lineId, selected, qty, onSelect, compBin }: { c: Candidate; lineId: string; selected: boolean; qty: number; onSelect: () => void; compBin: Bin | null }) {
  const [more, setMore] = useState(false);
  const factors: { used: string[]; notes: string[] } | null = c.factorsJson ? JSON.parse(c.factorsJson) : null;
  const bin = parseBinSafe(c.ownProduct.binJson);
  return (
    <li className={`rounded-lg border px-3.5 py-3 bg-panel transition-colors ${selected ? "border-accent ring-2 ring-accent/15" : "border-line hover:border-faint"}`}>
      <div className="flex items-start gap-3">
        <input type="radio" name={`cand-${lineId}`} className="mt-1 accent-[var(--accent)]" checked={selected} onChange={onSelect} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-[11px] text-muted">#{c.rank}</span>
            <span className="mono font-semibold">{c.ownProduct.sku}</span>
            <MatchChip type={c.matchType} />
            {c.source === "identity" && <Chip tone="info">Already ours</Chip>}
            {c.source === "known-cross" && <Chip>Curated cross</Chip>}
            {c.ownProduct.status && /not in/i.test(c.ownProduct.status) && <Chip tone="alt">Discontinued</Chip>}
            <span className="ml-auto mono text-[12.5px]">{money(c.unitPrice)}{c.unitPrice != null && <span className="text-muted"> · {money(c.unitPrice * qty)}</span>}</span>
          </div>
          <div className="text-[12.5px] text-ink-2 mt-0.5">{c.ownProduct.description}</div>
          {c.rationale && <div className="text-[12.5px] text-muted mt-1 italic">{c.rationale}</div>}
          {c.additionalProducts && <div className="text-[12px] mt-1"><span className="text-muted">Also needs:</span> <span className="mono">{c.additionalProducts}</span></div>}
          <div className="flex items-center gap-4 mt-2 text-[11.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1.5">Fit <ScoreBar value={c.scoreBin} width={48} /></span>
            <span className="flex items-center gap-1.5">Price <ScoreBar value={c.scorePrice} width={48} tone={c.scorePrice == null ? "none" : "accent"} /></span>
            <span className="flex items-center gap-1.5">Cost <ScoreBar value={c.scoreCogs} width={48} /></span>
            <span className="flex items-center gap-1.5">Margin <ScoreBar value={c.scoreMargin} width={48} /></span>
            <span className="flex items-center gap-1.5 font-medium text-ink-2">Overall <ScoreBar value={c.score} width={48} /></span>
            <button className="ml-auto text-accent font-medium" onClick={() => setMore(!more)}>{more ? "Hide attributes" : "Compare attributes"}</button>
          </div>
          {more && bin && (
            <div className="mt-3 grid grid-cols-2 gap-3">
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
  const items: [string, string][] = [
    ["Cross-reference workbook (.xlsx)", `/api/requests/${id}/export?type=xref`],
    ["Cross-reference sheet (.csv)", `/api/requests/${id}/export?type=xref&format=csv`],
    ["Contract offer (.xlsx)", `/api/requests/${id}/export?type=offer`],
    ["Contract offer (.csv)", `/api/requests/${id}/export?type=offer&format=csv`],
  ];
  return (
    <div className="relative">
      <button className="btn-secondary" onClick={() => setOpen(!open)}><IconDownload /> Download <span className="text-muted">▾</span></button>
      {open && (
        <div className="absolute right-0 top-11 z-20 w-[300px] card p-1.5" style={{ boxShadow: "var(--shadow-lg)" }} onMouseLeave={() => setOpen(false)}>
          {items.map(([label, href]) => <a key={href} href={href} className="block rounded-md px-3 py-2 text-[13px] hover:bg-line-2" onClick={() => setOpen(false)}>{label}</a>)}
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
  async function send() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/requests/${id}/sheets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(data.error); return; }
    setOpen(true);
    onDone();
  }
  return (
    <div className="relative">
      {google.canWrite ? (
        <button className="btn-primary" onClick={xrefUrl || offerUrl ? () => setOpen(!open) : send} disabled={busy}>
          <IconSheets /> {busy ? "Writing to Drive…" : xrefUrl || offerUrl ? "Google Sheets" : "Send to Google Sheets"}
        </button>
      ) : (
        <button className="btn-primary" onClick={() => setOpen(!open)}><IconSheets /> Google Sheets</button>
      )}
      {open && (
        <div className="absolute right-0 top-11 z-20 w-[340px] card p-4 text-[13px]" style={{ boxShadow: "var(--shadow-lg)" }}>
          {google.canWrite ? (
            <>
              <div className="font-semibold mb-2">In your Drive folder</div>
              {xrefUrl ? <a className="block text-accent font-medium mb-1" href={xrefUrl} target="_blank" rel="noreferrer">Open cross-reference sheet ↗</a> : null}
              {offerUrl ? <a className="block text-accent font-medium mb-1" href={offerUrl} target="_blank" rel="noreferrer">Open contract offer sheet ↗</a> : null}
              <button className="btn-secondary mt-2 w-full justify-center" onClick={send} disabled={busy}>{busy ? "Writing…" : "Write fresh copies"}</button>
              {err && <div className="text-none mt-2 text-[12.5px]">{err}</div>}
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
  return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="2.5" width="12" height="15" rx="1.5" /><path d="M7 8h6M7 11h6M7 14h6M10 8v6" strokeLinecap="round" /></svg>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={`transition-transform ${open ? "rotate-90" : ""}`}><path d="M7 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconDownload() {
  return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 15v1a1 1 0 001 1h10a1 1 0 001-1v-1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}


/** Hand the cross-reference to the commercial workspace: waterfall pricing, competitor intelligence, recommendations, approvals. */
function CreateProposal({ requestId }: { requestId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setErr(j.error ?? "Could not create proposal"); return; }
    window.location.href = `/proposals/${j.id}`;
  }
  return (
    <span className="relative">
      <button className="btn-primary" onClick={go} disabled={busy} title="Creates a versioned proposal: applicable contract prices, competitor intelligence, recommended prices and approval requirements for every selected line">{busy ? "Pricing…" : "Create proposal"}</button>
      {err && <span className="absolute right-0 top-11 w-64 text-[11.5px] text-none bg-none-soft rounded px-2 py-1">{err}</span>}
    </span>
  );
}

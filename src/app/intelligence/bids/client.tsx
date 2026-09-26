"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, Empty, Chip } from "@/components/ui";
import { fmtMoney } from "@/components/commercial";
import { needs, usePermissions } from "@/components/permissions";

type Award = { id: string; source: string; externalId: string; title: string | null; agency: string | null; awardee: string | null; naics: string | null; psc: string | null; amount: string | null; awardDate: string | null; url: string | null; competitorName: string | null; keywordsMatched: string | null; importedAt: string };
type Run = { id: string; feed: string; status: string; trigger: string; rows: number; created: number; updated: number; error: string | null; startedAt: string; finishedAt: string | null };
type Data = { awards: Award[]; runs: Run[]; totals: { source: string; count: number }[]; competitors: { id: string; name: string }[]; settings: { keywords: string[]; naics: string[]; psc: string[]; lookbackDays: number; minAmount: number }; sources: { source: string; configured: boolean; note: string }[]; queue: boolean };

export function PublicBids() {
  const { can } = usePermissions();
  const canPull = can("import_competitor_pricing");
  const canConfigure = can("configure_settings");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [q, setQ] = useState(""); const [source, setSource] = useState(""); const [competitorId, setCompetitorId] = useState("");
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [settings, setSettings] = useState({ keywords: "", naics: "", psc: "", lookbackDays: "30", minAmount: "0" });
  const [portal, setPortal] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async (reloadSettings = false) => {
    const mine = ++seq.current;
    let r: Response, j: Data & { error?: string };
    try { r = await fetch(`/api/intelligence/bids?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}&competitorId=${encodeURIComponent(competitorId)}`, { cache: "no-store" }); j = await r.json().catch(() => ({})); }
    catch { if (mine === seq.current) setErr("Could not reach the server"); return; }
    if (mine !== seq.current) return; // a newer search already answered
    if (!r.ok) { setErr(j.error ?? `Could not load (${r.status})`); return; }
    setData(j);
    // The settings form is filled once (and after a save), never on every search keystroke — that would wipe edits in progress.
    if (!settingsLoaded || reloadSettings) { setSettings({ keywords: j.settings.keywords.join(", "), naics: j.settings.naics.join(", "), psc: j.settings.psc.join(", "), lookbackDays: String(j.settings.lookbackDays), minAmount: String(j.settings.minAmount) }); setSettingsLoaded(true); }
  }, [q, source, competitorId, settingsLoaded]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  async function post(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await fetch("/api/intelligence/bids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) setErr(j.error ?? `Request failed (${r.status})`); else { setMsg(j.note ?? "Saved."); load(body.action === "settings"); } }
    catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  async function importFile(f: File) {
    if (busy) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const fd = new FormData(); fd.append("file", f); if (portal) fd.append("portal", portal);
      const r = await fetch("/api/intelligence/bids/import", { method: "POST", body: fd }); const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.error ?? `Import failed (${r.status})`); else { setMsg(`${j.awards} award rows, ${j.observations} price observations from ${j.rows} rows${j.skipped?.length ? `; ${j.skipped.length} skipped (${j.skipped.slice(0, 3).map((s: { row: number; reason: string }) => `row ${s.row}: ${s.reason}`).join("; ")})` : ""}`); load(); }
    } catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader eyebrow="Competitive intelligence" title="Public bids and awards" description="Who won what in the public sector: SAM.gov award notices, USAspending contract awards, and bid tabulations you save from state or hospital-system portals. Line prices found in bid files become price observations (source: public bid database)." />
      <div className="text-[12.5px] mb-4"><Link className="text-accent" href="/intelligence">← Competitor pricing</Link></div>
      {err && <div role="alert" className="mb-4 rounded-lg bg-none-soft text-none px-4 py-2.5 text-[13px]">{err}</div>}
      {msg && <div role="status" className="mb-4 rounded-lg bg-accent-soft text-accent-ink px-4 py-2.5 text-[13px]">{msg}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        <div className="space-y-4 min-w-0">
          <Card padded={false}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2 flex-wrap">
              <input className="input w-full sm:w-[280px]" aria-label="Search awards" placeholder="Search title, awardee, agency…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="input !w-40" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}><option value="">All sources</option><option value="SAM">SAM.gov</option><option value="USASPENDING">USAspending</option><option value="BIDFILE">Bid files</option></select>
              <select className="input !w-52" aria-label="Awardee" value={competitorId} onChange={(e) => setCompetitorId(e.target.value)}><option value="">Any awardee</option>{(data?.competitors ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <span className="ml-auto text-[12px] text-muted">{(data?.totals ?? []).map((t) => `${t.source} ${t.count}`).join(" · ") || "no awards yet"}</span>
            </div>
            {!data ? <div className="h-40 shimmer" /> : data.awards.length === 0 ? <Empty title="No awards match">Pull a source on the right, or import a bid file.</Empty> : (
              <table className="table !text-[12.5px]"><thead><tr><th>Date</th><th>Title</th><th>Buyer</th><th>Awardee</th><th className="text-right">Amount</th><th>Codes</th><th>Source</th></tr></thead>
                <tbody>{data.awards.map((a) => (
                  <tr key={a.id}>
                    <td className="mono whitespace-nowrap">{a.awardDate ? a.awardDate.slice(0, 10) : <span className="text-muted">—</span>}</td>
                    <td className="max-w-[360px]"><div className="line-clamp-2">{a.url ? <a className="text-accent" href={a.url} target="_blank" rel="noreferrer">{a.title ?? a.externalId}</a> : a.title ?? a.externalId}</div>{a.keywordsMatched && <div className="text-[11px] text-muted">{a.keywordsMatched}</div>}</td>
                    <td className="max-w-[220px]"><div className="line-clamp-2">{a.agency ?? "—"}</div></td>
                    <td>{a.awardee ?? "—"}{a.competitorName && <div><Chip tone="alt">{a.competitorName}</Chip></div>}</td>
                    <td className="mono text-right whitespace-nowrap">{a.amount ? fmtMoney(a.amount, "USD", { compact: true }) : "—"}</td>
                    <td className="mono text-[11px] text-muted">{[a.naics && `N ${a.naics}`, a.psc && `P ${a.psc}`].filter(Boolean).join(" · ")}</td>
                    <td><Chip>{a.source}</Chip></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card padded={false} title="Recent pulls">
            {!data?.runs.length ? <div className="p-4 text-[12.5px] text-muted">No pulls yet.</div> : (
              <table className="table !text-[12.5px]"><thead><tr><th>Source</th><th>When</th><th>Status</th><th className="text-right">Rows</th><th className="text-right">New</th><th className="text-right">Updated</th><th>Error</th></tr></thead>
                <tbody>{data.runs.map((r) => <tr key={r.id}><td className="mono">{r.feed.replace("bids-", "")}</td><td className="whitespace-nowrap">{new Date(r.startedAt).toLocaleString()} <span className="text-muted">({r.trigger})</span></td><td><Chip tone={r.status === "OK" ? "exact" : r.status === "FAILED" ? "none" : "alt"}>{r.status}</Chip></td><td className="mono text-right">{r.rows}</td><td className="mono text-right">{r.created}</td><td className="mono text-right">{r.updated}</td><td className="text-[11.5px] text-none max-w-[280px] truncate">{r.error ?? ""}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Pull now" subtitle="Runs in the background; scheduled daily (BIDS_CRON)">
            <div className="space-y-2">
              {(data?.sources ?? []).map((s) => (
                <div key={s.source} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <div><div className="font-medium">{s.source === "sam" ? "SAM.gov" : "USAspending"}</div><div className="text-muted text-[11.5px]">{s.note}</div></div>
                  <button type="button" className="btn-secondary" disabled={busy || !canPull || !s.configured || !data?.queue} onClick={() => post({ action: "pull", source: s.source })} title={!canPull ? needs("import_competitor_pricing") : !s.configured ? "Not configured on this server" : !data?.queue ? "The job queue is off" : "Once per hour per source; the last pull's time is in the table"}>Pull</button>
                </div>
              ))}
              {data && !data.queue && <div className="text-[11.5px] text-alt">The job queue is off on this server (JOBS_WORKER=off).</div>}
            </div>
          </Card>
          <Card title="What to look for" subtitle="Keywords match titles; NAICS / PSC filter the pull">
            <div className="space-y-2 text-[12.5px]">
              <label className="label" htmlFor="bids-keywords">Keywords (comma-separated)</label><textarea id="bids-keywords" className="input min-h-[64px]" disabled={!canConfigure} value={settings.keywords} onChange={(e) => setSettings({ ...settings, keywords: e.target.value })} />
              <label className="label" htmlFor="bids-naics">NAICS codes</label><input id="bids-naics" className="input mono" disabled={!canConfigure} value={settings.naics} onChange={(e) => setSettings({ ...settings, naics: e.target.value })} />
              <label className="label" htmlFor="bids-psc">PSC codes</label><input id="bids-psc" className="input mono" disabled={!canConfigure} value={settings.psc} onChange={(e) => setSettings({ ...settings, psc: e.target.value })} />
              <div className="grid grid-cols-2 gap-2"><div><label className="label" htmlFor="bids-lookback">Look back (days)</label><input id="bids-lookback" className="input mono" disabled={!canConfigure} value={settings.lookbackDays} onChange={(e) => setSettings({ ...settings, lookbackDays: e.target.value })} /></div><div><label className="label" htmlFor="bids-min">Min amount</label><input id="bids-min" className="input mono" disabled={!canConfigure} value={settings.minAmount} onChange={(e) => setSettings({ ...settings, minAmount: e.target.value })} /></div></div>
              <button type="button" className="btn-primary w-full justify-center" disabled={busy || !canConfigure} title={canConfigure ? undefined : needs("configure_settings")} onClick={() => post({ action: "settings", settings: { keywords: settings.keywords, naics: settings.naics, psc: settings.psc, lookbackDays: Number(settings.lookbackDays), minAmount: Number(settings.minAmount) } })}>Save</button>
            </div>
          </Card>
          <Card title="Import a bid file" subtitle="A tabulation saved from a state or hospital-system portal (CSV / XLSX)">
            <div className="space-y-2 text-[12.5px]">
              <input className="input" aria-label="Portal name" placeholder="Portal name (optional, e.g. BidNet, Texas SmartBuy)" value={portal} onChange={(e) => setPortal(e.target.value)} />
              <input type="file" accept=".csv,.xlsx" aria-label="Bid file" className="text-[12px]" disabled={!canPull || busy} title={canPull ? undefined : needs("import_competitor_pricing")} onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />
              <div className="text-[11.5px] text-muted">Columns (loose): Source, Bid Id, Title, Buyer, Awardee, Award Date, Amount, NAICS, Competitor, Competitor Code, Unit Price, Qty, UOM, URL, Notes. Rows with a competitor code and unit price also record a price observation.</div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

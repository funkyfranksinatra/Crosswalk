"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Chip, Empty, relTime } from "@/components/ui";

type Size = { type?: string; value?: string; unit?: string; text?: string };
type Row = { id: string; recordKey: string; code: string; catalogNumber: string | null; versionModel: string | null; brand: string | null; description: string | null; manufacturer: string; labeler: string; gmdnName: string | null; fdaProductCode: string | null; status: string | null; family: string | null; sizes: Size[]; primaryDi: string | null; singleUse: boolean | null; sterile: boolean | null; implantable: boolean | null; isOwn: boolean; inCatalog: boolean };

function sizeText(s: Size) {
  if (s.text) return s.text;
  return [s.type, s.value, s.unit].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------------------------ */
/* Lookup table                                                                          */
/* ------------------------------------------------------------------------------------ */

export function LibraryTable({ rows, manufacturers, families, q, mfr, fam, matched, canManage }: { rows: Row[]; manufacturers: { name: string; count: number }[]; families: { name: string; count: number }[]; q: string; mfr: string; fam: string; matched: number; canManage: boolean }) {
  const router = useRouter();
  const [search, setSearch] = useState(q);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) router.push(`/catalog/gudid?${new URLSearchParams({ q: search, mfr, fam }).toString()}`); }, 300);
    return () => clearTimeout(t);
  }, [search, q, mfr, fam, router]);
  const nav = (patch: Record<string, string>) => router.push(`/catalog/gudid?${new URLSearchParams({ q, mfr, fam, ...patch }).toString()}`);

  async function adopt(r: Row) {
    setBusy(r.id); setMsg(null);
    const res = await fetch("/api/catalog/gudid/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordKeys: [r.recordKey] }) }).then((x) => x.json());
    setBusy(null);
    setMsg(res.error ? res.error : res.added ? `${r.code} added to our catalog` : `${r.code} is already in our catalog`);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2 flex-wrap">
        <select className="input w-auto" value={mfr} onChange={(e) => nav({ mfr: e.target.value })}>
          <option value="">All manufacturers</option>
          {manufacturers.map((m) => <option key={m.name} value={m.name}>{m.name} ({m.count.toLocaleString()})</option>)}
        </select>
        <select className="input w-auto" value={fam} onChange={(e) => nav({ fam: e.target.value })}>
          <option value="">All families</option>
          {families.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.count.toLocaleString()})</option>)}
        </select>
        <input className="input w-[320px]" placeholder="Catalog number, DI, brand, description, GMDN…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="ml-auto text-[12.5px] text-muted">{Math.min(rows.length, matched).toLocaleString()} of {matched.toLocaleString()}</span>
      </div>
      {msg && <div className="mx-4 mt-3 rounded-md bg-accent-soft text-accent-ink px-3 py-2 text-[12.5px]">{msg}</div>}
      {rows.length === 0 ? (
        <Empty title={q || mfr || fam ? "Nothing in the library matches" : "The library is empty"}>{q || mfr || fam ? "The cross-reference engine still asks openFDA live for codes the library does not hold." : "Import a labeler (Ethicon, Covidien, Applied Medical…) to fill it."}</Empty>
      ) : (
        <table className="table">
          <thead><tr><th>Code</th><th>Product</th><th>Manufacturer</th><th>Family</th><th>Sizes</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = open === r.id;
              const discontinued = r.status ? /not in/i.test(r.status) : false;
              return (
                <RowGroup key={r.id} r={r} isOpen={isOpen} discontinued={discontinued} onToggle={() => setOpen(isOpen ? null : r.id)} canManage={canManage} busy={busy === r.id} onAdopt={() => adopt(r)} />
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function RowGroup({ r, isOpen, discontinued, onToggle, canManage, busy, onAdopt }: { r: Row; isOpen: boolean; discontinued: boolean; onToggle: () => void; canManage: boolean; busy: boolean; onAdopt: () => void }) {
  return (
    <>
      <tr className={`cursor-pointer ${isOpen ? "bg-panel-2" : ""}`} onClick={onToggle}>
        <td><span className="mono font-semibold">{r.code}</span>{r.brand && <div className="text-[11.5px] text-muted">{r.brand}</div>}</td>
        <td className="max-w-[440px]"><div className="line-clamp-2">{r.description ?? "—"}</div>{r.gmdnName && <div className="text-[11.5px] text-muted">{r.gmdnName}</div>}</td>
        <td>{r.manufacturer}{r.isOwn && <Chip tone="accent" className="ml-1.5">us</Chip>}</td>
        <td className="text-ink-2">{r.family ?? "—"}</td>
        <td className="text-[12px] text-ink-2 max-w-[220px]"><div className="line-clamp-2">{r.sizes.length ? r.sizes.map(sizeText).join(" · ") : "—"}</div></td>
        <td>{discontinued ? <Chip tone="alt">Discontinued</Chip> : r.status ? <Chip tone="exact">In distribution</Chip> : "—"}</td>
        <td className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          {r.isOwn && canManage && (r.inCatalog ? <Chip tone="neutral">in catalog</Chip> : <button className="btn-secondary btn-sm" disabled={busy} onClick={onAdopt}>{busy ? "Adding…" : "Add to our catalog"}</button>)}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-panel-2">
          <td colSpan={7} className="!py-3">
            <div className="grid grid-cols-3 gap-4 text-[12.5px]">
              <div>
                <div className="label">GUDID</div>
                <div className="mono">{r.primaryDi ?? "—"}</div>
                {r.primaryDi && <a className="text-accent-ink hover:underline" href={`https://accessgudid.nlm.nih.gov/devices/${encodeURIComponent(r.primaryDi)}`} target="_blank" rel="noreferrer">Open in AccessGUDID ↗</a>}
                <div className="text-muted mt-1">Labeler: {r.labeler}</div>
                <div className="text-muted">FDA product code: {r.fdaProductCode ?? "—"}</div>
              </div>
              <div>
                <div className="label">Codes</div>
                <div>Catalog number: <span className="mono">{r.catalogNumber ?? "—"}</span></div>
                <div>Version / model: <span className="mono">{r.versionModel ?? "—"}</span></div>
                <div className="text-muted mt-1">{[r.singleUse === true ? "single use" : r.singleUse === false ? "reusable" : null, r.sterile === true ? "sterile" : r.sterile === false ? "non-sterile" : null, r.implantable === true ? "implantable" : null].filter(Boolean).join(" · ") || "—"}</div>
              </div>
              <div>
                <div className="label">Sizes</div>
                {r.sizes.length ? <ul className="list-disc pl-4">{r.sizes.map((s, i) => <li key={i}>{sizeText(s)}</li>)}</ul> : <div className="text-muted">GUDID carries no sizes for this record — add one under Catalog → Competitor sizes.</div>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------ */
/* Import panel                                                                          */
/* ------------------------------------------------------------------------------------ */

type Plan = { total: number; existing: number; requests: number; labelers: { term: string; count: number }[]; productCodes: { term: string; count: number }[] };
type Job = { id: string; query: string; status: string; expected: number | null; fetched: number; created: number; updated: number; ownAdded: number; errors: number; log: string; error: string | null };

export function ImportPanel({ families, ownLabelers, running }: { families: string[]; ownLabelers: string[]; running: { id: string; query: string } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"COMPETITOR" | "OWN">("COMPETITOR");
  const [addToOwn, setAddToOwn] = useState(true);
  const [fams, setFams] = useState<string[]>(families.filter((f) => f !== "Other"));
  const [codes, setCodes] = useState("");
  const [inDist, setInDist] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Follow a running job (this one, or one started by someone else).
  const jobId = job?.id ?? running?.id ?? null;
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/catalog/gudid/${jobId}`).then((x) => x.json()).catch(() => null);
      if (stop || !r?.job) return;
      setJob(r.job);
      if (["DONE", "FAILED", "CANCELLED"].includes(r.job.status)) { router.refresh(); return; }
      setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; };
  }, [jobId, router]);

  const productCodes = codes.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);

  async function preview() {
    setPlanning(true); setErr(null); setPlan(null);
    const r = await fetch("/api/catalog/gudid/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, inDistributionOnly: inDist, productCodes }) }).then((x) => x.json());
    setPlanning(false);
    if (r.error) setErr(r.error); else setPlan(r);
  }
  async function start() {
    setErr(null);
    const r = await fetch("/api/catalog/gudid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, kind, addToOwnCatalog: kind === "OWN" && addToOwn, families: kind === "OWN" ? fams : undefined, productCodes, inDistributionOnly: inDist }) }).then((x) => x.json());
    if (r.error) { setErr(r.error); return; }
    setJob({ ...r.job, log: "" });
    setPlan(null);
  }
  async function cancel() {
    if (!jobId) return;
    await fetch(`/api/catalog/gudid/${jobId}`, { method: "DELETE" });
  }

  const active = job && ["QUEUED", "RUNNING"].includes(job.status);
  const pct = job?.expected ? Math.min(100, Math.round((job.fetched / job.expected) * 100)) : null;
  const ownHint = ownLabelers.length ? `our labelers: ${ownLabelers.join(", ")}` : "set our labelers in Settings first";

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        {running && !job && <span className="text-[12.5px] text-muted"><span className="h-2 w-2 rounded-full bg-info pulse-dot inline-block mr-2" />Importing {running.query}…</span>}
        <button className="btn-primary" onClick={() => setOpen(!open)}>Import from GUDID</button>
      </div>
      {open && (
        <div className="absolute right-0 top-12 z-20 w-[520px] card p-5" style={{ boxShadow: "var(--shadow-lg)" }}>
          <div className="font-semibold mb-1">Import a labeler&apos;s catalog</div>
          <p className="text-[12.5px] text-muted mb-3">Pulls every GUDID record whose labeler name contains the text below (openFDA, about 1,000 records per request). Codes already seen are refreshed, new ones are added; the cross-reference engine then resolves those codes without a network call.</p>

          <div className="flex gap-2 mb-2">
            <button className={`btn-secondary btn-sm ${kind === "COMPETITOR" ? "ring-2 ring-accent" : ""}`} onClick={() => setKind("COMPETITOR")}>Competitor</button>
            <button className={`btn-secondary btn-sm ${kind === "OWN" ? "ring-2 ring-accent" : ""}`} onClick={() => setKind("OWN")}>Our own products</button>
          </div>
          <label className="label">Labeler name (as it appears in GUDID)</label>
          <input className="input" placeholder={kind === "OWN" ? (ownLabelers[0] ?? "Covidien") : "Ethicon · Applied Medical · Bard · Gore · Teleflex"} value={query} onChange={(e) => { setQuery(e.target.value); setPlan(null); }} />
          {kind === "OWN" && <div className="text-[11.5px] text-muted mt-1">{ownHint}</div>}

          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={inDist} onChange={(e) => { setInDist(e.target.checked); setPlan(null); }} /> In commercial distribution only</label>
            {kind === "OWN" && <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={addToOwn} onChange={(e) => setAddToOwn(e.target.checked)} /> Add new SKUs to our catalog</label>}
          </div>
          {kind === "OWN" && addToOwn && (
            <div className="mt-2">
              <div className="label">Only add SKUs in these families (keeps the matcher&apos;s candidate pool relevant)</div>
              <div className="flex flex-wrap gap-1.5">
                {families.map((f) => <button key={f} className={`btn-secondary btn-sm ${fams.includes(f) ? "ring-2 ring-accent" : "opacity-60"}`} onClick={() => setFams(fams.includes(f) ? fams.filter((x) => x !== f) : [...fams, f])}>{f}</button>)}
              </div>
            </div>
          )}
          <label className="label mt-3">FDA product codes (optional, e.g. GAM GAW FTL — narrows a large labeler)</label>
          <input className="input mono" placeholder="leave empty for the whole catalog" value={codes} onChange={(e) => { setCodes(e.target.value); setPlan(null); }} />

          {plan && (
            <div className="mt-3 rounded-md bg-panel-2 px-3 py-2 text-[12.5px]">
              <div><b>{plan.total.toLocaleString()}</b> records across {plan.labelers.length} labeler name{plan.labelers.length === 1 ? "" : "s"} · about {plan.requests.toLocaleString()} openFDA requests · {plan.existing.toLocaleString()} already in the library</div>
              <div className="text-muted mt-1 line-clamp-2">{plan.labelers.slice(0, 6).map((l) => `${l.term} (${l.count.toLocaleString()})`).join(" · ")}{plan.labelers.length > 6 ? " …" : ""}</div>
              {plan.productCodes.length > 0 && <div className="text-muted mt-1 line-clamp-2">Product codes: {plan.productCodes.slice(0, 10).map((c) => `${c.term} ${c.count.toLocaleString()}`).join(" · ")}{plan.productCodes.length > 10 ? " …" : ""}</div>}
              {plan.total > 30000 && <div className="text-alt mt-1">Large catalog — consider narrowing by product code. Each record stores its full GUDID JSON.</div>}
            </div>
          )}
          {err && <div className="mt-3 rounded-md bg-alt-soft text-alt px-3 py-2 text-[12.5px]">{err}</div>}

          {job && (
            <div className="mt-3 rounded-md bg-panel-2 px-3 py-2 text-[12.5px]">
              <div className="flex items-center gap-2">
                {active && <span className="h-2 w-2 rounded-full bg-info pulse-dot inline-block" />}
                <span className="font-medium">{job.query}</span>
                <Chip tone={job.status === "DONE" ? "exact" : job.status === "FAILED" ? "alt" : job.status === "CANCELLED" ? "none" : "info"}>{job.status.toLowerCase()}</Chip>
                <span className="ml-auto text-muted">{job.fetched.toLocaleString()}{job.expected ? ` / ${job.expected.toLocaleString()}` : ""}{pct !== null ? ` · ${pct}%` : ""}</span>
              </div>
              {pct !== null && <div className="h-1.5 rounded bg-line-2 mt-2 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>}
              <div className="text-muted mt-1">{job.created.toLocaleString()} new · {job.updated.toLocaleString()} refreshed{job.ownAdded ? ` · ${job.ownAdded.toLocaleString()} added to our catalog` : ""}{job.errors ? ` · ${job.errors} page errors` : ""}</div>
              {job.log && <pre className="mono text-[11px] text-muted mt-2 max-h-24 overflow-auto whitespace-pre-wrap">{job.log.trim().split("\n").slice(-4).join("\n")}</pre>}
            </div>
          )}

          <div className="flex justify-end gap-2 mt-3">
            <button className="btn-ghost" onClick={() => setOpen(false)}>Close</button>
            {active ? <button className="btn-secondary" onClick={cancel}>Cancel import</button> : (
              <>
                <button className="btn-secondary" disabled={planning || query.trim().length < 3} onClick={preview}>{planning ? "Counting…" : "Preview count"}</button>
                <button className="btn-primary" disabled={query.trim().length < 3 || Boolean(running && !job)} onClick={start}>Start import</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */
/* History                                                                               */
/* ------------------------------------------------------------------------------------ */

type ImportRow = { id: string; query: string; kind: string; status: string; expected: number | null; fetched: number; created: number; updated: number; ownAdded: number; errors: number; addToOwnCatalog: boolean; startedAt: string; finishedAt: string | null; startedBy: string | null; log: string; error: string | null };

export function ImportHistory({ imports, canManage }: { imports: ImportRow[]; canManage: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const router = useRouter();
  if (imports.length === 0) return null;
  async function cancel(id: string) {
    await fetch(`/api/catalog/gudid/${id}`, { method: "DELETE" });
    setTimeout(() => router.refresh(), 1500);
  }
  return (
    <div className="card" >
      <div className="px-4 py-3 border-b border-line-2 font-semibold text-[13px]">Import history</div>
      <table className="table">
        <thead><tr><th>Labeler query</th><th>Kind</th><th>Status</th><th className="text-right">Records</th><th className="text-right">New</th><th className="text-right">Refreshed</th><th className="text-right">To our catalog</th><th>Started</th><th></th></tr></thead>
        <tbody>
          {imports.map((i) => {
            const active = i.status === "RUNNING" || i.status === "QUEUED";
            const isOpen = open === i.id;
            return (
              <Fragment key={i.id}>
                <tr className={`cursor-pointer ${isOpen ? "bg-panel-2" : ""}`} onClick={() => setOpen(isOpen ? null : i.id)}>
                  <td className="font-medium">{i.query}</td>
                  <td className="text-ink-2">{i.kind === "OWN" ? "Our products" : "Competitor"}</td>
                  <td><Chip tone={i.status === "DONE" ? "exact" : i.status === "FAILED" ? "alt" : active ? "info" : "none"}>{i.status.toLowerCase()}</Chip></td>
                  <td className="text-right mono">{i.fetched.toLocaleString()}{i.expected ? <span className="text-muted"> / {i.expected.toLocaleString()}</span> : null}</td>
                  <td className="text-right mono">{i.created.toLocaleString()}</td>
                  <td className="text-right mono">{i.updated.toLocaleString()}</td>
                  <td className="text-right mono">{i.addToOwnCatalog ? i.ownAdded.toLocaleString() : "—"}</td>
                  <td className="text-muted text-[12px]">{relTime(i.startedAt)}{i.startedBy ? ` · ${i.startedBy}` : ""}</td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>{active && canManage && <button className="btn-ghost btn-sm" onClick={() => cancel(i.id)}>Cancel</button>}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-panel-2"><td colSpan={9} className="!py-3">
                    {i.error && <div className="text-alt text-[12.5px] mb-2">{i.error}</div>}
                    <pre className="mono text-[11px] text-muted whitespace-pre-wrap max-h-48 overflow-auto">{i.log.trim() || "(no log yet)"}</pre>
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

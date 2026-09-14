"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Chip, money, Empty } from "@/components/ui";
import { BinView } from "@/app/requests/[id]/view";
import type { Bin } from "@/lib/match/bin";

type Product = { id: string; sku: string; description: string; category: string | null; brand: string | null; labeler: string | null; status: string | null; gudidDi: string | null; gmdnName: string | null; listPrice: number | null; cogs: number | null; binJson: string | null; binSource: string | null; prices: { name: string; price: number }[]; used: number };

export function CatalogTable({ products, categories, q, cat, only, total }: { products: Product[]; categories: { name: string; count: number }[]; q: string; cat: string; only: string; total: number }) {
  const router = useRouter();
  const [search, setSearch] = useState(q);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) router.push(`/catalog?${new URLSearchParams({ q: search, cat, only }).toString()}`); }, 300);
    return () => clearTimeout(t);
  }, [search, q, cat, only, router]);
  const nav = (patch: Record<string, string>) => router.push(`/catalog?${new URLSearchParams({ q, cat, only, ...patch }).toString()}`);
  return (
    <>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line-2 flex-wrap">
        <select className="input w-auto" value={cat} onChange={(e) => nav({ cat: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
        <select className="input w-auto" value={only} onChange={(e) => nav({ only: e.target.value })}>
          <option value="">Everything</option>
          <option value="unpriced">Unpriced</option>
          <option value="nogudid">No GUDID record</option>
          <option value="discontinued">Discontinued</option>
        </select>
        <input className="input w-[280px]" placeholder="Search SKU, description, brand…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="ml-auto text-[12.5px] text-muted">{products.length} of {total}</span>
      </div>
      {products.length === 0 ? <Empty title="No products match" /> : (
        <table className="table">
          <thead><tr><th>SKU</th><th>Description</th><th>Category</th><th>GUDID</th><th className="text-right">List</th><th className="text-right">COGS</th><th>Pricebooks</th><th>Bin</th></tr></thead>
          <tbody>
            {products.map((p) => {
              const bin = safeBin(p.binJson);
              const isOpen = open === p.id;
              return (
                <RowGroup key={p.id} p={p} bin={bin} isOpen={isOpen} onToggle={() => setOpen(isOpen ? null : p.id)} />
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function RowGroup({ p, bin, isOpen, onToggle }: { p: Product; bin: Bin | null; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`cursor-pointer ${isOpen ? "bg-panel-2" : ""}`} onClick={onToggle}>
        <td><span className="mono font-semibold">{p.sku}</span>{p.brand && <div className="text-[11.5px] text-muted">{p.brand}</div>}</td>
        <td className="max-w-[420px]"><div className="line-clamp-2">{p.description}</div>{p.status && /not in/i.test(p.status) && <Chip tone="alt" className="mt-1">Discontinued</Chip>}</td>
        <td className="text-ink-2">{p.category ?? "—"}</td>
        <td>{p.gudidDi ? <a className="mono text-[12px] text-accent" target="_blank" rel="noreferrer" href={`https://accessgudid.nlm.nih.gov/devices/${p.gudidDi}`} onClick={(e) => e.stopPropagation()}>{p.gudidDi}</a> : <span className="text-faint">—</span>}</td>
        <td className="mono text-right">{money(p.listPrice)}</td>
        <td className="mono text-right">{money(p.cogs)}</td>
        <td className="text-[12px]">{p.prices.length ? p.prices.map((e) => <div key={e.name}><span className="text-muted">{e.name}</span> <span className="mono">{money(e.price)}</span></div>) : <span className="text-faint">—</span>}</td>
        <td>{bin ? <Chip tone={p.binSource === "llm" ? "accent" : "neutral"}>{p.binSource === "llm" ? "model" : "heuristic"}</Chip> : <span className="text-faint">—</span>}</td>
      </tr>
      {isOpen && (
        <tr className="bg-panel-2"><td colSpan={8} className="!pt-0">
          <div className="grid grid-cols-[1fr_1fr] gap-4">
            {bin ? <BinView bin={bin} title="Attribute bin" /> : <div className="text-muted text-[12.5px]">Not binned yet.</div>}
            <div className="text-[12.5px] space-y-1">
              {p.labeler && <div><span className="text-muted">Labeler</span> {p.labeler}</div>}
              {p.gmdnName && <div><span className="text-muted">GMDN</span> {p.gmdnName}</div>}
              {p.status && <div><span className="text-muted">Status</span> {p.status}</div>}
              <div><span className="text-muted">Proposed in</span> {p.used} candidate row{p.used === 1 ? "" : "s"}</div>
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}

function safeBin(json: string | null): Bin | null {
  if (!json) return null;
  try { return JSON.parse(json) as Bin; } catch { return null; }
}

export function CatalogActions() {
  const router = useRouter();
  const [panel, setPanel] = useState<null | "add" | "pricing" | "sizes" | "enrich">(null);
  const [skus, setSkus] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pricingUrl, setPricingUrl] = useState("");
  const [sizesUrl, setSizesUrl] = useState("");
  const [enrich, setEnrich] = useState<{ running: boolean; done: number; total: number; enriched: number; missing: number } | null>(null);

  useEffect(() => {
    if (panel !== "enrich") return;
    const t = setInterval(async () => {
      const r = await fetch("/api/catalog/enrich").then((r) => r.json());
      setEnrich(r);
      if (r && !r.running && r.total) { clearInterval(t); router.refresh(); }
    }, 1500);
    return () => clearInterval(t);
  }, [panel, router]);

  async function addSkus() {
    setBusy(true); setResult(null);
    const r = await fetch("/api/catalog/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skus, category }) }).then((r) => r.json());
    setBusy(false);
    const added = r.results.filter((x: { status: string }) => x.status === "added").length;
    const nf = r.results.filter((x: { status: string }) => x.status === "not-found").map((x: { sku: string }) => x.sku);
    setResult(`${added} added, ${r.results.length - added - nf.length} already present${nf.length ? `, not found under our labelers: ${nf.join(", ")}` : ""}`);
    router.refresh();
  }
  async function importPricing(f: File | null, url?: string) {
    setBusy(true); setResult(null);
    const fd = new FormData();
    if (f) fd.append("file", f);
    if (url) fd.append("sheetUrl", url);
    const r = await fetch("/api/pricing/import", { method: "POST", body: fd }).then((r) => r.json());
    setBusy(false);
    setResult(r.error ? r.error : `${r.updated} SKUs updated from ${r.rows} rows · pricebooks: ${r.pricebooks.join(", ") || "none"}${r.unknownSkus.length ? ` · ${r.unknownSkus.length} unknown SKUs skipped` : ""}`);
    router.refresh();
  }
  async function importSizes(f: File | null, url?: string) {
    setBusy(true); setResult(null);
    const fd = new FormData();
    if (f) fd.append("file", f);
    if (url) fd.append("sheetUrl", url);
    const r = await fetch("/api/competitor-sizes/import", { method: "POST", body: fd }).then((r) => r.json());
    setBusy(false);
    setResult(r.error ? r.error : `${r.upserted} competitor sizes saved from ${r.rows} rows${r.skipped.length ? ` · ${r.skipped.length} rows without a width/length/diameter skipped (${r.skipped.slice(0, 5).join(", ")}${r.skipped.length > 5 ? "…" : ""})` : ""}${r.rebinned ? ` · ${r.rebinned} competitor product${r.rebinned === 1 ? "" : "s"} will be re-binned on the next run` : ""}`);
    router.refresh();
  }
  async function startEnrich() {
    setEnrich({ running: true, done: 0, total: 0, enriched: 0, missing: 0 });
    await fetch("/api/catalog/enrich", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ onlyMissing: true }) });
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <button className="btn-secondary" onClick={() => setPanel(panel === "enrich" ? null : "enrich")}>Enrich from GUDID</button>
        <button className="btn-secondary" onClick={() => setPanel(panel === "pricing" ? null : "pricing")}>Pricing</button>
        <button className="btn-secondary" onClick={() => setPanel(panel === "sizes" ? null : "sizes")}>Competitor sizes</button>
        <button className="btn-primary" onClick={() => setPanel(panel === "add" ? null : "add")}>Add SKUs</button>
      </div>
      {panel && (
        <div className="absolute right-0 top-12 z-20 w-[440px] card p-5" style={{ boxShadow: "var(--shadow-lg)" }}>
          {panel === "add" && (
            <>
              <div className="font-semibold mb-1">Add SKUs from GUDID</div>
              <p className="text-[12.5px] text-muted mb-3">Paste catalog numbers (any separator). Each is looked up in openFDA under our labelers and added with its GUDID description and attribute bin.</p>
              <textarea className="input mono h-28" placeholder={"PPM1510X3\nPPDS2015\nSIG60AMT"} value={skus} onChange={(e) => setSkus(e.target.value)} />
              <input className="input mt-2" placeholder="Category (optional, e.g. Synthetic Mesh)" value={category} onChange={(e) => setCategory(e.target.value)} />
              <div className="flex justify-end gap-2 mt-3"><button className="btn-ghost" onClick={() => setPanel(null)}>Close</button><button className="btn-primary" disabled={busy || !skus.trim()} onClick={addSkus}>{busy ? "Looking up…" : "Add"}</button></div>
            </>
          )}
          {panel === "pricing" && (
            <>
              <div className="font-semibold mb-1">Pricing import</div>
              <p className="text-[12.5px] text-muted mb-3">Get the template (pre-filled with every SKU), fill in <b>List Price</b>, <b>COGS</b> and any pricebook columns in Google Sheets or Excel, then bring it back as a link or a file. Only filled cells change.</p>
              <div className="flex items-center gap-2 mb-3">
                <a className="btn-secondary" href="/api/pricing/template">Template .xlsx</a>
                <a className="btn-secondary" href="/api/pricing/template?format=csv">Template .csv</a>
                <label className="btn-secondary cursor-pointer">Upload .xlsx / .csv<input type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importPricing(f); }} /></label>
              </div>
              <label className="label">…or a Google Sheets link (shared “Anyone with the link”)</label>
              <div className="flex gap-2">
                <input className="input mono" placeholder="https://docs.google.com/spreadsheets/d/…" value={pricingUrl} onChange={(e) => setPricingUrl(e.target.value)} />
                <button className="btn-primary" disabled={busy || !pricingUrl.trim()} onClick={() => importPricing(null, pricingUrl)}>{busy ? "Importing…" : "Import"}</button>
              </div>
              <div className="flex justify-end mt-3"><button className="btn-ghost" onClick={() => setPanel(null)}>Close</button></div>
            </>
          )}
          {panel === "sizes" && (
            <>
              <div className="font-semibold mb-1">Competitor sizes import</div>
              <p className="text-[12.5px] text-muted mb-3">FDA GUDID leaves many competitor codes unsized (Ethicon meshes, most reloads), so they tie to our smallest product. The template lists every competitor code CRACR has seen that still lacks a size — fill in <b>Width</b> / <b>Length</b> (or <b>Diameter</b>) from the competitor catalog and bring it back. Affected lines re-bin and re-grade on the next run.</p>
              <div className="flex items-center gap-2 mb-3">
                <a className="btn-secondary" href="/api/competitor-sizes/template">Template .xlsx</a>
                <a className="btn-secondary" href="/api/competitor-sizes/template?format=csv">Template .csv</a>
                <label className="btn-secondary cursor-pointer">Upload .xlsx / .csv<input type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importSizes(f); }} /></label>
              </div>
              <label className="label">…or a Google Sheets link (shared “Anyone with the link”)</label>
              <div className="flex gap-2">
                <input className="input mono" placeholder="https://docs.google.com/spreadsheets/d/…" value={sizesUrl} onChange={(e) => setSizesUrl(e.target.value)} />
                <button className="btn-primary" disabled={busy || !sizesUrl.trim()} onClick={() => importSizes(null, sizesUrl)}>{busy ? "Importing…" : "Import"}</button>
              </div>
              <div className="flex justify-end mt-3"><button className="btn-ghost" onClick={() => setPanel(null)}>Close</button></div>
            </>
          )}
          {panel === "enrich" && (
            <>
              <div className="font-semibold mb-1">Enrich from GUDID</div>
              <p className="text-[12.5px] text-muted mb-3">Looks up every SKU without a GUDID record in openFDA (about 4 per second to respect the public rate limit) and stores brand, labeler, GMDN term, sizes and distribution status. Improves attribute matching.</p>
              {enrich?.running ? (
                <div className="text-[12.5px]"><span className="h-2 w-2 rounded-full bg-info pulse-dot inline-block mr-2" />Working… {enrich.done}/{enrich.total || "?"} · {enrich.enriched} enriched · {enrich.missing} not found</div>
              ) : enrich && enrich.total ? (
                <div className="text-[12.5px] text-exact">Done: {enrich.enriched} enriched, {enrich.missing} not found in GUDID.</div>
              ) : null}
              <div className="flex justify-end gap-2 mt-3"><button className="btn-ghost" onClick={() => setPanel(null)}>Close</button><button className="btn-primary" disabled={enrich?.running} onClick={startEnrich}>Start</button></div>
            </>
          )}
          {result && <div className="mt-3 rounded-md bg-accent-soft text-accent-ink px-3 py-2 text-[12.5px]">{result}</div>}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Chip } from "@/components/ui";

type Preview = {
  lines: { rawCode: string; cfnNorm: string; quantity: number; estPrice: number | null }[];
  sheet: string;
  source: { kind: string; name: string; url?: string; via?: string };
  skipped: { row: number; value: string; reason: string }[];
  duplicatesMerged: number;
  detectedColumns: { code: number; qty: number | null; price: number | null; headerRow: number | null };
};
type Mode = "sheet" | "file" | "paste";

export function NewRequestForm({ pricebooks, llmAvailable }: { pricebooks: { id: string; name: string; entries: number }[]; llmAvailable: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sheet");
  const [file, setFile] = useState<File | null>(null);
  const [sheetUrl, setSheetUrl] = useState("");
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [form, setForm] = useState({ reportType: "Competitive Cross Reference with Pricebook", accountType: "Sold-To", accountNumber: "", accountName: "", pricebookId: pricebooks[0]?.id ?? "", useLlm: llmAvailable, createdBy: "" });

  const intakeForm = useCallback((extra?: { file?: File; sheetUrl?: string; csvText?: string }) => {
    const fd = new FormData();
    const f = extra?.file ?? (mode === "file" ? file : null);
    if (f) fd.append("file", f);
    if (mode === "sheet" || extra?.sheetUrl) fd.append("sheetUrl", extra?.sheetUrl ?? sheetUrl);
    if (mode === "paste" || extra?.csvText) { fd.append("csvText", extra?.csvText ?? csvText); fd.append("csvName", "Pasted cells"); }
    return fd;
  }, [mode, file, sheetUrl, csvText]);

  const runPreview = useCallback(async (extra?: { file?: File; sheetUrl?: string; csvText?: string }) => {
    setError(null);
    setPreview(null);
    setBusy(true);
    try {
      const res = await fetch("/api/intake/preview", { method: "POST", body: intakeForm(extra) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError({ message: data.error ?? `Could not read the file (${res.status})`, hint: data.hint }); return; }
      setPreview(data);
      const m = (data.source?.name ?? "").match(/(\d{8,})/);
      if (m) setForm((s) => (s.accountNumber ? s : { ...s, accountNumber: m[1] }));
    } catch { setError({ message: "Could not reach the server" }); } finally { setBusy(false); }
  }, [intakeForm]);

  const onFile = (f: File) => { setFile(f); runPreview({ file: f }); };

  // Submitting is idempotent from the UI's side: the button disables on the first click and
  // the request is not sent again while one is in flight (a double click made two requests).
  const submitting = useRef(false);
  async function submit() {
    if (submitting.current || !preview) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const fd = intakeForm();
      for (const [k, v] of Object.entries(form)) fd.append(k, String(v));
      const res = await fetch("/api/requests", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError({ message: data.error ?? `Could not create the request (${res.status})`, hint: data.hint }); submitting.current = false; setBusy(false); return; }
      // Stay disabled until the navigation unmounts this form: re-enabling on success left a
      // window (response received, page not yet replaced) in which a second click created a
      // second request.
      router.push(`/requests/${data.id}`);
    } catch { setError({ message: "Could not reach the server" }); submitting.current = false; setBusy(false); }
  }

  const totalQty = preview?.lines.reduce((a, l) => a + l.quantity, 0) ?? 0;
  const tabs: [Mode, string][] = [["sheet", "Google Sheets link"], ["file", "Upload .xlsx / .csv"], ["paste", "Paste from a sheet"]];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 items-start [&>*]:min-w-0">
      <div className="space-y-4">
        <Card title="1 · Competitor usage" subtitle="A product-code column and a quantity column. Header names are detected; repeated codes are merged. Google Sheets is free — no Excel needed.">
          <div className="flex items-center gap-1 mb-4 rounded-lg bg-panel-2 p-1 w-fit flex-wrap" role="group" aria-label="Source">
            {tabs.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={mode === k} onClick={() => { setMode(k); setPreview(null); setError(null); }} className={`rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${mode === k ? "bg-panel shadow-[var(--shadow)] text-ink" : "text-muted hover:text-ink"}`}>{label}</button>
            ))}
          </div>

          {mode === "sheet" && (
            <div>
              <label className="label" htmlFor="sheet-url">Google Sheets link</label>
              <div className="flex gap-2">
                <input id="sheet-url" className="input mono" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runPreview(); }} />
                <button type="button" className="btn-secondary" disabled={!sheetUrl.trim() || busy} onClick={() => runPreview()}>{busy ? "Reading…" : "Read sheet"}</button>
              </div>
              <p className="text-[12px] text-muted mt-2">Share the sheet as <b>Anyone with the link → Viewer</b> (Share → General access). The tab in the link (<span className="mono">gid</span>) is the one that&apos;s read. Private sheets work too if they&apos;re shared with the service account set up in Settings.</p>
            </div>
          )}

          {mode === "file" && (
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 cursor-pointer transition-colors ${drag ? "border-accent bg-accent-soft" : "border-line hover:border-faint bg-panel-2"}`}
            >
              <input type="file" accept=".xlsx,.xlsm,.csv,text/csv" aria-label="Spreadsheet file" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-accent"><path d="M12 16V4m0 0l-4 4m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" /><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" strokeLinecap="round" /></svg>
              {file ? (
                <div className="text-center"><div className="font-medium text-ink">{file.name}</div><div className="text-[12px] text-muted">{(file.size / 1024).toFixed(0)} KB · click to replace</div></div>
              ) : (
                <div className="text-center"><div className="font-medium text-ink">Drop a spreadsheet here</div><div className="text-[12px] text-muted">or click to browse · .xlsx or .csv (Google Sheets → File → Download)</div></div>
              )}
            </label>
          )}

          {mode === "paste" && (
            <div>
              <label className="label" htmlFor="paste-cells">Paste cells copied from Google Sheets or Excel</label>
              <textarea id="paste-cells" className="input mono h-36" placeholder={"ProductCode\tQuantity\n1DLMC05\t1\n112660\t10"} value={csvText} onChange={(e) => setCsvText(e.target.value.includes("\t") ? e.target.value.replace(/\t/g, ",") : e.target.value)} />
              <div className="flex justify-end mt-2"><button type="button" className="btn-secondary" disabled={!csvText.trim() || busy} onClick={() => runPreview()}>{busy ? "Reading…" : "Read pasted cells"}</button></div>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-3 rounded-lg bg-none-soft text-none px-3 py-2 text-[13px]">
              <div className="font-medium">{error.message}</div>
              {error.hint && <div className="text-[12.5px] mt-0.5 opacity-90">{error.hint}</div>}
            </div>
          )}
          {preview && (
            <div className="mt-4">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted mb-3">
                <Chip tone="accent">{preview.lines.length} codes</Chip>
                <Chip>{totalQty.toLocaleString()} units</Chip>
                {preview.duplicatesMerged > 0 && <Chip tone="info">{preview.duplicatesMerged} duplicate rows merged</Chip>}
                {preview.skipped.length > 0 && <Chip tone="alt">{preview.skipped.length} rows skipped</Chip>}
                {preview.source.kind === "google-sheet" && <Chip tone="exact">Google Sheet{preview.source.via === "service-account" ? " · private" : ""}</Chip>}
                <span>“{preview.source.name}” · code col {preview.detectedColumns.code}{preview.detectedColumns.qty ? ` · qty col ${preview.detectedColumns.qty}` : " · no quantity column, using 1"}{preview.detectedColumns.price ? ` · price col ${preview.detectedColumns.price}` : ""}</span>
              </div>
              <div className="max-h-[300px] overflow-auto rounded-lg border border-line">
                <table className="table">
                  <thead><tr><th>#</th><th>Code</th><th>Normalised</th><th className="text-right">Qty</th><th className="text-right">Est. price</th></tr></thead>
                  <tbody>
                    {preview.lines.map((l, i) => (
                      <tr key={`${l.cfnNorm}-${i}`}><td className="mono text-muted">{i + 1}</td><td className="mono">{l.rawCode}</td><td className="mono text-muted">{l.cfnNorm !== l.rawCode ? l.cfnNorm : ""}</td><td className="mono text-right">{l.quantity}</td><td className="mono text-right text-muted">{l.estPrice != null ? `$${l.estPrice.toFixed(2)}` : "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="2 · Account" subtitle="Who the bid is for. Mirrors the BAT request form.">
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="report-type">Report type</label>
              <select id="report-type" className="input" value={form.reportType} onChange={(e) => setForm({ ...form, reportType: e.target.value })}>
                <option>Competitive Cross Reference with Pricebook</option>
                <option>Competitive Cross Reference</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="account-type">Account type</label>
                <select id="account-type" className="input" value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })}>
                  <option>Sold-To</option><option>Ship-To</option><option>Group</option><option>IDN</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="account-number">Account number</label>
                <input id="account-number" className="input mono" placeholder="0001880967" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="account-name">Account / Group / IDN name</label>
              <input id="account-name" className="input" placeholder="Memorial Sloan Kettering" value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="pricebook">Pricebook</label>
              <select id="pricebook" className="input" value={form.pricebookId} onChange={(e) => setForm({ ...form, pricebookId: e.target.value })}>
                <option value="">List price only</option>
                {pricebooks.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.entries} priced)</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="requested-by">Requested by</label>
              <input id="requested-by" className="input" placeholder="Your name" value={form.createdBy} onChange={(e) => setForm({ ...form, createdBy: e.target.value })} />
            </div>
          </div>
        </Card>
        <Card title="3 · Matching">
          <label className={`flex items-start gap-3 ${llmAvailable ? "" : "text-muted"}`}>
            <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={form.useLlm} disabled={!llmAvailable} onChange={(e) => setForm({ ...form, useLlm: e.target.checked })} />
            <div>
              <div className="font-medium text-ink">Use the model</div>
              <div className="text-[12.5px] text-muted">{llmAvailable ? "Sharper attribute bins, plain-language grading of each candidate, and hints for codes GUDID can't find. Slower; a few cents per line." : "No API key configured — running in deterministic heuristic mode."}</div>
            </div>
          </label>
          <button type="button" className="btn-primary w-full justify-center mt-5" disabled={!preview || busy} title={preview ? undefined : "Read a sheet, file or pasted cells first"} onClick={submit}>
            {busy ? "Working…" : "Continue request"}
          </button>
        </Card>
      </div>
    </div>
  );
}

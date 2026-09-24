"use client";
/**
 * Integration Settings — schema-driven. Everything rendered here comes from the registry
 * (providers, fields, mapping specs, sync types) through /api/integrations/config; this file
 * knows nothing about Salesforce or SAP field names. Secrets: the form never receives a stored
 * value — a field shows "set" and stays blank; typing replaces, "clear" removes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Chip, relTime } from "@/components/ui";

type FieldSpec = { name: string; label: string; type: string; required?: boolean; secret?: boolean; help?: string; placeholder?: string; default?: string | number | boolean; options?: { value: string; label: string }[]; group?: string };
type Provider = { id: string; label: string; description: string; mock: boolean; fields: FieldSpec[] };
type SyncType = { id: string; label: string; description: string; acceptsUpload?: boolean };
type Summary = { key: string; label: string; family: string; description: string; provider: string | null; providerLabel: string | null; mock: boolean; enabled: boolean; status: string; lastSyncAt: string | null; lastTestAt: string | null; lastTestOk: boolean | null; lastError: string | null; lastErrorCategory: string | null; openReviews: number; scheduleCron: string | null };
type Job = { id: string; provider: string; syncType: string; trigger: string; status: string; startedAt: string; completedAt: string | null; received: number; created: number; updated: number; skipped: number; errored: number; reviewed: number; errorSummary: string | null; errorCategory: string | null };
type Detail = {
  definition: { key: string; label: string; family: string; description: string; providers: Provider[]; commonFields: FieldSpec[]; mappingSpecs: Record<string, { entity: string; fields: { name: string; type: string; required?: boolean; description: string; example?: string }[] }>; defaultMapping: Record<string, Record<string, unknown>>; syncTypes: SyncType[]; webhook: { path: string; secretField: string } | null; requiredFromCustomer: string[] };
  config: { provider: string; enabled: boolean; config: Record<string, unknown>; secretsPresent: string[]; mapping: Record<string, Record<string, unknown>>; effectiveMapping: Record<string, Record<string, unknown>>; scheduleCron: string | null; configVersion: number; status: string; lastTestAt: string | null; lastTestOk: boolean | null; lastConnectedAt: string | null; lastSyncAt: string | null; lastAttemptAt: string | null; lastError: string | null; lastErrorCategory: string | null } | null;
  jobs: Job[]; openReviews: number; mockAllowed: boolean;
};
type Review = { id: string; integrationKey: string; kind: string; status: string; summary: string; payload: unknown; suggestion: unknown; createdAt: string; externalId: string | null };

const HEALTH_TONE: Record<string, "neutral" | "accent" | "info" | "alt" | "none" | "exact"> = { NOT_CONFIGURED: "neutral", CONFIGURED: "info", CONNECTED: "exact", DEGRADED: "alt", ERROR: "none", DISABLED: "neutral" };
const JOB_TONE: Record<string, "neutral" | "accent" | "info" | "alt" | "none" | "exact"> = { QUEUED: "neutral", RUNNING: "info", SUCCEEDED: "exact", PARTIAL: "alt", FAILED: "none", CANCELLED: "neutral" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status}`);
  return j as T;
}

export function IntegrationsAdmin({ canConfigure }: { canConfigure: boolean }) {
  const [list, setList] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setList((await api<{ integrations: Summary[] }>("/api/integrations/config")).integrations); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { load(); }, [load]);
  const families = useMemo(() => [...new Set(list.map((i) => i.family))], [list]);
  const FAMILY: Record<string, string> = { crm: "CRM", erp: "ERP", gpo: "GPO rosters", documents: "Documents", fx: "Exchange rates", contracts: "Competitor pricing" };
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 items-start [&>*]:min-w-0">
      <Card title="Integrations" subtitle="Status of every connector. Nothing here is required — the app runs on manual workflows until an integration is enabled." padded={false}>
        {error && <div className="px-4 py-2 text-[12px] text-none">{error}</div>}
        <div className="divide-y divide-line-2">
          {families.map((f) => (
            <div key={f}>
              <div className="eyebrow px-4 pt-3 pb-1">{FAMILY[f] ?? f}</div>
              {list.filter((i) => i.family === f).map((i) => (
                <button type="button" key={i.key} onClick={() => setSelected(i.key)} className={`w-full text-left px-4 py-2.5 hover:bg-panel-2 ${selected === i.key ? "bg-panel-2" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium truncate">{i.label}</span>
                    <Chip tone={HEALTH_TONE[i.status] ?? "neutral"}>{i.status.replace(/_/g, " ").toLowerCase()}</Chip>
                  </div>
                  <div className="text-[11.5px] text-muted flex gap-2 mt-0.5">
                    <span>{i.providerLabel ?? "no provider"}{i.mock ? " · MOCK" : ""}</span>
                    {i.openReviews > 0 && <span className="text-alt">{i.openReviews} to review</span>}
                    {i.lastSyncAt && <span>synced {relTime(i.lastSyncAt)}</span>}
                  </div>
                </button>
              ))}
            </div>
          ))}
          <button type="button" onClick={() => setSelected("__review")} className={`w-full text-left px-4 py-2.5 hover:bg-panel-2 ${selected === "__review" ? "bg-panel-2" : ""}`}>
            <div className="text-[13px] font-medium">Review queue</div>
            <div className="text-[11.5px] text-muted">{list.reduce((n, i) => n + i.openReviews, 0)} open items across all integrations</div>
          </button>
        </div>
      </Card>
      {selected === "__review" ? <ReviewQueue onChange={load} /> : selected ? <IntegrationEditor key={selected} k={selected} canConfigure={canConfigure} onSaved={load} /> : (
        <Card title="Pick an integration" subtitle="Each one is configured in the same way: choose a provider, fill in the fields, save, test the connection, validate the mapping, sync a test record, then enable the schedule.">
          <ol className="text-[13px] space-y-1.5 list-decimal ml-5">
            <li><b>Provider</b> — the real system, a file drop, or a clearly labelled mock for demos.</li>
            <li><b>Connection</b> — URLs and names are stored; secrets are sealed and never shown again (use <span className="mono">env:NAME</span> to reference an environment variable instead).</li>
            <li><b>Mapping</b> — the company&apos;s own field names for each canonical field. No field name is hard-coded.</li>
            <li><b>Test → validate → sync a test record</b> — the health badge moves to <i>connected</i> only after a real test passes.</li>
            <li><b>Schedule</b> — a cron expression (UTC). Manual syncs and uploads work without one.</li>
          </ol>
          <div className="text-[12px] text-muted mt-3">Setup per integration: <a className="text-accent underline" href="/docs/INTEGRATION_SETUP.md">docs/INTEGRATION_SETUP.md</a>.</div>
        </Card>
      )}
    </div>
  );
}

function IntegrationEditor({ k, canConfigure, onSaved }: { k: string; canConfigure: boolean; onSaved: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [provider, setProvider] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [cron, setCron] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string; detail?: unknown } | null>(null);
  const [syncType, setSyncType] = useState("");
  const [reviews, setReviews] = useState<Review[]>([]);

  const load = useCallback(async () => {
    const det = await api<Detail>(`/api/integrations/config/${encodeURIComponent(k)}`);
    setD(det);
    const p = det.config?.provider ?? det.definition.providers[0].id;
    setProvider(p); setEnabled(det.config?.enabled ?? false); setCron(det.config?.scheduleCron ?? "");
    setValues(det.config?.config ?? {}); setSecrets({});
    setMapping(Object.fromEntries(Object.keys(det.definition.mappingSpecs).filter((e) => e !== "_").map((e) => [e, JSON.stringify(det.config?.mapping?.[e] ?? {}, null, 2)])));
    setSyncType(det.definition.syncTypes[0]?.id ?? "");
    setReviews((await api<{ items: Review[] }>(`/api/integrations/review?key=${encodeURIComponent(k)}`)).items);
  }, [k]);
  useEffect(() => { load().catch((e) => setMsg({ tone: "err", text: (e as Error).message })); }, [load]);

  if (!d) return <Card title="Loading…"><div className="text-muted text-[13px]">…</div></Card>;
  const def = d.definition;
  const prov = def.providers.find((p) => p.id === provider) ?? def.providers[0];
  const fields = [...prov.fields, ...def.commonFields];
  const groups = [...new Set(fields.map((f) => f.group ?? "Settings"))];
  const present = new Set(d.config?.provider === provider ? d.config.secretsPresent : []);

  const run = async (label: string, fn: () => Promise<{ tone: "ok" | "warn" | "err"; text: string; detail?: unknown }>) => {
    setBusy(label); setMsg(null);
    try { setMsg(await fn()); } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); } finally { setBusy(null); await load().catch(() => undefined); onSaved(); }
  };
  const save = () => run("save", async () => {
    let mappingObj: Record<string, unknown> | undefined;
    try { mappingObj = Object.fromEntries(Object.entries(mapping).map(([e, s]) => [e, s.trim() ? JSON.parse(s) : {}])); } catch (e) { throw new Error(`mapping is not valid JSON: ${(e as Error).message}`); }
    const r = await api<{ status: string; configVersion: number; errors: { field: string; message: string }[] }>(`/api/integrations/config/${encodeURIComponent(k)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, enabled, config: values, secrets, mapping: mappingObj, scheduleCron: cron || null }) });
    return r.errors.length ? { tone: "warn", text: `Saved (v${r.configVersion}) with ${r.errors.length} problem(s): ${r.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}` } : { tone: "ok", text: `Saved — configuration v${r.configVersion}, status ${r.status.toLowerCase()}. Test the connection next.` };
  });
  const test = () => run("test", async () => { const r = await api<{ ok: boolean; message: string; details?: unknown; category?: string }>(`/api/integrations/config/${encodeURIComponent(k)}/test`, { method: "POST" }); return { tone: r.ok ? "ok" : "err", text: r.message, detail: r.details }; });
  const validate = (live: boolean) => run(live ? "validate-live" : "validate", async () => {
    const r = await api<{ entities: Record<string, { field: string; level: string; message: string }[]>; live: boolean; ok: boolean }>(`/api/integrations/config/${encodeURIComponent(k)}/validate-mapping`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ live }) });
    const issues = Object.entries(r.entities).flatMap(([e, list]) => list.map((i) => `${e}.${i.field}: ${i.message}`));
    return { tone: r.ok ? (issues.length ? "warn" : "ok") : "err", text: r.ok ? `Mapping valid${r.live ? " (checked against the provider)" : ""}${issues.length ? ` — ${issues.length} warning(s)` : ""}` : `Mapping has errors`, detail: issues };
  });
  const sync = (mode: "test" | "queue" | "inline", full = false) => run(`sync-${mode}`, async () => {
    const r = await api<{ queued?: boolean; jobId?: string; status?: string; counters?: Record<string, number>; error?: { message: string; category: string } }>(`/api/integrations/config/${encodeURIComponent(k)}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syncType, mode, full }) });
    if (r.queued) return { tone: "ok", text: "Sync queued — the history below updates as it runs." };
    const c = r.counters ?? {};
    return { tone: r.status === "SUCCEEDED" ? "ok" : r.status === "PARTIAL" ? "warn" : "err", text: `${mode === "test" ? "Test record sync" : "Sync"} ${r.status?.toLowerCase()}: ${c.received ?? 0} received · ${c.created ?? 0} created · ${c.updated ?? 0} updated · ${c.skipped ?? 0} unchanged · ${c.errored ?? 0} errors · ${c.reviewed ?? 0} to review${r.error ? ` — ${r.error.message}` : ""}` };
  });
  const upload = (file: File) => run("upload", async () => {
    const fd = new FormData(); fd.set("file", file); fd.set("syncType", syncType);
    const r = await api<{ status: string; counters: Record<string, number>; error?: { message: string } }>(`/api/integrations/config/${encodeURIComponent(k)}/upload`, { method: "POST", body: fd });
    const c = r.counters;
    return { tone: r.status === "SUCCEEDED" ? "ok" : r.status === "PARTIAL" ? "warn" : "err", text: `${file.name}: ${r.status.toLowerCase()} — ${c.received} rows · ${c.created} recorded · ${c.skipped} skipped · ${c.errored} errors · ${c.reviewed} to review${r.error ? ` — ${r.error.message}` : ""}` };
  });

  const cfg = d.config;
  return (
    <div className="space-y-4">
      <Card title={def.label} subtitle={def.description} actions={cfg && <div className="flex items-center gap-2 text-[12px]"><Chip tone={HEALTH_TONE[cfg.status] ?? "neutral"}>{cfg.status.replace(/_/g, " ").toLowerCase()}</Chip>{cfg.lastSyncAt && <span className="text-muted">last sync {relTime(cfg.lastSyncAt)}</span>}</div>}>
        {cfg?.lastError && <div className="mb-3 rounded-md bg-none-soft text-none px-3 py-2 text-[12px]"><b>{cfg.lastErrorCategory?.replace(/_/g, " ").toLowerCase() ?? "error"}:</b> {cfg.lastError}</div>}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
          <div>
            <label className="label" htmlFor="int-provider">Provider</label>
            <select id="int-provider" className="input" value={provider} disabled={!canConfigure} onChange={(e) => { setProvider(e.target.value); setSecrets({}); }}>
              {def.providers.map((p) => <option key={p.id} value={p.id} disabled={p.mock && !d.mockAllowed}>{p.label}{p.mock && !d.mockAllowed ? " (not allowed here)" : ""}</option>)}
            </select>
            <div className="text-[11.5px] text-muted mt-1">{prov.description}{prov.mock && <b className="text-alt"> — MOCK PROVIDER: demo data, no real system.</b>}</div>
          </div>
          <div>
            <label className="label" htmlFor="int-cron">Schedule (cron, UTC)</label>
            <input id="int-cron" className="input mono w-[150px]" placeholder="0 2 * * *" value={cron} disabled={!canConfigure} onChange={(e) => setCron(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-[13px] pb-2"><input type="checkbox" checked={enabled} disabled={!canConfigure} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        </div>
        {groups.map((g) => (
          <div key={g} className="mt-4">
            <div className="eyebrow mb-2">{g}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {fields.filter((f) => (f.group ?? "Settings") === g).map((f) => <Field key={f.name} f={f} value={values[f.name]} present={present.has(f.name)} secret={secrets[f.name]} disabled={!canConfigure} onChange={(v) => setValues({ ...values, [f.name]: v })} onSecret={(v) => setSecrets({ ...secrets, [f.name]: v })} />)}
            </div>
          </div>
        ))}
        {Object.keys(def.mappingSpecs).filter((e) => e !== "_").length > 0 && (
          <div className="mt-4">
            <div className="eyebrow mb-2">Field mapping <span className="normal-case font-normal text-muted">— overrides on top of the defaults; JSON per entity: {"{ canonicalField: { source: \"Their_Field__c\", transform?, valueMap?, default?, constant? } }"}</span></div>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(def.mappingSpecs).filter(([e]) => e !== "_").map(([entity, spec]) => (
                <div key={entity}>
                  <label className="label">{entity} <span className="text-muted font-normal">· canonical: {spec.fields.map((f) => f.name + (f.required ? "*" : "")).join(", ")}</span></label>
                  <textarea className="input mono min-h-[110px] text-[11.5px]" aria-label={`${entity} mapping JSON`} value={mapping[entity] ?? "{}"} disabled={!canConfigure} onChange={(e) => setMapping({ ...mapping, [entity]: e.target.value })} spellCheck={false} />
                  <details className="text-[11.5px] text-muted mt-1"><summary className="cursor-pointer">defaults</summary><pre className="mono whitespace-pre-wrap">{JSON.stringify(def.defaultMapping[entity] ?? {}, null, 1)}</pre></details>
                </div>
              ))}
            </div>
          </div>
        )}
        {def.webhook && cfg && <div className="mt-3 text-[12px] text-muted">Webhook endpoint: <span className="mono">{def.webhook.path}</span> — sign the JSON body with the shared secret (HMAC-SHA256, header <span className="mono">X-Crosswalk-Signature</span>).</div>}
        {canConfigure && (
          <div className="mt-4 flex flex-wrap gap-2 items-center border-t border-line-2 pt-3">
            <button type="button" className="btn-primary" disabled={busy !== null} onClick={save}>{busy === "save" ? "Saving…" : "Save"}</button>
            <button type="button" className="btn-ghost" disabled={busy !== null || !cfg} title={cfg ? undefined : "Save the configuration first"} onClick={test}>{busy === "test" ? "Testing…" : "Test connection"}</button>
            <button type="button" className="btn-ghost" disabled={busy !== null || !cfg} title={cfg ? undefined : "Save the configuration first"} onClick={() => validate(false)}>Validate mapping</button>
            <button type="button" className="btn-ghost" disabled={busy !== null || !cfg} title={cfg ? undefined : "Save the configuration first"} onClick={() => validate(true)}>Validate against provider</button>
            {def.syncTypes.length > 0 && (<>
              <select className="input w-auto !py-1" aria-label="Sync type" value={syncType} onChange={(e) => setSyncType(e.target.value)}>{def.syncTypes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
              <button type="button" className="btn-ghost" disabled={busy !== null || !cfg?.enabled} title={cfg?.enabled ? undefined : "Enable and save the integration first"} onClick={() => sync("test")}>Sync a test record</button>
              <button type="button" className="btn-ghost" disabled={busy !== null || !cfg?.enabled} title={cfg?.enabled ? undefined : "Enable and save the integration first"} onClick={() => sync("queue")}>Run sync now</button>
              <button type="button" className="btn-ghost" disabled={busy !== null || !cfg?.enabled} title={cfg?.enabled ? undefined : "Enable and save the integration first"} onClick={() => { if (window.confirm("Full resync re-reads every record from the provider. Continue?")) sync("queue", true); }}>Full resync</button>
              {def.syncTypes.find((s) => s.id === syncType)?.acceptsUpload && <label className="btn-ghost cursor-pointer">Upload file…<input type="file" accept=".csv,.xlsx" className="hidden" disabled={busy !== null || !cfg?.enabled} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} /></label>}
            </>)}
          </div>
        )}
        {msg && <div role={msg.tone === "err" ? "alert" : "status"} className={`mt-3 rounded-md px-3 py-2 text-[12.5px] ${msg.tone === "ok" ? "bg-exact-soft text-exact" : msg.tone === "warn" ? "bg-alt-soft text-alt" : "bg-none-soft text-none"}`}>{msg.text}{msg.detail !== undefined && msg.detail !== null && (Array.isArray(msg.detail) ? msg.detail.length > 0 : true) && <pre className="mono text-[11px] mt-1 whitespace-pre-wrap max-h-48 overflow-auto">{Array.isArray(msg.detail) ? msg.detail.join("\n") : JSON.stringify(msg.detail, null, 1)}</pre>}</div>}
      </Card>

      {def.requiredFromCustomer.length > 0 && (
        <Card title="Required from the company" subtitle="Nothing else is needed — the connector, mapping engine, review queue and schedules are already built.">
          <ul className="text-[12.5px] space-y-1 list-disc ml-5">{def.requiredFromCustomer.map((r) => <li key={r}>{r}</li>)}</ul>
        </Card>
      )}

      {reviews.length > 0 && <ReviewList items={reviews} onChange={() => load()} />}

      <Card title="Sync history" subtitle="Every run, with counters. Row-level errors are kept per job." padded={false}>
        {d.jobs.length === 0 ? <div className="px-4 py-3 text-[12.5px] text-muted">No runs yet.</div> : (
          <table className="table">
            <thead><tr><th>Started</th><th>Type</th><th>Trigger</th><th>Status</th><th className="text-right">Received</th><th className="text-right">Created</th><th className="text-right">Updated</th><th className="text-right">Unchanged</th><th className="text-right">Errors</th><th className="text-right">Review</th><th>Summary</th></tr></thead>
            <tbody>{d.jobs.map((j) => <tr key={j.id}><td className="whitespace-nowrap">{relTime(j.startedAt)}</td><td>{j.syncType}</td><td>{j.trigger}</td><td><Chip tone={JOB_TONE[j.status] ?? "neutral"}>{j.status.toLowerCase()}</Chip></td><td className="mono text-right">{j.received}</td><td className="mono text-right">{j.created}</td><td className="mono text-right">{j.updated}</td><td className="mono text-right">{j.skipped}</td><td className="mono text-right">{j.errored ? <a className="text-none" href={`/api/integrations/jobs/${j.id}`} target="_blank" rel="noreferrer">{j.errored}</a> : 0}</td><td className="mono text-right">{j.reviewed}</td><td className="text-[11.5px] text-muted max-w-[280px] truncate" title={j.errorSummary ?? ""}>{j.errorSummary ?? ""}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Field({ f, value, present, secret, disabled, onChange, onSecret }: { f: FieldSpec; value: unknown; present: boolean; secret: string | null | undefined; disabled: boolean; onChange: (v: unknown) => void; onSecret: (v: string | null) => void }) {
  const label = <label className="label">{f.label}{f.required && <span className="text-none"> *</span>}</label>;
  const help = f.help && <div className="text-[11px] text-muted mt-0.5">{f.help}</div>;
  if (f.secret) {
    const cleared = secret === null;
    return (
      <div className={f.type === "multiline-secret" ? "col-span-2" : ""}>
        {label}
        <div className="flex gap-2 items-start">
          {f.type === "multiline-secret"
            ? <textarea className="input mono min-h-[80px] text-[11.5px]" placeholder={present && !cleared ? "•••••• (stored — paste to replace)" : f.placeholder ?? ""} value={secret ?? ""} disabled={disabled || cleared} onChange={(e) => onSecret(e.target.value)} spellCheck={false} />
            : <input type="password" autoComplete="new-password" className="input mono" placeholder={present && !cleared ? "•••••• (stored — type to replace)" : f.placeholder ?? "not set"} value={secret ?? ""} disabled={disabled || cleared} onChange={(e) => onSecret(e.target.value)} />}
          {present && !disabled && <button type="button" className="btn-ghost !py-1 !text-[11px] whitespace-nowrap" onClick={() => onSecret(cleared ? undefined as unknown as string : null)}>{cleared ? "undo clear" : "clear"}</button>}
        </div>
        <div className="text-[11px] text-muted mt-0.5">{cleared ? "Will be removed on save." : present ? "Stored and sealed — never shown." : "Not set."} {help && <span>{f.help}</span>}</div>
      </div>
    );
  }
  const v = value === undefined || value === null ? (f.default ?? "") : value;
  if (f.type === "boolean") return <div className="flex items-start gap-2 pt-5"><input type="checkbox" checked={v === true || v === "true"} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><div><div className="text-[13px]">{f.label}</div>{help}</div></div>;
  if (f.type === "select") return <div>{label}<select className="input" value={String(v)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{help}</div>;
  if (f.type === "json" || f.type === "textarea") return <div className="col-span-2">{label}<textarea className="input mono min-h-[60px] text-[11.5px]" value={typeof v === "string" ? v : JSON.stringify(v)} disabled={disabled} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />{help}</div>;
  return <div>{label}<input className={`input ${f.type === "number" || f.type === "url" || f.type === "cron" ? "mono" : ""}`} type={f.type === "number" ? "number" : "text"} value={String(v)} disabled={disabled} placeholder={f.placeholder} onChange={(e) => onChange(f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />{help}</div>;
}

function ReviewQueue({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<Review[]>([]);
  const load = useCallback(async () => setItems((await api<{ items: Review[] }>("/api/integrations/review")).items), []);
  useEffect(() => { load(); }, [load]);
  return <ReviewList items={items} onChange={() => { load(); onChange(); }} all />;
}

function ReviewList({ items, onChange, all }: { items: Review[]; onChange: () => void; all?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<Record<string, string>>({});
  const act = async (id: string, body: Record<string, unknown>) => {
    setMsg(null);
    try { await api(`/api/integrations/review/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); onChange(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Card title={all ? "Review queue" : "Needs review"} subtitle="Records an integration would not decide on its own: unmatched members, conflicting memberships, unknown competitors, ambiguous units, overlapping prices, low-confidence extractions. Nothing here has been applied." padded={false}>
      {msg && <div role="alert" className="px-4 py-2 text-[12px] text-none">{msg}</div>}
      {items.length === 0 ? <div className="px-4 py-3 text-[12.5px] text-muted">Nothing to review.</div> : (
        <div className="divide-y divide-line-2">
          {items.map((it) => {
            const sugg = it.suggestion as { candidates?: string[]; accountId?: string; accounts?: { accountId: string; name: string; accountNumber: string | null; reason: string }[] } | null;
            const isGpo = it.integrationKey.startsWith("gpo:"); const isContract = it.integrationKey === "competitor-contracts";
            return (
              <div key={it.id} className="px-4 py-3 text-[12.5px]">
                <div className="flex items-center gap-2"><Chip tone="alt">{it.kind.replace(/_/g, " ").toLowerCase()}</Chip>{all && <span className="mono text-[11px] text-muted">{it.integrationKey}</span>}<span className="text-muted text-[11.5px]">{relTime(it.createdAt)}</span></div>
                <div className="mt-1">{it.summary}</div>
                {sugg?.accounts && sugg.accounts.length > 0 && <div className="text-[11.5px] text-muted mt-1">Suggestions: {sugg.accounts.map((a) => `${a.name}${a.accountNumber ? ` (${a.accountNumber})` : ""} — ${a.reason}`).join("; ")}</div>}
                {sugg?.candidates && sugg.candidates.length > 0 && <div className="text-[11.5px] text-muted mt-1">Did you mean: {sugg.candidates.join(", ")}</div>}
                <details className="text-[11px] text-muted mt-1"><summary className="cursor-pointer">record</summary><pre className="mono whitespace-pre-wrap max-h-40 overflow-auto">{JSON.stringify(it.payload, null, 1)}</pre></details>
                <div className="mt-2 flex flex-wrap gap-2 items-center">
                  {isGpo && it.kind === "UNMATCHED_ACCOUNT" && (<>
                    <select className="input w-auto !py-1 text-[12px]" value={linkId[it.id] ?? ""} onChange={(e) => setLinkId({ ...linkId, [it.id]: e.target.value })}>
                      <option value="">link to account…</option>
                      {sugg?.accounts?.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}{a.accountNumber ? ` (${a.accountNumber})` : ""}</option>)}
                    </select>
                    <input className="input w-[220px] !py-1 mono text-[12px]" placeholder="or paste an account id" value={linkId[it.id] ?? ""} onChange={(e) => setLinkId({ ...linkId, [it.id]: e.target.value })} />
                    <button type="button" className="btn-primary !py-1 !text-[12px]" disabled={!linkId[it.id]} onClick={() => act(it.id, { type: "link", accountId: linkId[it.id] })}>Link</button>
                  </>)}
                  {isGpo && it.kind === "MEMBERSHIP_CONFLICT" && <button type="button" className="btn-primary !py-1 !text-[12px]" onClick={() => act(it.id, { type: "supersede" })}>Accept roster (close the current membership)</button>}
                  {isContract && <button type="button" className="btn-primary !py-1 !text-[12px]" onClick={() => act(it.id, { type: "accept", corrections: it.kind === "UNKNOWN_COMPETITOR" ? { createCompetitor: true } : undefined })}>{it.kind === "UNKNOWN_COMPETITOR" ? "Create competitor and record" : "Record anyway"}</button>}
                  {!isGpo && !isContract && it.kind !== "LOW_CONFIDENCE_EXTRACTION" && <button type="button" className="btn-ghost !py-1 !text-[12px]" onClick={() => act(it.id, { type: "accept" })}>Accept</button>}
                  {it.kind === "LOW_CONFIDENCE_EXTRACTION" && <a className="btn-ghost !py-1 !text-[12px]" href={`/intelligence/extractions/${(it.payload as { extractionId?: string })?.extractionId ?? ""}`}>Open review</a>}
                  <button type="button" className="btn-ghost !py-1 !text-[12px]" onClick={() => act(it.id, { type: "dismiss" })}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

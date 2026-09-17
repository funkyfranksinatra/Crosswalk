"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Chip, relTime } from "@/components/ui";

type Queue = { name: string; queued: number; ready: number; active: number; failed: number; oldestReadySeconds: number | null };
type Failure = { id: string; queue: string; data: unknown; error: string | null; retries: number; failedAt: string | null };
type Feed = { name: string; title: string; description: string; cron: string | null; source: { kind: string; ref: string | null; present: string[] }; lastOk: string | null; lastRun: { status: string; startedAt: string; error: string | null; rows: number; created: number; updated: number; skipped: number; failed: number } | null; ageHours: number | null; maxAgeHours: number; stale: boolean };
type Alert = { id: string; fingerprint: string; rule: string; severity: string; title: string; detail: string | null; firstFiredAt: string; lastFiredAt: string; resolvedAt: string | null };
type System = {
  jobs: { enabled: boolean; mode: string; queues: Queue[]; failures: Failure[] };
  feeds: Feed[];
  alerts: { active: Alert[]; recentlyResolved: Alert[] };
  model: { available: boolean; model: string; last24h: { ok: number; failed: number } };
  openfda: { rpm: number; available: number; cacheTtlDays: number };
  notifications: { email: boolean; teams: boolean };
  logging: { format: string; level: string };
  tenancy: { mode: string; ok: boolean; note: string; company: { name: string } | null };
  embeddings: { available: boolean; enabled: boolean; model: string; own: { total: number; embedded: number }; competitor: { total: number; embedded: number } };
  tax: { provider: string; note: string };
};

const sevTone = (s: string) => (s === "CRITICAL" ? "none" : s === "WARNING" ? "alt" : "info");

export function SystemCard() {
  const [s, setS] = useState<System | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await fetch("/api/system", { cache: "no-store" }); if (r.ok) setS(await r.json()); else setMsg((await r.json()).error); }, []);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);
  async function act(action: string) {
    setMsg("Working…");
    const r = await fetch("/api/system", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const j = await r.json();
    setMsg(r.ok ? (action === "evaluate-alerts" ? `Evaluated: ${j.firing?.length ?? 0} firing, ${j.resolved ?? 0} resolved` : action === "retry-failed" ? `${j.resumed} job(s) queued again` : "Queued") : j.error);
    load();
  }
  async function runFeed(feed: string) {
    setMsg(`Queued ${feed}…`);
    const r = await fetch("/api/feeds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feed, force: true }) });
    const j = await r.json();
    setMsg(r.ok ? (j.alreadyQueued ? `${feed} is already queued` : `${feed} queued`) : j.error);
    setTimeout(load, 3000);
  }
  if (!s) return <Card title="System"><div className="text-muted text-[13px]">{msg ?? "Loading…"}</div></Card>;
  const stalled = s.jobs.queues.filter((q) => q.oldestReadySeconds !== null && q.oldestReadySeconds > 900);
  return (
    <Card title="System" subtitle="Background jobs, feeds and monitoring. Everything here is also on /api/health (liveness), /api/metrics (Prometheus) and /api/observability/export (NDJSON)." actions={<button className="btn-ghost !py-1 !text-[12px]" onClick={() => act("evaluate-alerts")}>Evaluate alerts now</button>}>
      {msg && <div className="text-[12.5px] text-ink-2 mb-3">{msg}</div>}

      <div className="eyebrow mb-2">Alerts</div>
      {s.alerts.active.length === 0 ? <div className="text-[12.5px] text-muted mb-4">Nothing firing.</div> : (
        <ul className="space-y-1.5 mb-4">
          {s.alerts.active.map((a) => <li key={a.id} className="text-[12.5px] flex gap-2 items-start"><Chip tone={sevTone(a.severity)}>{a.severity}</Chip><div><div>{a.title}</div>{a.detail && <div className="text-muted whitespace-pre-wrap">{a.detail}</div>}<div className="text-[11px] text-muted">since {relTime(a.firstFiredAt)}</div></div></li>)}
        </ul>
      )}

      <div className="eyebrow mb-2">Jobs <span className="normal-case text-muted font-normal">· worker {s.jobs.enabled ? s.jobs.mode : "disabled"}{stalled.length ? ` · stalled: ${stalled.map((q) => q.name).join(", ")}` : ""}</span></div>
      <table className="table text-[12px] mb-2">
        <thead><tr><th>Queue</th><th className="text-right">Ready</th><th className="text-right">Active</th><th className="text-right">Failed</th><th className="text-right">Oldest waiting</th></tr></thead>
        <tbody>{s.jobs.queues.map((q) => <tr key={q.name}><td className="mono">{q.name}</td><td className="mono text-right">{q.ready}</td><td className="mono text-right">{q.active}</td><td className="mono text-right">{q.failed}</td><td className="mono text-right">{q.oldestReadySeconds === null ? "—" : `${Math.round(q.oldestReadySeconds / 60)} min`}</td></tr>)}</tbody>
      </table>
      {s.jobs.failures.length > 0 && (
        <div className="mb-4 text-[12px]">
          <div className="flex items-center justify-between"><span className="text-muted">{s.jobs.failures.length} recent failure(s)</span><button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => act("retry-failed")}>Retry failed jobs</button></div>
          <ul className="mt-1 space-y-0.5">{s.jobs.failures.slice(0, 5).map((f) => <li key={f.id} className="truncate"><span className="mono">{f.queue}</span> · {f.error ?? "?"} <span className="text-muted">{f.failedAt ? relTime(f.failedAt) : ""}</span></li>)}</ul>
        </div>
      )}

      <div className="eyebrow mb-2 mt-2">Feeds</div>
      <table className="table text-[12px] mb-4">
        <thead><tr><th>Feed</th><th>Source</th><th>Schedule (UTC)</th><th>Last OK</th><th>Last run</th><th></th></tr></thead>
        <tbody>{s.feeds.map((f) => (
          <tr key={f.name}>
            <td title={f.description}>{f.title}</td>
            <td className="text-muted">{f.source.kind === "none" ? "not connected" : f.source.kind === "api" ? f.source.ref : `file (${f.source.present.join(", ")})`}</td>
            <td className="mono">{f.cron ?? "off"}</td>
            <td>{f.lastOk ? <span className={f.stale ? "text-alt" : ""}>{relTime(f.lastOk)}{f.stale ? " · stale" : ""}</span> : f.source.kind === "none" ? "—" : <span className={f.stale ? "text-alt" : ""}>never{f.stale ? " · stale" : ""}</span>}</td>
            <td>{f.lastRun ? <span className={f.lastRun.status === "FAILED" ? "text-none" : ""}>{f.lastRun.status} · {f.lastRun.created}+{f.lastRun.updated} / {f.lastRun.rows}{f.lastRun.error ? ` · ${f.lastRun.error.slice(0, 60)}` : ""}</span> : "—"}</td>
            <td className="text-right">{f.source.kind !== "none" && <button className="btn-ghost !py-0.5 !text-[11px]" onClick={() => runFeed(f.name)}>Run now</button>}</td>
          </tr>
        ))}</tbody>
      </table>

      <dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-[12.5px]">
        <dt className="text-muted">Model (24 h)</dt><dd>{s.model.available ? `${s.model.model} · ${s.model.last24h.ok} ok / ${s.model.last24h.failed} failed` : "not configured"}</dd>
        <dt className="text-muted">openFDA</dt><dd>{s.openfda.rpm} req/min budget · cache TTL {s.openfda.cacheTtlDays} days <button className="btn-ghost !py-0 !text-[11px] ml-2" onClick={() => act("refresh-gudid")}>Refresh stale records</button></dd>
        <dt className="text-muted">Notifications</dt><dd>in-app{s.notifications.email ? " · email" : ""}{s.notifications.teams ? " · Teams" : ""}{!s.notifications.email && !s.notifications.teams ? " (set SMTP_URL / MAIL_FROM or TEAMS_WEBHOOK_URL for external delivery)" : ""}</dd>
        <dt className="text-muted">Logging</dt><dd className="mono">{s.logging.format} · {s.logging.level}</dd>
        <dt className="text-muted">Tenancy</dt><dd className={s.tenancy.ok ? "" : "text-alt"}>{s.tenancy.note}</dd>
        <dt className="text-muted">Retrieval</dt><dd>{!s.embeddings.available ? "pgvector not installed in this database (attribute scan only)" : !s.embeddings.enabled ? "embeddings off (no model key or EMBEDDINGS=off) — attribute scan" : `${s.embeddings.model} · catalog ${s.embeddings.own.embedded}/${s.embeddings.own.total} embedded · competitor ${s.embeddings.competitor.embedded}/${s.embeddings.competitor.total}`}{s.embeddings.available && s.embeddings.enabled && s.embeddings.own.embedded < s.embeddings.own.total ? <span className="text-muted"> — run <span className="kbd">npm run embed</span> or wait for the nightly sweep</span> : null}</dd>
        <dt className="text-muted">Tax</dt><dd>{s.tax.note}</dd>
      </dl>
    </Card>
  );
}

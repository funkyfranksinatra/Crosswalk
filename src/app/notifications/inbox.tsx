"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Chip, Empty, relTime } from "@/components/ui";

type Item = { id: string; kind: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string; deliveriesJson: string | null };
type Pref = { kind: string; inApp: boolean; email: boolean; teams: boolean };
type PrefData = { kinds: string[]; channels: { email: boolean; teams: boolean }; preferences: Pref[] };

const LABEL: Record<string, string> = { RUN_COMPLETE: "Run complete", RUN_FAILED: "Run failed", APPROVAL_REQUESTED: "Approval requested", APPROVAL_DECIDED: "Approval decided", PROPOSAL_APPROVED: "Proposal approved", CROSS_PROPOSED: "Cross proposed", FEED_FAILED: "Feed failed", ALERT: "System alert", JOB_FAILED: "Job failed", BREAK_GLASS: "Break-glass approval" };
const tone = (k: string) => (k === "ALERT" || k.endsWith("_FAILED") ? "none" : k === "PROPOSAL_APPROVED" || k === "RUN_COMPLETE" ? "exact" : k === "APPROVAL_REQUESTED" ? "alt" : "info");

function toPath(link: string | null) {
  if (!link) return null;
  try { const u = new URL(link, "http://x"); return u.pathname + u.search; } catch { return link; }
}

export function Inbox() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [prefs, setPrefs] = useState<PrefData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch(`/api/notifications?take=100${unreadOnly ? "&unread=1" : ""}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (r.ok) { setItems(j.items ?? []); setErr(null); } else { setItems([]); setErr(j.error ?? `Could not load notifications (${r.status})`); }
    } catch { if (mine === seq.current) { setItems([]); setErr("Could not reach the server"); } }
  }, [unreadOnly]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { let stop = false; fetch("/api/notifications/preferences", { cache: "no-store" }).then(async (r) => { if (stop) return; if (r.ok) setPrefs(await r.json()); else setErr((await r.json().catch(() => ({}))).error ?? `Could not load preferences (${r.status})`); }).catch(() => { if (!stop) setErr("Could not reach the server"); }); return () => { stop = true; }; }, []);
  async function post(body: unknown) { try { const r = await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? `Could not update (${r.status})`); } catch { setErr("Could not reach the server"); } load(); }
  async function markAll() { await post({ all: true }); }
  async function markOne(id: string) { await post({ ids: [id] }); }
  async function setPref(kind: string, patch: Partial<Pref>) {
    try {
      const r = await fetch("/api/notifications/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, ...patch }) });
      if (!r.ok) { setErr((await r.json().catch(() => ({}))).error ?? `Could not save the preference (${r.status})`); return; }
      const p = await fetch("/api/notifications/preferences", { cache: "no-store" }); if (p.ok) setPrefs(await p.json());
    } catch { setErr("Could not reach the server"); }
  }
  const prefFor = (kind: string): Pref => prefs?.preferences.find((p) => p.kind === kind) ?? prefs?.preferences.find((p) => p.kind === "*") ?? { kind, inApp: true, email: true, teams: ["ALERT", "FEED_FAILED", "JOB_FAILED"].includes(kind) };
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 items-start [&>*]:min-w-0">
      <Card title="Inbox" actions={<div className="flex items-center gap-2"><label className="flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label><button type="button" className="btn-ghost !py-1 !text-[12px]" disabled={!items || !items.some((n) => !n.readAt)} onClick={markAll}>Mark all read</button></div>} padded={false}>
        {err && <div role="alert" className="px-5 py-3 text-[12.5px] text-none border-b border-line-2">{err}</div>}
        {!items ? <div className="p-5 text-muted text-[13px]" aria-busy="true">Loading…</div> : items.length === 0 ? <div className="p-6"><Empty title="Nothing here">{unreadOnly ? "No unread notifications." : "You have no notifications yet."}</Empty></div> : (
          <ul className="divide-y divide-line">
            {items.map((n) => {
              const path = toPath(n.link);
              return (
                <li key={n.id} className={`px-5 py-3 flex gap-3 ${n.readAt ? "" : "bg-accent-soft/30"}`}>
                  <div className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${n.readAt ? "bg-transparent" : "bg-accent"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11.5px] text-muted"><Chip tone={tone(n.kind)}>{LABEL[n.kind] ?? n.kind}</Chip><span>{relTime(n.createdAt)}</span></div>
                    <div className="text-[13.5px] mt-1">{path ? <Link href={path} className="hover:underline" onClick={() => { if (!n.readAt) markOne(n.id); }}>{n.title}</Link> : n.title}</div>
                    {n.body && <div className="text-[12.5px] text-ink-2 mt-0.5 whitespace-pre-wrap">{n.body}</div>}
                  </div>
                  {!n.readAt && <button type="button" className="btn-ghost !py-0.5 !text-[11px] self-start" aria-label={`Mark "${n.title}" read`} onClick={() => markOne(n.id)}>Read</button>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Delivery" subtitle={prefs ? `In-app is always available. ${prefs.channels.email ? "Email is configured." : "Email is not configured (SMTP_URL / MAIL_FROM)."} ${prefs.channels.teams ? "Teams is configured." : "Teams is not configured (TEAMS_WEBHOOK_URL)."}` : undefined}>
        {!prefs ? <div className="text-muted text-[13px]">Loading…</div> : (
          <table className="table text-[12.5px]">
            <thead><tr><th>Event</th><th className="text-center">In-app</th><th className="text-center">Email</th><th className="text-center">Teams</th></tr></thead>
            <tbody>
              {prefs.kinds.map((k) => { const p = prefFor(k); return (
                <tr key={k}>
                  <td>{LABEL[k] ?? k}</td>
                  <td className="text-center"><input type="checkbox" aria-label={`${LABEL[k] ?? k} in-app`} checked={p.inApp} onChange={(e) => setPref(k, { inApp: e.target.checked })} /></td>
                  <td className="text-center"><input type="checkbox" aria-label={`${LABEL[k] ?? k} by e-mail`} checked={p.email} disabled={!prefs.channels.email} title={prefs.channels.email ? undefined : "E-mail delivery is not configured on this server"} onChange={(e) => setPref(k, { email: e.target.checked })} /></td>
                  <td className="text-center"><input type="checkbox" aria-label={`${LABEL[k] ?? k} by Teams`} checked={p.teams} disabled={!prefs.channels.teams} title={prefs.channels.teams ? undefined : "Teams delivery is not configured on this server"} onChange={(e) => setPref(k, { teams: e.target.checked })} /></td>
                </tr>
              ); })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

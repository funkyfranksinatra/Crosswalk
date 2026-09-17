"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Chip } from "@/components/ui";

type D = { id: string; fromUserId: string; toUserId: string; startsAt: string; endsAt: string; reason: string | null; state: "active" | "scheduled" | "expired" | "revoked"; from: { id: string; name: string }; to: { id: string; name: string } };
type Data = { delegations: D[]; users: { id: string; name: string; email: string; roles: string[] }[]; me: string; admin: boolean };

/** Out-of-office: lend your approval authority to a colleague for a window. */
export function DelegationPanel({ onChange }: { onChange?: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ fromUserId: "", toUserId: "", startsAt: new Date().toISOString().slice(0, 10), endsAt: "", reason: "" });
  const load = useCallback(async () => { const r = await fetch("/api/approvals/delegations", { cache: "no-store" }); if (r.ok) setData(await r.json()); }, []);
  useEffect(() => { load(); }, [load]);
  async function create() {
    setErr(null);
    const r = await fetch("/api/approvals/delegations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, fromUserId: form.fromUserId || null, startsAt: form.startsAt ? `${form.startsAt}T00:00:00Z` : null, endsAt: `${form.endsAt}T23:59:59Z` }) });
    const j = await r.json(); if (!r.ok) { setErr(j.error); return; }
    setForm({ ...form, toUserId: "", endsAt: "", reason: "" }); setOpen(false); load(); onChange?.();
  }
  async function revoke(id: string) { const r = await fetch(`/api/approvals/delegations/${id}`, { method: "DELETE" }); if (!r.ok) setErr((await r.json()).error); load(); onChange?.(); }
  if (!data) return null;
  const live = data.delegations.filter((d) => d.state === "active" || d.state === "scheduled");
  const received = live.filter((d) => d.toUserId === data.me);
  const given = live.filter((d) => d.fromUserId === data.me || (data.admin && d.toUserId !== data.me));
  const approvers = data.users.filter((u) => u.roles.some((r) => ["REGIONAL_MANAGER", "CONTRACTING_MANAGER", "PRICING_DIRECTOR", "PRICING_COMMITTEE"].includes(r)));
  return (
    <Card className="mb-4" padded={false}>
      <div className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
        <span className="font-medium">Out of office</span>
        {received.length > 0 && <span className="text-muted">Covering for {received.map((d) => `${d.from.name} (until ${d.endsAt.slice(0, 10)})`).join(", ")}</span>}
        {given.length > 0 && <span className="text-muted">{given.map((d) => `${d.from.id === data.me ? "Your" : d.from.name + "'s"} approvals → ${d.to.name} ${d.state === "scheduled" ? "from " + d.startsAt.slice(0, 10) : "until " + d.endsAt.slice(0, 10)}`).join(" · ")}</span>}
        {received.length === 0 && given.length === 0 && <span className="text-muted">No delegation set. Going away? Hand your queue to a colleague.</span>}
        <button className="btn-ghost !py-0.5 ml-auto text-[12px]" onClick={() => setOpen(!open)}>{open ? "Close" : "Delegate my approvals"}</button>
      </div>
      {open && (
        <div className="border-t border-line-2 px-4 py-3 grid grid-cols-[1fr_1fr_140px_140px_1fr_auto] gap-2 items-end text-[12.5px]">
          {data.admin ? <div><label className="label">On behalf of</label><select className="input" value={form.fromUserId} onChange={(e) => setForm({ ...form, fromUserId: e.target.value })}><option value="">Myself</option>{approvers.filter((u) => u.id !== data.me).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div> : <div className="text-muted self-center">Your discount authority (never admin rights) is lent for the window.</div>}
          <div><label className="label">Delegate to</label><select className="input" value={form.toUserId} onChange={(e) => setForm({ ...form, toUserId: e.target.value })}><option value="">Choose…</option>{data.users.filter((u) => u.id !== (form.fromUserId || data.me)).map((u) => <option key={u.id} value={u.id}>{u.name} — {u.roles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}</option>)}</select></div>
          <div><label className="label">From</label><input type="date" className="input" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></div>
          <div><label className="label">Until</label><input type="date" className="input" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></div>
          <div><label className="label">Reason (optional)</label><input className="input" placeholder="Annual leave" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
          <button className="btn-primary" disabled={!form.toUserId || !form.endsAt} onClick={create}>Save</button>
          {err && <div className="col-span-6 text-none">{err}</div>}
        </div>
      )}
      {(given.length > 0 || received.length > 0) && (
        <div className="border-t border-line-2 px-4 py-2 flex flex-wrap gap-2 text-[12px]">
          {[...given, ...received].map((d) => <span key={d.id} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1"><Chip tone={d.state === "active" ? "exact" : "alt"}>{d.state}</Chip>{d.from.name} → {d.to.name} · {d.startsAt.slice(0, 10)} – {d.endsAt.slice(0, 10)}{d.reason ? ` · ${d.reason}` : ""}{(d.fromUserId === data.me || data.admin) && <button className="text-none ml-1" onClick={() => revoke(d.id)}>revoke</button>}</span>)}
        </div>
      )}
    </Card>
  );
}

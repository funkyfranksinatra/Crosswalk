"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ContractTools() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ contractNumber: "", name: "", type: "LOCAL", accountNumber: "", gpoName: "", tier: "", currency: "USD", effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: "", status: "ACTIVE" });
  async function create() {
    let accountId: string | null = null, gpoId: string | null = null;
    if (f.accountNumber) { const a = await fetch(`/api/accounts?q=${encodeURIComponent(f.accountNumber)}`).then((r) => r.json()); accountId = a[0]?.id ?? null; if (!accountId) { setMsg("Account not found"); return; } }
    if (f.gpoName) { const g = await fetch(`/api/intelligence`).then(() => null); void g; }
    const r = await fetch("/api/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, accountId, gpoId, effectiveTo: f.effectiveTo || null }) });
    const j = await r.json(); if (!r.ok) { setMsg(j.error); return; }
    setOpen(false); router.push(`/contracts/${j.id}`);
  }
  return (
    <div className="relative">
      <button className="btn-primary" onClick={() => setOpen(!open)}>New contract</button>
      {open && (
        <div className="absolute right-0 top-12 z-20 w-[420px] card p-5" style={{ boxShadow: "var(--shadow-lg)" }}>
          <div className="font-semibold mb-2">New contract</div>
          <div className="grid grid-cols-2 gap-2">
            <input className="input mono" placeholder="Contract number" value={f.contractNumber} onChange={(e) => setF({ ...f, contractNumber: e.target.value })} />
            <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{["LOCAL", "IDN", "GPO", "NATIONAL"].map((t) => <option key={t}>{t}</option>)}</select>
            <input className="input col-span-2" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <input className="input" placeholder="Account number (LOCAL/IDN)" value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} />
            <input className="input" placeholder="Tier (e.g. Tier 2)" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} />
            <input className="input" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
            <input className="input" type="date" value={f.effectiveTo} onChange={(e) => setF({ ...f, effectiveTo: e.target.value })} />
          </div>
          {msg && <div className="text-none text-[12px] mt-2">{msg}</div>}
          <div className="flex justify-end gap-2 mt-3"><button className="btn-ghost" onClick={() => setOpen(false)}>Close</button><button className="btn-primary" disabled={!f.contractNumber || !f.name} onClick={create}>Create</button></div>
        </div>
      )}
    </div>
  );
}

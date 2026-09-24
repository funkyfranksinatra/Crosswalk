"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { needs, usePermissions } from "@/components/permissions";
import { useDismiss } from "@/components/dismiss";

export type GpoOption = { id: string; name: string };
type Account = { id: string; name: string; accountNumber: string | null };

/**
 * New-contract popover. The GPO list comes from the server page (there is no GPO listing
 * route); LOCAL / IDN contracts look the account up by number, GPO contracts pick a GPO
 * and a tier, NATIONAL contracts need neither. The server validates everything again.
 */
export function ContractTools({ gpos }: { gpos: GpoOption[] }) {
  const router = useRouter();
  const { can } = usePermissions();
  const canManage = can("manage_contracts");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ contractNumber: "", name: "", type: "LOCAL", accountNumber: "", gpoId: "", tier: "", currency: "USD", effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: "", status: "ACTIVE" });
  const firstField = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) firstField.current?.focus(); }, [open]);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, popover, trigger);

  const needsAccount = f.type === "LOCAL" || f.type === "IDN";
  const needsGpo = f.type === "GPO";
  const incomplete = !f.contractNumber.trim() || !f.name.trim() || (needsAccount && !f.accountNumber.trim()) || (needsGpo && !f.gpoId) || !f.effectiveFrom;

  async function create() {
    if (busy) return;
    setMsg(null);
    if (f.effectiveTo && f.effectiveTo <= f.effectiveFrom) { setMsg("The end date must be after the start date."); return; }
    setBusy(true);
    try {
      let accountId: string | null = null;
      if (needsAccount) {
        const q = f.accountNumber.trim();
        const r = await fetch(`/api/accounts?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const list = (await r.json().catch(() => null)) as Account[] | { error?: string } | null;
        if (!r.ok || !Array.isArray(list)) { setMsg((list as { error?: string } | null)?.error ?? "Could not look the account up"); return; }
        // Prefer the exact account number; fall back to an exact name; never silently take "the first hit".
        const exact = list.find((a) => a.accountNumber === q) ?? list.find((a) => a.name.toLowerCase() === q.toLowerCase());
        if (!exact) { setMsg(list.length ? `No account with number "${q}" — ${list.length} similar: ${list.slice(0, 3).map((a) => `${a.name} (${a.accountNumber ?? "no number"})`).join(", ")}` : `Account "${q}" not found in your book`); return; }
        accountId = exact.id;
      }
      const gpoId = needsGpo ? f.gpoId : null;
      if (needsGpo && !gpos.some((g) => g.id === gpoId)) { setMsg("Choose a GPO for a GPO contract."); return; }
      const body = { contractNumber: f.contractNumber.trim(), name: f.name.trim(), type: f.type, status: f.status, currency: f.currency, tier: f.tier.trim() || null, accountId, gpoId, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null };
      const r = await fetch("/api/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(j.error ?? `Could not create the contract (${r.status})`); return; }
      setOpen(false); router.push(`/contracts/${j.id}`);
    } catch { setMsg("Could not reach the server"); } finally { setBusy(false); }
  }

  const button = <button ref={trigger} type="button" className="btn-primary" disabled={!canManage} title={canManage ? undefined : needs("manage_contracts")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>New contract</button>;
  if (!canManage) return button;
  return (
    <div className="relative">
      {button}
      {open && (
        <div ref={popover} role="dialog" aria-label="New contract" className="absolute right-0 top-12 z-20 w-[min(420px,calc(100vw-2rem))] card p-5" style={{ boxShadow: "var(--shadow-lg)" }}>
          <div className="font-semibold mb-2">New contract</div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label" htmlFor="nc-number">Contract number</label><input id="nc-number" ref={firstField} className="input mono" placeholder="MSK-2026-01" value={f.contractNumber} onChange={(e) => setF({ ...f, contractNumber: e.target.value })} /></div>
            <div><label className="label" htmlFor="nc-type">Type</label><select id="nc-type" className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, accountNumber: "", gpoId: "" })}>{["LOCAL", "IDN", "GPO", "NATIONAL"].map((t) => <option key={t}>{t}</option>)}</select></div>
            <div className="col-span-2"><label className="label" htmlFor="nc-name">Name</label><input id="nc-name" className="input" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            {needsAccount && <div><label className="label" htmlFor="nc-account">Account number</label><input id="nc-account" className="input mono" placeholder="0001880967" value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} /></div>}
            {needsGpo && (
              <div><label className="label" htmlFor="nc-gpo">GPO</label>
                <select id="nc-gpo" className="input" value={f.gpoId} onChange={(e) => setF({ ...f, gpoId: e.target.value })}>
                  <option value="">Choose a GPO…</option>
                  {gpos.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                {gpos.length === 0 && <span className="block text-[11.5px] text-alt font-normal mt-1">No GPOs on file yet — a GPO appears once an account has a membership (Accounts → memberships) or a roster is synced.</span>}
              </div>
            )}
            {!needsAccount && !needsGpo && <div className="text-[12px] text-muted self-end pb-2">Applies to every account.</div>}
            <div><label className="label" htmlFor="nc-tier">Tier</label><input id="nc-tier" className="input" placeholder="e.g. Tier 2" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} /></div>
            <div><label className="label" htmlFor="nc-from">Effective from</label><input id="nc-from" className="input" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></div>
            <div><label className="label" htmlFor="nc-to">Effective to</label><input id="nc-to" className="input" type="date" value={f.effectiveTo} min={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveTo: e.target.value })} /></div>
          </div>
          {msg && <div role="alert" className="text-none text-[12px] mt-2">{msg}</div>}
          <div className="flex justify-end gap-2 mt-3"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Close</button><button type="button" className="btn-primary" disabled={incomplete || busy} title={incomplete ? "Fill in the number, name, dates and the counterparty for this type" : undefined} onClick={create}>{busy ? "Creating…" : "Create"}</button></div>
        </div>
      )}
    </div>
  );
}

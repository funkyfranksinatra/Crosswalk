"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";

type Branding = { legalName: string; tagline: string | null; address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null; phone: string | null; email: string | null; website: string | null; primaryColor: string; accentColor: string; logoDataUrl: string | null; quoteTitle: string; offerTitle: string; quoteTerms: string; offerTerms: string; footer: string | null; validityDays: number };

/** Letterhead, colours and terms for the quote / contract-offer PDFs; also the ship-from for tax. */
export function BrandingCard({ canEdit }: { canEdit: boolean }) {
  const [b, setB] = useState<Branding | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => { let stop = false; fetch("/api/settings/branding", { cache: "no-store" }).then(async (r) => { if (stop) return; if (r.ok) setB(await r.json()); else setLoadErr(r.status === 403 ? "Branding is shown to roles with pricing visibility." : `Could not load branding (${r.status})`); }).catch(() => { if (!stop) setLoadErr("Could not reach the server"); }); return () => { stop = true; }; }, []);
  if (!b) return loadErr ? <Card title="Branding" subtitle="Letterhead, colours and terms on the PDF quote and contract offer"><div className="text-[12.5px] text-muted">{loadErr}</div></Card> : null;
  const addr = b.address ?? { line1: "", line2: "", city: "", region: "", postalCode: "", country: "US" };
  const set = (patch: Partial<Branding>) => setB({ ...b, ...patch });
  const setAddr = (k: keyof NonNullable<Branding["address"]>, v: string) => set({ address: { ...addr, [k]: v } });
  async function save() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { const r = await fetch("/api/settings/branding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (!r.ok) setMsg(j.error ?? `Could not save (${r.status})`); else { setB(j); setMsg("Saved."); } }
    catch { setMsg("Could not reach the server"); } finally { setBusy(false); }
  }
  async function logo(f: File) {
    if (!/^image\/(png|jpeg)$/.test(f.type)) { setMsg("Logo must be a PNG or JPEG"); return; }
    if (f.size > 300 * 1024) { setMsg(`Logo must be under 300 KB (this file is ${Math.round(f.size / 1024)} KB)`); return; }
    const reader = new FileReader(); reader.onload = () => { set({ logoDataUrl: String(reader.result) }); setMsg(null); }; reader.readAsDataURL(f);
  }
  return (
    <Card title="Branding" subtitle="Letterhead, colours and terms on the PDF quote and contract offer; the address is also the tax ship-from" actions={<button type="button" className="btn-ghost text-[12px]" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : canEdit ? "Edit" : "Details"}</button>}>
      <div className="flex items-center gap-3 text-[13px]">
        {b.logoDataUrl ? <img src={b.logoDataUrl} alt="logo" className="h-9 max-w-[140px] object-contain" /> : <span className="h-9 w-24 rounded bg-line-2 flex items-center justify-center text-[11px] text-muted">no logo</span>}
        <div><div className="font-semibold" style={{ color: b.primaryColor }}>{b.legalName}</div><div className="text-muted text-[12px]">{[addr.line1, addr.city, addr.region].filter(Boolean).join(", ") || "No address set"} · quotes valid {b.validityDays} days</div></div>
        <span className="ml-auto flex gap-1"><span className="h-4 w-4 rounded" style={{ background: b.primaryColor }} /><span className="h-4 w-4 rounded" style={{ background: b.accentColor }} /></span>
      </div>
      {open && canEdit && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-[12.5px]">
          <Field label="Legal name" value={b.legalName} onChange={(v) => set({ legalName: v })} />
          <Field label="Tagline" value={b.tagline ?? ""} onChange={(v) => set({ tagline: v })} />
          <Field label="Address line 1" value={addr.line1 ?? ""} onChange={(v) => setAddr("line1", v)} />
          <Field label="Address line 2" value={addr.line2 ?? ""} onChange={(v) => setAddr("line2", v)} />
          <div className="grid grid-cols-3 gap-2"><Field label="City" value={addr.city ?? ""} onChange={(v) => setAddr("city", v)} /><Field label="State" value={addr.region ?? ""} onChange={(v) => setAddr("region", v)} /><Field label="Postal code" value={addr.postalCode ?? ""} onChange={(v) => setAddr("postalCode", v)} /></div>
          <div className="grid grid-cols-3 gap-2"><Field label="Phone" value={b.phone ?? ""} onChange={(v) => set({ phone: v })} /><Field label="Email" value={b.email ?? ""} onChange={(v) => set({ email: v })} /><Field label="Website" value={b.website ?? ""} onChange={(v) => set({ website: v })} /></div>
          <div className="grid grid-cols-3 gap-2"><Field label="Primary colour" mono value={b.primaryColor} onChange={(v) => set({ primaryColor: v })} /><Field label="Accent colour" mono value={b.accentColor} onChange={(v) => set({ accentColor: v })} /><Field label="Quote validity (days)" mono value={String(b.validityDays)} onChange={(v) => set({ validityDays: (v === "" ? 0 : Number(v)) as number })} /></div>
          <div><label className="label" htmlFor="branding-logo">Logo (PNG/JPEG, under 300 KB)</label><input id="branding-logo" type="file" accept="image/png,image/jpeg" className="text-[12px]" onChange={(e) => { const f = e.target.files?.[0]; if (f) logo(f); e.target.value = ""; }} />{b.logoDataUrl && <button type="button" className="text-none text-[12px] ml-2" onClick={() => set({ logoDataUrl: null })}>remove</button>}</div>
          <div className="grid grid-cols-2 gap-2"><Field label="Quote title" value={b.quoteTitle} onChange={(v) => set({ quoteTitle: v })} /><Field label="Offer title" value={b.offerTitle} onChange={(v) => set({ offerTitle: v })} /></div>
          <label className="label md:col-span-2">Quote terms<textarea className="input min-h-[80px] font-normal" value={b.quoteTerms} onChange={(e) => set({ quoteTerms: e.target.value })} /></label>
          <label className="label md:col-span-2">Contract-offer terms<textarea className="input min-h-[80px] font-normal" value={b.offerTerms} onChange={(e) => set({ offerTerms: e.target.value })} /></label>
          <Field className="md:col-span-2" label="Footer line" value={b.footer ?? ""} onChange={(v) => set({ footer: v })} />
          <div className="md:col-span-2 flex items-center gap-3"><button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save branding"}</button>{msg && <span role={msg === "Saved." ? "status" : "alert"} className={msg === "Saved." ? "text-exact" : "text-none"}>{msg}</span>}</div>
        </div>
      )}
      {open && !canEdit && <div className="mt-3 text-[12.5px] text-muted">Editing needs the configure settings permission.</div>}
    </Card>
  );
}

function Field({ label, value, onChange, mono, className = "" }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; className?: string }) {
  return <label className={`label ${className}`}>{label}<input className={`input font-normal ${mono ? "mono" : ""}`} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";

type Branding = { legalName: string; tagline: string | null; address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null; phone: string | null; email: string | null; website: string | null; primaryColor: string; accentColor: string; logoDataUrl: string | null; quoteTitle: string; offerTitle: string; quoteTerms: string; offerTerms: string; footer: string | null; validityDays: number };

/** Letterhead, colours and terms for the quote / contract-offer PDFs; also the ship-from for tax. */
export function BrandingCard({ canEdit }: { canEdit: boolean }) {
  const [b, setB] = useState<Branding | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { fetch("/api/settings/branding").then(async (r) => { if (r.ok) setB(await r.json()); }).catch(() => undefined); }, []);
  if (!b) return null;
  const addr = b.address ?? { line1: "", line2: "", city: "", region: "", postalCode: "", country: "US" };
  const set = (patch: Partial<Branding>) => setB({ ...b, ...patch });
  const setAddr = (k: keyof NonNullable<Branding["address"]>, v: string) => set({ address: { ...addr, [k]: v } });
  async function save() {
    setMsg(null);
    const r = await fetch("/api/settings/branding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const j = await r.json(); if (!r.ok) setMsg(j.error); else { setB(j); setMsg("Saved."); }
  }
  async function logo(f: File) {
    if (f.size > 300 * 1024) { setMsg("Logo must be under 300 KB"); return; }
    const reader = new FileReader(); reader.onload = () => set({ logoDataUrl: String(reader.result) }); reader.readAsDataURL(f);
  }
  return (
    <Card title="Branding" subtitle="Letterhead, colours and terms on the PDF quote and contract offer; the address is also the tax ship-from" actions={<button className="btn-ghost text-[12px]" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>}>
      <div className="flex items-center gap-3 text-[13px]">
        {b.logoDataUrl ? <img src={b.logoDataUrl} alt="logo" className="h-9 max-w-[140px] object-contain" /> : <span className="h-9 w-24 rounded bg-line-2 flex items-center justify-center text-[11px] text-muted">no logo</span>}
        <div><div className="font-semibold" style={{ color: b.primaryColor }}>{b.legalName}</div><div className="text-muted text-[12px]">{[addr.line1, addr.city, addr.region].filter(Boolean).join(", ") || "No address set"} · quotes valid {b.validityDays} days</div></div>
        <span className="ml-auto flex gap-1"><span className="h-4 w-4 rounded" style={{ background: b.primaryColor }} /><span className="h-4 w-4 rounded" style={{ background: b.accentColor }} /></span>
      </div>
      {open && canEdit && (
        <div className="mt-4 grid grid-cols-2 gap-3 text-[12.5px]">
          <div><label className="label">Legal name</label><input className="input" value={b.legalName} onChange={(e) => set({ legalName: e.target.value })} /></div>
          <div><label className="label">Tagline</label><input className="input" value={b.tagline ?? ""} onChange={(e) => set({ tagline: e.target.value })} /></div>
          <div><label className="label">Address line 1</label><input className="input" value={addr.line1 ?? ""} onChange={(e) => setAddr("line1", e.target.value)} /></div>
          <div><label className="label">Address line 2</label><input className="input" value={addr.line2 ?? ""} onChange={(e) => setAddr("line2", e.target.value)} /></div>
          <div className="grid grid-cols-3 gap-2"><div><label className="label">City</label><input className="input" value={addr.city ?? ""} onChange={(e) => setAddr("city", e.target.value)} /></div><div><label className="label">State</label><input className="input" value={addr.region ?? ""} onChange={(e) => setAddr("region", e.target.value)} /></div><div><label className="label">Postal code</label><input className="input" value={addr.postalCode ?? ""} onChange={(e) => setAddr("postalCode", e.target.value)} /></div></div>
          <div className="grid grid-cols-3 gap-2"><div><label className="label">Phone</label><input className="input" value={b.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} /></div><div><label className="label">Email</label><input className="input" value={b.email ?? ""} onChange={(e) => set({ email: e.target.value })} /></div><div><label className="label">Website</label><input className="input" value={b.website ?? ""} onChange={(e) => set({ website: e.target.value })} /></div></div>
          <div className="grid grid-cols-3 gap-2"><div><label className="label">Primary colour</label><input className="input mono" value={b.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} /></div><div><label className="label">Accent colour</label><input className="input mono" value={b.accentColor} onChange={(e) => set({ accentColor: e.target.value })} /></div><div><label className="label">Quote validity (days)</label><input className="input mono" value={String(b.validityDays)} onChange={(e) => set({ validityDays: (e.target.value === "" ? 0 : Number(e.target.value)) as number })} /></div></div>
          <div><label className="label">Logo (PNG/JPEG, under 300 KB)</label><input type="file" accept="image/png,image/jpeg" className="text-[12px]" onChange={(e) => e.target.files?.[0] && logo(e.target.files[0])} />{b.logoDataUrl && <button className="text-none text-[12px] ml-2" onClick={() => set({ logoDataUrl: null })}>remove</button>}</div>
          <div className="grid grid-cols-2 gap-2"><div><label className="label">Quote title</label><input className="input" value={b.quoteTitle} onChange={(e) => set({ quoteTitle: e.target.value })} /></div><div><label className="label">Offer title</label><input className="input" value={b.offerTitle} onChange={(e) => set({ offerTitle: e.target.value })} /></div></div>
          <div className="col-span-2"><label className="label">Quote terms</label><textarea className="input min-h-[80px]" value={b.quoteTerms} onChange={(e) => set({ quoteTerms: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">Contract-offer terms</label><textarea className="input min-h-[80px]" value={b.offerTerms} onChange={(e) => set({ offerTerms: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">Footer line</label><input className="input" value={b.footer ?? ""} onChange={(e) => set({ footer: e.target.value })} /></div>
          <div className="col-span-2 flex items-center gap-3"><button className="btn-primary" onClick={save}>Save branding</button>{msg && <span className={msg === "Saved." ? "text-exact" : "text-none"}>{msg}</span>}</div>
        </div>
      )}
      {open && !canEdit && <div className="mt-3 text-[12.5px] text-muted">Editing needs the configure settings permission.</div>}
    </Card>
  );
}

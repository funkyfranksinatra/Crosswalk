/**
 * Branding for customer-facing artefacts (Tier 3.4): legal name, address, contact, colours,
 * logo and the terms printed on quotes and contract offers. Stored as one Setting row
 * ("branding"); the logo is a small data URL (PNG/JPEG/SVG ≤ 300 KB) so the PDF renderer
 * needs no file store. Also the ship-from address for tax calculation.
 */
import { prisma } from "@/lib/db";
import type { Address } from "@/lib/tax/types";

export type Branding = {
  legalName: string;
  tagline: string | null;
  address: Address | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  primaryColor: string; // hex
  accentColor: string; // hex
  logoDataUrl: string | null;
  quoteTitle: string;
  offerTitle: string;
  quoteTerms: string;
  offerTerms: string;
  footer: string | null;
  validityDays: number;
};

export const DEFAULT_TERMS = {
  quote: "Prices are per unit in the stated currency and exclude tax and freight unless shown. Equivalents are proposed on the basis of the published clinical cross-reference; clinical evaluation by your staff is recommended before conversion. This quotation is valid through the date shown and is subject to our standard terms and conditions of sale.",
  offer: "This contract offer sets out proposed pricing for the products listed for the term stated. Pricing is contingent on the volumes shown, on the customer's continued eligibility under any referenced group purchasing agreement, and on acceptance within the validity period. Product availability, tax and freight are governed by the terms of sale in force at the time of order.",
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_BYTES = 300 * 1024;

export async function getBranding(): Promise<Branding> {
  const [row, company] = await Promise.all([prisma.setting.findUnique({ where: { key: "branding" } }), prisma.setting.findUnique({ where: { key: "companyName" } })]);
  const name = company?.value ?? process.env.COMPANY_NAME ?? "Medtronic";
  const base: Branding = { legalName: name, tagline: null, address: null, phone: null, email: null, website: null, primaryColor: "#0f3d5e", accentColor: "#1a7f6e", logoDataUrl: null, quoteTitle: "Quotation", offerTitle: "Contract Offer", quoteTerms: DEFAULT_TERMS.quote, offerTerms: DEFAULT_TERMS.offer, footer: null, validityDays: 60 };
  if (!row) return base;
  try { return { ...base, ...sanitizeBranding(JSON.parse(row.value), base) }; } catch { return base; }
}

export function sanitizeBranding(input: unknown, base?: Branding): Partial<Branding> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string, max: number) => (o[k] === undefined ? undefined : o[k] === null || o[k] === "" ? null : String(o[k]).trim().slice(0, max));
  const out: Partial<Branding> = {};
  const legalName = str("legalName", 120); if (legalName) out.legalName = legalName;
  for (const k of ["tagline", "phone", "email", "website", "footer"] as const) { const v = str(k, k === "footer" ? 400 : 160); if (v !== undefined) out[k] = v; }
  if (o.address !== undefined) { const a = o.address && typeof o.address === "object" ? (o.address as Record<string, unknown>) : null; const s = (k: string) => (a?.[k] == null ? null : String(a[k]).trim().slice(0, 120) || null); const addr = a ? { line1: s("line1"), line2: s("line2"), city: s("city"), region: s("region"), postalCode: s("postalCode"), country: s("country") ?? "US" } : null; out.address = addr && Object.values(addr).some(Boolean) ? addr : null; }
  for (const k of ["primaryColor", "accentColor"] as const) { const v = str(k, 7); if (v === undefined) continue; if (v && !HEX.test(v)) throw new Error(`${k} must be a hex colour like #0f3d5e`); out[k] = v ?? base?.[k] ?? "#0f3d5e"; }
  for (const k of ["quoteTitle", "offerTitle"] as const) { const v = str(k, 60); if (v) out[k] = v; }
  for (const k of ["quoteTerms", "offerTerms"] as const) { const v = str(k, 4000); if (v !== undefined) out[k] = v ?? (k === "quoteTerms" ? DEFAULT_TERMS.quote : DEFAULT_TERMS.offer); }
  if (o.validityDays !== undefined) { const n = Number(o.validityDays); if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("validityDays must be 1–365"); out.validityDays = n; }
  if (o.logoDataUrl !== undefined) {
    if (o.logoDataUrl === null || o.logoDataUrl === "") out.logoDataUrl = null;
    else {
      const v = String(o.logoDataUrl);
      const m = v.match(/^data:image\/(png|jpeg|jpg|svg\+xml);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new Error("logo must be a PNG, JPEG or SVG data URL");
      if (Buffer.from(m[2], "base64").length > MAX_LOGO_BYTES) throw new Error("logo must be under 300 KB");
      out.logoDataUrl = v;
    }
  }
  return out;
}

export async function saveBranding(input: unknown): Promise<Branding> {
  const current = await getBranding();
  const patch = sanitizeBranding(input, current);
  const merged = { ...current, ...patch };
  await prisma.setting.upsert({ where: { key: "branding" }, create: { key: "branding", value: JSON.stringify(merged) }, update: { value: JSON.stringify(merged) } });
  return merged;
}

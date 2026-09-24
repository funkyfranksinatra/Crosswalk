/**
 * Tenancy (Tier 3.6): Crosswalk is SINGLE-TENANT PER DEPLOYMENT. One company — the one whose
 * products are "ours" — per database. `Company` stays a table (the catalog, requests and
 * prices hang off it) but there is exactly one row that matters, and every code path reads it
 * through `getCompany()`. A second customer gets a second deployment: separate database,
 * separate secrets, separate model key — the simplest thing that is also the safest.
 *
 * This module makes that explicit: a startup check that refuses (strict) or warns when more
 * than one Company row exists (drift from a renamed COMPANY_NAME, or an old seed), a status
 * line for Settings → System, and the company defaults the seeds and `getCompany()` share:
 *
 *   COMPANY_NAME   the company's name (default Medtronic)
 *   OWN_LABELERS   comma-separated openFDA labeler names that count as "us" when the Company
 *                  row is first created (default Covidien, Medtronic, Sofradim). Read only at
 *                  creation: the stored `Company.labelers` list is the truth afterwards.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { getCompany } from "@/lib/settings";

type Env = Record<string, string | undefined>;

export const DEFAULT_COMPANY_NAME = "Medtronic";
const DEFAULT_LABELERS = ["Covidien", "Medtronic", "Sofradim"];

/** The company name a fresh deployment is created with. */
export function defaultCompanyName(env: Env = process.env): string {
  return env.COMPANY_NAME?.trim() || DEFAULT_COMPANY_NAME;
}

/** The own-labeler list a fresh Company row is created with (OWN_LABELERS, comma-separated). */
export function defaultLabelers(env: Env = process.env): string[] {
  const raw = env.OWN_LABELERS;
  if (raw === undefined || !raw.trim()) return [...DEFAULT_LABELERS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) { const v = part.trim(); if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); } }
  return out.length ? out : [...DEFAULT_LABELERS];
}

export type TenancyStatus = { mode: "single"; company: { id: string; name: string; labelers: string[] } | null; companies: { id: string; name: string; products: number; requests: number }[]; ok: boolean; note: string };

export async function tenancyStatus(): Promise<TenancyStatus> {
  const rows = await prisma.company.findMany({ include: { _count: { select: { products: true, requests: true } } }, orderBy: { createdAt: "asc" } });
  const primary = rows.length ? await getCompany() : null;
  const companies = rows.map((c) => ({ id: c.id, name: c.name, products: c._count.products, requests: c._count.requests }));
  const extra = companies.filter((c) => c.id !== primary?.id);
  const note = !primary ? "No company yet: the first settings save or seed creates it." : extra.length ? `${extra.length} extra company row(s) (${extra.map((c) => `${c.name}: ${c.products} products, ${c.requests} requests`).join("; ")}). Only "${primary.name}" is served; merge or remove the others.` : `Single tenant: ${primary.name}.`;
  return { mode: "single", company: primary ? { id: primary.id, name: primary.name, labelers: JSON.parse(primary.labelers || "[]") } : null, companies, ok: extra.length === 0, note };
}

/** True unless TENANCY_STRICT=false: a second Company row refuses start-up instead of only warning. */
export function tenancyStrict(env: Env = process.env): boolean {
  return (env.TENANCY_STRICT ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Called once at startup (instrumentation, worker). With `strict` (the default) a database that
 * holds more than one Company row makes it throw "Refusing to start …" — the web server and the
 * worker must not serve a database whose catalog is split across companies nobody is looking at.
 * A missing company is not an error (the seed or the first settings save creates it). A database
 * that cannot be reached is only warned about: the caller's own connection handling reports that.
 */
export async function checkTenancy(opts: { strict?: boolean } = {}): Promise<void> {
  const strict = opts.strict ?? tenancyStrict();
  let t: TenancyStatus;
  try { t = await tenancyStatus(); } catch (e) { log.warn("tenancy.check_failed", { error: e instanceof Error ? e.message : String(e) }); return; }
  if (t.ok) { log.info("tenancy.single", { company: t.company?.name ?? null }); return; }
  log[strict ? "error" : "warn"]("tenancy.multiple_companies", { companies: t.companies, served: t.company?.name ?? null, strict });
  if (strict) throw new Error(`Refusing to start: ${t.companies.length} Company rows in one database (${t.companies.map((c) => `"${c.name}"`).join(", ")}); Crosswalk is single-tenant per deployment — remove or merge the extra rows, or set TENANCY_STRICT=false to serve "${t.company?.name}" and only warn`);
}

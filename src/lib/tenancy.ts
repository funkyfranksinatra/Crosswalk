/**
 * Tenancy (Tier 3.6): Crosswalk is SINGLE-TENANT PER DEPLOYMENT. One company — the one whose
 * products are "ours" — per database. `Company` stays a table (the catalog, requests and
 * prices hang off it) but there is exactly one row that matters, and every code path reads it
 * through `getCompany()`. A second customer gets a second deployment: separate database,
 * separate secrets, separate model key — the simplest thing that is also the safest.
 *
 * This module makes that explicit: a startup check that warns when more than one Company row
 * exists (drift from a renamed COMPANY_NAME, or an old seed), a status line for Settings →
 * System, and a guard the seed uses so it never quietly creates a second company.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { getCompany } from "@/lib/settings";

export type TenancyStatus = { mode: "single"; company: { id: string; name: string; labelers: string[] } | null; companies: { id: string; name: string; products: number; requests: number }[]; ok: boolean; note: string };

export async function tenancyStatus(): Promise<TenancyStatus> {
  const rows = await prisma.company.findMany({ include: { _count: { select: { products: true, requests: true } } }, orderBy: { createdAt: "asc" } });
  const primary = rows.length ? await getCompany() : null;
  const companies = rows.map((c) => ({ id: c.id, name: c.name, products: c._count.products, requests: c._count.requests }));
  const extra = companies.filter((c) => c.id !== primary?.id);
  const note = !primary ? "No company yet: the first settings save or seed creates it." : extra.length ? `${extra.length} extra company row(s) (${extra.map((c) => `${c.name}: ${c.products} products, ${c.requests} requests`).join("; ")}). Only "${primary.name}" is served; merge or remove the others.` : `Single tenant: ${primary.name}.`;
  return { mode: "single", company: primary ? { id: primary.id, name: primary.name, labelers: JSON.parse(primary.labelers || "[]") } : null, companies, ok: extra.length === 0, note };
}

/** Called once at startup (instrumentation): never throws, only warns. */
export async function checkTenancy(): Promise<void> {
  try {
    const t = await tenancyStatus();
    if (!t.ok) log.warn("tenancy.multiple_companies", { companies: t.companies, served: t.company?.name ?? null });
    else log.info("tenancy.single", { company: t.company?.name ?? null });
  } catch (e) {
    log.warn("tenancy.check_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

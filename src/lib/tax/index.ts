/**
 * Freight and tax on a proposal (Tier 3.7). Both are QUOTE-LEVEL amounts: they sit under the
 * subtotal on the customer artefact and never enter line economics, margin, floors or
 * approvals — a rep cannot buy approval headroom by moving money into freight.
 *
 *   freightMode  NONE | FLAT (freightValue is an amount) | PCT (freightValue is a percent of subtotal)
 *   taxMode      NONE (quote says "excludes tax") | EXEMPT (certificate on file) | MANUAL (taxRate)
 *                | PROVIDER (AvaTax; needs a ship-to address)
 *
 * `calculateProposalTax` is on demand (button / before export) and stamps taxCalculatedAt;
 * a later price change makes the stamp older than the line — the workspace shows that as
 * "recalculate". The provider is chosen once: AvaTax when configured, else MANUAL.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, round, times, toDb, ZERO, type Money, type MoneyLike } from "@/lib/money";
import { getBranding } from "@/lib/branding";
import { log } from "@/lib/log";
import { AvataxProvider, avataxConfig } from "./avatax";
import { ManualTaxProvider } from "./manual";
import type { Address, TaxProvider, TaxRequest, TaxResult } from "./types";

export type { Address, TaxRequest, TaxResult, TaxProvider } from "./types";

export const FREIGHT_MODES = ["NONE", "FLAT", "PCT"] as const;
export const TAX_MODES = ["NONE", "EXEMPT", "MANUAL", "PROVIDER"] as const;

export function taxProviderStatus() {
  const a = avataxConfig();
  return { provider: a.configured ? "avatax" : "manual", avatax: { configured: a.configured, env: a.env, dryRun: a.dryRun }, note: a.configured ? `AvaTax (${a.env}${a.dryRun ? ", dry run" : ""})` : "No tax service configured: PROVIDER mode needs AVATAX_* in .env; MANUAL rate and EXEMPT work without one" };
}

export function computeFreight(subtotal: Money, mode: string, value: Money | null, currency: string): Money {
  if (mode === "FLAT") return round(value ?? ZERO, currency);
  if (mode === "PCT") return round(subtotal.times((value ?? ZERO).div(100)), currency);
  return ZERO;
}

export function parseAddress(v: unknown): Address | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (o[k] == null ? null : String(o[k]).trim().slice(0, 120) || null);
  const a = { line1: s("line1"), line2: s("line2"), city: s("city"), region: s("region"), postalCode: s("postalCode"), country: s("country") ?? "US" };
  // A country alone is not an address.
  return [a.line1, a.line2, a.city, a.region, a.postalCode].some(Boolean) ? a : null;
}

/**
 * What a tax figure depends on: the priced, included lines (price × qty), the freight and the
 * ship-to. Stored with the figure; a different fingerprint now means "recalculate". Notes,
 * approvals and other writes that bump a line's updatedAt do not touch it.
 */
export function taxFingerprint(p: { currency: string; freightMode: string; freightValue: MoneyLike; taxMode: string; taxRate: MoneyLike; taxExemptionNo: string | null; shipToJson: string | null; lines: { id: string; included: boolean; proposedPrice: MoneyLike; quantity: MoneyLike }[] }): string {
  const lines = p.lines.filter((l) => l.included && money(l.proposedPrice)).map((l) => `${l.id}:${money(l.proposedPrice)!.toString()}x${money(l.quantity)!.toString()}`).sort();
  return createHash("sha1").update([p.currency, p.freightMode, money(p.freightValue)?.toString() ?? "", p.taxMode, money(p.taxRate)?.toString() ?? "", p.taxExemptionNo ?? "", p.shipToJson ?? "", ...lines].join("|")).digest("hex");
}

/** Subtotal / freight / tax / total for the customer artefact — the one place these are added up. */
/** The address a tax calculation uses: the proposal's own ship-to, else the account's default. Fingerprinted as such. */
export function effectiveShipToJson(p: { shipToJson: string | null; account?: { shipToJson: string | null } | null }): string | null {
  return p.shipToJson ?? p.account?.shipToJson ?? null;
}

export async function quoteTotals(proposalId: string) {
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: { select: { shipToJson: true } }, lines: { orderBy: { lineNo: "asc" } } } });
  let subtotal = ZERO;
  for (const l of p.lines) if (l.included && money(l.proposedPrice)) subtotal = subtotal.plus(round(times(l.proposedPrice, l.quantity)!, p.currency));
  const freight = computeFreight(subtotal, p.freightMode, money(p.freightValue), p.currency);
  const tax = p.taxMode === "NONE" ? null : money(p.taxAmount);
  const total = subtotal.plus(freight).plus(tax ?? ZERO);
  const detail = p.taxDetailJson ? (JSON.parse(p.taxDetailJson) as { note?: string | null; fingerprint?: string | null }) : null;
  // Stale when what was taxed is not what is quoted now (a price, quantity, inclusion, freight or ship-to change).
  const stale = (p.taxMode === "MANUAL" || p.taxMode === "PROVIDER") && (!p.taxCalculatedAt || tax === null || detail?.fingerprint !== taxFingerprint({ ...p, shipToJson: effectiveShipToJson(p) }));
  return { currency: p.currency, subtotal, freight, freightMode: p.freightMode, tax, taxMode: p.taxMode, total, taxCalculatedAt: p.taxCalculatedAt, taxStale: stale, taxNote: detail?.note ?? null };
}

export type LogisticsInput = { freightMode?: string; freightValue?: unknown; taxMode?: string; taxRate?: unknown; taxExemptionNo?: string | null; shipTo?: unknown };

/** Set freight / tax mode and the ship-to on a proposal. Clears a stale tax amount when the mode changes. */
export async function setProposalLogistics(actor: Actor, proposalId: string, input: LogisticsInput) {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true } });
  if (["WON", "LOST"].includes(p.status)) throw new Error("Closed proposals cannot change freight or tax; create a new version");
  const data: Record<string, unknown> = {};
  if (input.freightMode !== undefined) {
    if (!FREIGHT_MODES.includes(input.freightMode as never)) throw new Error(`freightMode must be one of ${FREIGHT_MODES.join(", ")}`);
    data.freightMode = input.freightMode;
    if (input.freightMode === "NONE") data.freightValue = null;
  }
  if (input.freightValue !== undefined) {
    const v = input.freightValue === null || input.freightValue === "" ? null : money(input.freightValue as never);
    if (input.freightValue !== null && input.freightValue !== "" && (!v || v.lt(0) || v.gt(1e9))) throw new Error("freightValue must be a non-negative number");
    data.freightValue = toDb(v);
  }
  {
    // The percent bound holds whichever field changed (a FLAT 5000 must not become 5000 % on a mode switch).
    const mode = (data.freightMode as string) ?? p.freightMode;
    const v = data.freightValue !== undefined ? money(data.freightValue as never) : money(p.freightValue);
    if (mode === "PCT" && v && v.gt(100)) throw new Error("freight percent must be 0–100");
  }
  if (input.taxMode !== undefined) {
    if (!TAX_MODES.includes(input.taxMode as never)) throw new Error(`taxMode must be one of ${TAX_MODES.join(", ")}`);
    if (input.taxMode === "PROVIDER" && !avataxConfig().configured) throw new Error("PROVIDER mode needs a configured tax service (AVATAX_* in .env)");
    data.taxMode = input.taxMode;
    if (input.taxMode !== p.taxMode) { data.taxAmount = input.taxMode === "NONE" || input.taxMode === "EXEMPT" ? (input.taxMode === "EXEMPT" ? "0" : null) : null; data.taxCalculatedAt = input.taxMode === "EXEMPT" ? new Date() : null; data.taxDetailJson = input.taxMode === "EXEMPT" ? JSON.stringify({ note: "Tax exempt" }) : null; data.taxProvider = null; }
  }
  if (input.taxRate !== undefined) {
    const r = input.taxRate === null || input.taxRate === "" ? null : money(input.taxRate as never);
    if (r && (r.lt(0) || r.gt(0.5))) throw new Error("taxRate is a fraction between 0 and 0.5 (8.25% = 0.0825)");
    data.taxRate = toDb(r);
  }
  if (input.taxExemptionNo !== undefined) data.taxExemptionNo = input.taxExemptionNo ? String(input.taxExemptionNo).slice(0, 80) : null;
  if (input.shipTo !== undefined) { const a = parseAddress(input.shipTo); data.shipToJson = a ? JSON.stringify(a) : null; }
  // Saving the form unchanged must not throw the figure away (each recalculation can be a billable call):
  // the stored fingerprint decides staleness; here only drop fields that no longer apply.
  const same = (k: string, before: unknown) => data[k] === undefined || String(data[k] ?? "") === String(before ?? "");
  const unchanged = same("freightMode", p.freightMode) && same("freightValue", p.freightValue?.toString() ?? null) && same("taxRate", p.taxRate?.toString() ?? null) && same("shipToJson", p.shipToJson) && same("taxMode", p.taxMode);
  if (unchanged) { delete data.taxAmount; delete data.taxCalculatedAt; delete data.taxDetailJson; delete data.taxProvider; }
  const updated = await prisma.proposal.update({ where: { id: proposalId }, data });
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "LOGISTICS_CHANGED", before: { freightMode: p.freightMode, freightValue: p.freightValue?.toString() ?? null, taxMode: p.taxMode, taxRate: p.taxRate?.toString() ?? null }, after: { freightMode: updated.freightMode, freightValue: updated.freightValue?.toString() ?? null, taxMode: updated.taxMode, taxRate: updated.taxRate?.toString() ?? null, shipTo: updated.shipToJson ? JSON.parse(updated.shipToJson) : null } });
  return updated;
}

function providerFor(p: { taxMode: string; taxRate: unknown }): TaxProvider {
  if (p.taxMode === "PROVIDER") return new AvataxProvider();
  const rate = money(p.taxRate as never);
  if (!rate) throw new Error("MANUAL tax needs a rate (e.g. 0.0825)");
  return new ManualTaxProvider(rate);
}

/** Calculate (or recalculate) the tax amount for the proposal as it stands. */
export async function calculateProposalTax(actor: Actor, proposalId: string): Promise<{ result: TaxResult; totals: Awaited<ReturnType<typeof quoteTotals>> }> {
  requirePermission(actor, "edit_proposed_pricing");
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true, lines: { orderBy: { lineNo: "asc" } } } });
  if (p.taxMode === "NONE") throw new Error("Tax mode is NONE — the quote states that prices exclude tax");
  if (p.taxMode === "EXEMPT") {
    await prisma.proposal.update({ where: { id: proposalId }, data: { taxAmount: "0", taxCalculatedAt: new Date(), taxProvider: "exempt", taxDetailJson: JSON.stringify({ note: `Tax exempt${p.taxExemptionNo ? ` (certificate ${p.taxExemptionNo})` : ""}` }) } });
    return { result: { provider: "exempt", totalTax: "0", totalTaxable: "0", totalExempt: "0", lines: [], summary: [], note: "Tax exempt" }, totals: await quoteTotals(proposalId) };
  }
  const provider = providerFor(p);
  const branding = await getBranding();
  const shipTo = parseAddress(p.shipToJson ? JSON.parse(p.shipToJson) : null) ?? parseAddress(p.account.shipToJson ? JSON.parse(p.account.shipToJson) : null);
  if (p.taxMode === "PROVIDER" && !shipTo) throw new Error("Add a ship-to address (proposal, or the account's default) before calculating tax with the provider");
  const included = p.lines.filter((l) => l.included && money(l.proposedPrice));
  if (!included.length) throw new Error("No priced, included lines to tax");
  let subtotal = ZERO;
  const lines = included.map((l) => { const ext = round(times(l.proposedPrice, l.quantity)!, p.currency); subtotal = subtotal.plus(ext); return { number: String(l.lineNo), itemCode: l.sku, description: l.description, quantity: money(l.quantity)!.toString(), amount: ext.toString() }; });
  const freight = computeFreight(subtotal, p.freightMode, money(p.freightValue), p.currency);
  const req: TaxRequest = { currency: p.currency, date: new Date().toISOString().slice(0, 10), customerCode: p.account.accountNumber ?? p.account.id, exemptionNo: p.taxExemptionNo ?? (p.account.taxExempt ? p.account.taxExemptionNo ?? "EXEMPT" : null), shipFrom: branding.address ?? null, shipTo: shipTo ?? { country: "US" }, lines, freight: freight.gt(0) ? { amount: freight.toString() } : null };
  const t0 = Date.now();
  // The fingerprint is of the lines as READ — a price committed while the provider is answering changes it, so the figure lands stale.
  const fingerprint = taxFingerprint({ ...p, shipToJson: effectiveShipToJson(p), lines: p.lines });
  const result = await provider.calculate(req);
  const totalTax = round(money(result.totalTax) ?? ZERO, p.currency);
  await prisma.proposal.update({ where: { id: proposalId }, data: { taxAmount: toDb(totalTax), freightAmount: toDb(freight), taxCalculatedAt: new Date(), taxProvider: result.provider, taxDetailJson: JSON.stringify({ note: result.note ?? null, fingerprint, totalTaxable: result.totalTaxable, totalExempt: result.totalExempt, lines: result.lines, summary: result.summary, raw: result.raw ?? null, shipTo, freight: freight.toString(), subtotal: subtotal.toString() }) } });
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "TAX_CALCULATED", after: { provider: result.provider, taxAmount: totalTax.toString(), freight: freight.toString(), subtotal: subtotal.toString(), ms: Date.now() - t0 } });
  log.info("tax.calculated", { proposalId, provider: result.provider, tax: totalTax.toString(), ms: Date.now() - t0 });
  return { result, totals: await quoteTotals(proposalId) };
}

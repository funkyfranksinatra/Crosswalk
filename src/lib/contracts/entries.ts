/**
 * Contract price entries — one transactional write path (KN-18).
 *
 * A batch of "SKU, price[, band, dates]" rows either lands completely or not at all: every row is
 * validated and every SKU resolved BEFORE the transaction opens; inside it the contract row is
 * locked (`SELECT … FOR UPDATE`) so two batches for the same contract serialise and can never both
 * leave an ACTIVE entry for the same band, prior ACTIVE entries for the band are superseded and
 * the new ones created, and the audit event — with the counts that were actually written — is
 * part of the same transaction. The neon-http adapter has no transactions: rather than half-write,
 * the call is refused with a clear message.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, toDb, type Money } from "@/lib/money";

export const MAX_ENTRIES_PER_CALL = 5000;
const CURRENCY = /^[A-Z]{3}$/;

export type EntryRowInput = { sku: string; price: string | number; currency?: string; effectiveFrom?: string | Date | null; effectiveTo?: string | Date | null; tier?: string | null; minQty?: string | number | null; maxQty?: string | number | null; volumeTierName?: string | null };

type Validated = { sku: string; price: Money; currency: string; from: Date; to: Date | null; tier: string | null; minQty: Money | null; maxQty: Money | null; volumeTierName: string | null };

/** Adapters without transaction support must not run this path at all. */
export function entriesAdapterSupported(): { ok: boolean; reason: string | null } {
  const kind = (process.env.DATABASE_ADAPTER ?? "pg").toLowerCase();
  if (kind === "neon-http") return { ok: false, reason: "Price entries are written in one transaction; the neon-http database adapter cannot open transactions (use DATABASE_ADAPTER=pg or neon-ws)" };
  return { ok: true, reason: null };
}

const asDate = (v: unknown): Date | null => { if (!v) return null; const d = v instanceof Date ? v : new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };
const text = (v: unknown, max = 80): string | null => (v === null || v === undefined || v === "" ? null : String(v).trim().slice(0, max) || null);

/** Pure row validation: every problem is reported before anything is written. */
export function validateEntryRows(rows: unknown, contract: { currency: string; tier: string | null; effectiveTo: Date | null }, now = new Date()): Validated[] {
  if (!Array.isArray(rows)) throw new Error("entries must be a list");
  if (!rows.length) throw new Error("entries is empty");
  if (rows.length > MAX_ENTRIES_PER_CALL) throw new Error(`at most ${MAX_ENTRIES_PER_CALL.toLocaleString("en-US")} entries per call`);
  const out: Validated[] = [];
  rows.forEach((raw, i) => {
    const e = (raw ?? {}) as EntryRowInput;
    if (!e || typeof e.sku !== "string" || !e.sku.trim()) throw new Error(`entry ${i + 1}: every entry needs a sku`);
    const sku = e.sku.trim().toUpperCase();
    const price = money(e.price as never);
    if (price === null) throw new Error(`price for ${sku} must be a number`);
    if (price.lte(0)) throw new Error(`price for ${sku} must be positive`);
    if (price.gt("1000000000")) throw new Error(`price for ${sku} exceeds the supported range`);
    const band = (v: unknown, label: string): Money | null => { if (v === null || v === undefined || v === "") return null; const d = money(v as never); if (d === null) throw new Error(`${label} for ${sku} must be a number`); if (d.lt(0)) throw new Error(`${label} for ${sku} cannot be negative`); return d; };
    const minQty = band(e.minQty, "minQty"), maxQty = band(e.maxQty, "maxQty");
    if (minQty && maxQty && maxQty.lt(minQty)) throw new Error(`maxQty below minQty for ${sku}`);
    let currency = contract.currency;
    if (e.currency !== undefined && e.currency !== null && e.currency !== "") { currency = String(e.currency).toUpperCase(); if (!CURRENCY.test(currency)) throw new Error(`currency "${String(e.currency)}" is not a 3-letter code`); }
    if (currency !== contract.currency) throw new Error(`entry for ${sku} is in ${currency} but the contract is in ${contract.currency}`);
    if (e.effectiveFrom && !asDate(e.effectiveFrom)) throw new Error(`effectiveFrom for ${sku} is not a date`);
    if (e.effectiveTo && !asDate(e.effectiveTo)) throw new Error(`effectiveTo for ${sku} is not a date`);
    const from = asDate(e.effectiveFrom) ?? now;
    const to = asDate(e.effectiveTo) ?? contract.effectiveTo;
    if (to && to <= from) throw new Error(`effectiveTo before effectiveFrom for ${sku}`);
    out.push({ sku, price, currency, from, to, tier: text(e.tier) ?? contract.tier, minQty, maxQty, volumeTierName: text(e.volumeTierName, 120) });
  });
  // Two rows for the same SKU and band in one batch would supersede each other in list order — an
  // ambiguous instruction; refuse it rather than pick one.
  const seen = new Set<string>();
  for (const v of out) {
    const key = `${v.sku}|${v.minQty?.toString() ?? ""}|${v.maxQty?.toString() ?? ""}|${v.from.toISOString()}`;
    if (seen.has(key)) throw new Error(`duplicate entry for ${v.sku} with the same volume band and effective date in this batch`);
    seen.add(key);
  }
  return out;
}

export type EntriesResult = { created: number; superseded: number; unknown: string[] };

/**
 * Add / replace price entries on a contract (edit_contract_pricing). Effective-dated; never
 * deletes history — supersedes. Unknown SKUs are skipped and reported. All or nothing.
 */
export async function addContractEntries(actor: Actor, contractId: string, rows: unknown): Promise<EntriesResult> {
  requirePermission(actor, "edit_contract_pricing");
  const support = entriesAdapterSupported();
  if (!support.ok) throw new Error(support.reason!);
  const c = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!c) throw new Error("contract not found");
  if (["TERMINATED", "SUPERSEDED"].includes(c.status)) throw new Error(`cannot add prices to a ${c.status.toLowerCase()} contract`);
  const validated = validateEntryRows(rows, c);
  const company = await prisma.company.findFirstOrThrow();
  const products = await prisma.ownProduct.findMany({ where: { companyId: company.id, sku: { in: [...new Set(validated.map((v) => v.sku))] } }, select: { id: true, sku: true, category: true } });
  const bySku = new Map(products.map((p) => [p.sku.toUpperCase(), p]));
  const unknown = [...new Set(validated.filter((v) => !bySku.has(v.sku)).map((v) => v.sku))];
  const known = validated.filter((v) => bySku.has(v.sku));

  const result = await prisma.$transaction(async (tx) => {
    // Serialise batches per contract: the second writer waits here until the first commits, then
    // sees its entries and supersedes them instead of leaving two ACTIVE rows for one band.
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>(Prisma.sql`SELECT id, status FROM "Contract" WHERE id = ${contractId} FOR UPDATE`);
    if (!locked.length) throw new Error("contract not found");
    if (["TERMINATED", "SUPERSEDED"].includes(locked[0].status)) throw new Error(`cannot add prices to a ${locked[0].status.toLowerCase()} contract`);
    let created = 0, superseded = 0;
    for (const v of known) {
      const product = bySku.get(v.sku)!;
      const prior = await tx.priceEntry.findMany({ where: { contractId, productId: product.id, status: "ACTIVE", minQty: toDb(v.minQty), maxQty: toDb(v.maxQty) }, select: { id: true, effectiveFrom: true } });
      if (prior.length) {
        // An entry that started before the new one ends when it starts; one dated at or after it is just superseded.
        const ending = prior.filter((p) => p.effectiveFrom < v.from).map((p) => p.id), replaced = prior.filter((p) => p.effectiveFrom >= v.from).map((p) => p.id);
        if (ending.length) await tx.priceEntry.updateMany({ where: { id: { in: ending } }, data: { status: "SUPERSEDED", effectiveTo: v.from } });
        if (replaced.length) await tx.priceEntry.updateMany({ where: { id: { in: replaced } }, data: { status: "SUPERSEDED" } });
        superseded += prior.length;
      }
      await tx.priceEntry.create({ data: { contractId, accountId: c.accountId, gpoId: c.gpoId, productId: product.id, productFamily: product.category, price: toDb(v.price)!, currency: v.currency, effectiveFrom: v.from, effectiveTo: v.to, tier: v.tier, minQty: toDb(v.minQty), maxQty: toDb(v.maxQty), volumeTierName: v.volumeTierName, source: "manual", status: "ACTIVE", approvalState: "APPROVED" } });
      created++;
    }
    // The audit event carries the counts this transaction wrote; it commits (or rolls back) with them.
    await tx.auditEvent.create({ data: { actorUserId: actor.id, entityType: "Contract", entityId: contractId, action: "ENTRIES_CHANGED", afterJson: JSON.stringify({ created, superseded, unknown, entries: known.slice(0, 200).map((v) => ({ sku: v.sku, price: v.price.toString(), minQty: v.minQty?.toString() ?? null, maxQty: v.maxQty?.toString() ?? null, effectiveFrom: v.from.toISOString() })) }) } });
    return { created, superseded, unknown };
  }, { timeout: 60_000, maxWait: 15_000 });
  return result;
}

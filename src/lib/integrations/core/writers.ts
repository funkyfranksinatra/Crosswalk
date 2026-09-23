/**
 * Row-level domain writers used by every sync handler. Each takes one canonical import record
 * and applies it idempotently: the (system, entityType, externalId) ExternalRef carries a
 * payload hash (unchanged rows are skipped), the job id, the mapping version and the source's
 * own timestamp. Writers never delete: a record that disappears upstream is left alone; a
 * changed membership closes the previous row and opens a new one.
 *
 * The domain rules live here and in the modules these call (accounts, intelligence, gpo
 * reconciliation); adapters only translate shapes.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { normalizeAccountType } from "@/lib/accounts/types";
import { toDb, money } from "@/lib/money";
import { normalizeCfn, isPlaceholderSku } from "@/lib/cfn";
import type { AccountImportRecord, OpportunityImportRecord, ContactImportRecord, GpoAffiliationRecord, ProductImportRecord, StandardCostImportRecord, PriceEntryImportRecord, BillingImportRecord, Provenance } from "../types";
import type { JobContext } from "./jobs";
import { DataConflictError, ValidationError } from "./errors";

export type WriteOutcome = "created" | "updated" | "skipped";
const hash = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const strip = <T extends { provenance: Provenance }>(r: T): Omit<T, "provenance"> => { const { provenance: _p, ...rest } = r; void _p; return rest; };

async function findRef(system: string, entityType: string, externalId: string) {
  return prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system, entityType, externalId } } });
}
async function writeRef(ctx: JobContext, system: string, entityType: string, externalId: string, entityId: string, syncHash: string, prov: Provenance) {
  const data = { entityId, syncHash, syncedAt: new Date(), syncJobId: ctx.jobId, mappingVersion: ctx.mappingVersion, sourceUpdatedAt: prov.sourceUpdatedAt ? new Date(prov.sourceUpdatedAt) : null, metaJson: prov.meta ? JSON.stringify(prov.meta).slice(0, 2000) : null };
  await prisma.externalRef.upsert({ where: { system_entityType_externalId: { system, entityType, externalId } }, create: { system, entityType, externalId, ...data }, update: data });
}
function count(ctx: JobContext, o: WriteOutcome) { if (o === "created") ctx.created(); else if (o === "updated") ctx.updated(); else ctx.skipped(); return o; }

// ---- CRM ---------------------------------------------------------------------------------------

export async function writeAccount(ctx: JobContext, system: string, a: AccountImportRecord): Promise<WriteOutcome> {
  if (!a.externalId || !a.name?.trim()) throw new ValidationError("account needs an external id and a name");
  const h = hash(strip(a));
  const ref = await findRef(system, "Account", a.externalId);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const parent = a.parentExternalId ? await findRef(system, "Account", a.parentExternalId) : null;
  const owner = a.ownerEmail ? await prisma.user.findUnique({ where: { email: a.ownerEmail.toLowerCase() } }) : null;
  const data = { name: a.name.trim(), accountNumber: a.accountNumber?.trim() || undefined, type: normalizeAccountType(a.type), parentAccountId: parent?.entityId ?? null, territory: a.territory ?? null, segment: a.segment ?? null, region: a.region ?? null, country: a.country ?? "US", currency: a.currency ?? "USD", isStrategic: Boolean(a.isStrategic), ownerUserId: owner?.id ?? null, externalCrmId: a.externalId };
  // Reconcile: ExternalRef → externalCrmId → account number. A number bound to a different CRM record is a conflict, never a merge.
  let targetId = ref?.entityId ?? (await prisma.account.findUnique({ where: { externalCrmId: a.externalId }, select: { id: true } }))?.id ?? null;
  if (!targetId && data.accountNumber) {
    const byNumber = await prisma.account.findUnique({ where: { accountNumber: data.accountNumber }, select: { id: true, externalCrmId: true } });
    if (byNumber?.externalCrmId && byNumber.externalCrmId !== a.externalId) throw new DataConflictError(`account number ${data.accountNumber} is already linked to CRM record ${byNumber.externalCrmId}; resolve the duplicate in the CRM`);
    targetId = byNumber?.id ?? null;
  }
  const acc = targetId ? await prisma.account.update({ where: { id: targetId }, data }) : await prisma.account.create({ data });
  if (a.gpoName) await applyAffiliation(ctx, acc.id, { accountExternalId: a.externalId, gpoName: a.gpoName, gpoTier: a.gpoTier ?? null, provenance: a.provenance });
  if (a.contacts?.length) await prisma.account.update({ where: { id: acc.id }, data: { contactsJson: JSON.stringify(a.contacts.slice(0, 50).map((c) => ({ id: c.externalId, name: c.name, email: c.email ?? null, phone: c.phone ?? null, title: c.title ?? null }))) } });
  await writeRef(ctx, system, "Account", a.externalId, acc.id, h, a.provenance);
  return count(ctx, targetId ? "updated" : "created");
}

/** An affiliation from the CRM: opens a `crm` membership when none is open, updates the tier, never touches roster-sourced rows. */
async function applyAffiliation(ctx: JobContext, accountId: string, g: GpoAffiliationRecord) {
  const gpo = await prisma.gpo.upsert({ where: { name: g.gpoName.trim() }, create: { name: g.gpoName.trim() }, update: {} });
  const open = await prisma.gpoMembership.findFirst({ where: { accountId, gpoId: gpo.id, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
  const tier = g.gpoTier?.trim() || null;
  if (!open) { await prisma.gpoMembership.create({ data: { accountId, gpoId: gpo.id, tier, effectiveFrom: g.effectiveFrom ? new Date(g.effectiveFrom) : new Date(), effectiveTo: g.effectiveTo ? new Date(g.effectiveTo) : null, source: "crm", syncJobId: ctx.jobId } }); return; }
  if (open.source === "crm" && open.tier !== tier) await prisma.gpoMembership.update({ where: { id: open.id }, data: { tier, syncJobId: ctx.jobId } });
  // a roster-sourced membership outranks the CRM field: leave it
}

export async function writeGpoAffiliation(ctx: JobContext, system: string, g: GpoAffiliationRecord): Promise<WriteOutcome> {
  const key = `${g.accountExternalId}|${g.gpoName}|${g.effectiveFrom ?? ""}`;
  const h = hash(strip(g));
  const ref = await findRef(system, "GpoAffiliation", key);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const acc = await findRef(system, "Account", g.accountExternalId);
  if (!acc) throw new ValidationError(`account ${g.accountExternalId} has not been synced yet`);
  await applyAffiliation(ctx, acc.entityId, g);
  await writeRef(ctx, system, "GpoAffiliation", key, acc.entityId, h, g.provenance);
  return count(ctx, ref ? "updated" : "created");
}

export async function writeOpportunity(ctx: JobContext, system: string, o: OpportunityImportRecord): Promise<WriteOutcome> {
  if (!o.externalId || !o.accountExternalId) throw new ValidationError("opportunity needs an external id and an account id");
  const h = hash(strip(o));
  const ref = await findRef(system, "Opportunity", o.externalId);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const accRef = await findRef(system, "Account", o.accountExternalId);
  if (!accRef) throw new ValidationError(`account ${o.accountExternalId} has not been synced yet`);
  const owner = o.ownerEmail ? await prisma.user.findUnique({ where: { email: o.ownerEmail.toLowerCase() } }) : null;
  const data = { accountId: accRef.entityId, name: o.name, stage: o.stage, ownerUserId: owner?.id ?? null, closeDate: o.closeDate ? new Date(o.closeDate) : null, amount: toDb(o.amount), currency: o.currency ?? "USD", externalCrmId: o.externalId };
  const opp = await prisma.opportunity.upsert({ where: { externalCrmId: o.externalId }, create: data, update: data });
  await writeRef(ctx, system, "Opportunity", o.externalId, opp.id, h, o.provenance);
  return count(ctx, ref ? "updated" : "created");
}

export async function writeContacts(ctx: JobContext, system: string, contacts: ContactImportRecord[]): Promise<void> {
  const byAccount = new Map<string, ContactImportRecord[]>();
  for (const c of contacts) { if (!byAccount.has(c.accountExternalId)) byAccount.set(c.accountExternalId, []); byAccount.get(c.accountExternalId)!.push(c); }
  for (const [accExt, list] of byAccount) {
    const key = `contacts:${accExt}`;
    const h = hash(list.map(strip));
    const ref = await findRef(system, "Contacts", key);
    if (ref?.syncHash === h) { ctx.skipped(list.length); continue; }
    const acc = await findRef(system, "Account", accExt);
    if (!acc) { for (const c of list) ctx.rowError("Contact", c.externalId, new ValidationError(`account ${accExt} has not been synced yet`)); continue; }
    await prisma.account.update({ where: { id: acc.entityId }, data: { contactsJson: JSON.stringify(list.slice(0, 50).map((c) => ({ id: c.externalId, name: c.name, email: c.email ?? null, phone: c.phone ?? null, title: c.title ?? null }))) } });
    await writeRef(ctx, system, "Contacts", key, acc.entityId, h, list[0].provenance);
    ref ? ctx.updated(list.length) : ctx.created(list.length);
  }
}

// ---- ERP ---------------------------------------------------------------------------------------

export async function writeProduct(ctx: JobContext, system: string, companyId: string, s: ProductImportRecord): Promise<WriteOutcome> {
  if (!s.sku?.trim()) throw new ValidationError(`material ${s.provenance.sourceRecordId} has no SKU`);
  if (isPlaceholderSku(s.sku)) return count(ctx, "skipped"); // "N/A" / "TOTAL" rows in a material export are not products
  const sku = s.sku.trim().toUpperCase();
  const h = hash(strip(s));
  const ref = await findRef(system, "OwnProduct", sku);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const row = await prisma.ownProduct.upsert({ where: { companyId_sku: { companyId, sku } }, create: { companyId, sku, description: s.description || sku, category: s.productFamily ?? null, listPrice: toDb(s.listPrice), currency: s.currency ?? "USD", status: s.status ?? null, isActive: !s.discontinued, source: "erp" }, update: { description: s.description || undefined, category: s.productFamily ?? undefined, listPrice: toDb(s.listPrice) ?? undefined, currency: s.currency ?? undefined, status: s.status ?? undefined, isActive: !s.discontinued } });
  await writeRef(ctx, system, "OwnProduct", sku, row.id, h, s.provenance);
  return count(ctx, ref ? "updated" : "created");
}

export async function writeStandardCost(ctx: JobContext, system: string, companyId: string, c: StandardCostImportRecord): Promise<WriteOutcome> {
  const key = `${c.sku.toUpperCase()}|${c.plant ?? ""}|${c.region ?? ""}|${c.effectiveFrom}`;
  const h = hash(strip(c));
  const ref = await findRef(system, "StandardCost", key);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const product = await prisma.ownProduct.findFirst({ where: { companyId, sku: c.sku.toUpperCase() }, select: { id: true } });
  if (!product) throw new ValidationError(`SKU ${c.sku} is not in the product catalog (sync materials first)`);
  const costM = money(c.cost as never); const cost = toDb(c.cost);
  if (!costM || !cost || costM.lte(0)) throw new ValidationError(`cost for ${c.sku} must be positive`);
  const data = { productId: product.id, plant: c.plant ?? null, region: c.region ?? null, currency: c.currency, costType: ["STANDARD", "LANDED", "TRANSFER"].includes(String(c.costType ?? "").toUpperCase()) ? String(c.costType).toUpperCase() : "STANDARD", cost, effectiveFrom: new Date(c.effectiveFrom), effectiveTo: c.effectiveTo ? new Date(c.effectiveTo) : null, source: "erp" };
  const row = ref ? await prisma.standardCost.update({ where: { id: ref.entityId }, data }) : await prisma.standardCost.create({ data });
  await writeRef(ctx, system, "StandardCost", key, row.id, h, c.provenance);
  return count(ctx, ref ? "updated" : "created");
}

/** ERP list prices land in a pricebook named after the ERP condition/pricebook; existing entries for the same key are updated, others untouched. */
export async function writeListPrice(ctx: JobContext, system: string, companyId: string, p: PriceEntryImportRecord): Promise<WriteOutcome> {
  const key = `${p.sku.toUpperCase()}|${p.pricebook ?? p.conditionType ?? "list"}|${p.currency}|${p.effectiveFrom}|${p.minQty ?? ""}`;
  const h = hash(strip(p));
  const ref = await findRef(system, "PriceEntry", key);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const product = await prisma.ownProduct.findFirst({ where: { companyId, sku: p.sku.toUpperCase() }, select: { id: true } });
  if (!product) throw new ValidationError(`SKU ${p.sku} is not in the product catalog (sync materials first)`);
  const priceM = money(p.price as never); const price = toDb(p.price);
  if (!priceM || !price || priceM.lte(0)) throw new ValidationError(`price for ${p.sku} must be positive`);
  const bookName = `${system.toUpperCase()} list${p.pricebook ? ` · ${p.pricebook}` : p.conditionType ? ` · ${p.conditionType}` : ""}`;
  const book = await prisma.pricebook.upsert({ where: { name: bookName }, create: { name: bookName, currency: p.currency }, update: {} });
  const data = { pricebookId: book.id, productId: product.id, price, currency: p.currency, effectiveFrom: new Date(p.effectiveFrom), effectiveTo: p.effectiveTo ? new Date(p.effectiveTo) : null, minQty: toDb(p.minQty), source: "erp", status: "ACTIVE" };
  const row = ref ? await prisma.priceEntry.update({ where: { id: ref.entityId }, data }) : await prisma.priceEntry.create({ data });
  await writeRef(ctx, system, "PriceEntry", key, row.id, h, p.provenance);
  return count(ctx, ref ? "updated" : "created");
}

export async function writeBilling(ctx: JobContext, system: string, companyId: string, b: BillingImportRecord): Promise<WriteOutcome> {
  const h = hash(strip(b));
  const ref = await findRef(system, "PurchaseRecord", b.externalId);
  if (ref?.syncHash === h) return count(ctx, "skipped");
  const account = b.accountExternalId ? await prisma.account.findUnique({ where: { externalCrmId: b.accountExternalId } }) : b.accountNumber ? await prisma.account.findUnique({ where: { accountNumber: b.accountNumber } }) : null;
  if (!account) throw new ValidationError(`no account for ${b.accountNumber ?? b.accountExternalId ?? "(blank)"} — sync accounts or link the number`);
  const qty = toDb(b.quantity); const net = toDb(b.netPrice);
  if (!qty || !net) throw new ValidationError(`billing item ${b.externalId} needs a quantity and a net price`);
  const sku = normalizeCfn(b.sku);
  const product = await prisma.ownProduct.findFirst({ where: { companyId, sku }, select: { id: true } });
  const contract = b.contractNumber ? await prisma.contract.findUnique({ where: { contractNumber: b.contractNumber } }) : null;
  const won = await prisma.proposal.findFirst({ where: { accountId: account.id, status: "WON" }, orderBy: { decidedAt: "desc" }, select: { id: true } });
  const data = { accountId: account.id, productId: product?.id ?? null, sku, quantity: qty, netPrice: net, currency: b.currency, invoiceDate: new Date(b.invoiceDate), contractId: contract?.id ?? null, proposalId: won?.id ?? null, source: "erp", externalId: b.externalId };
  const row = ref ? await prisma.purchaseRecord.update({ where: { id: ref.entityId }, data }) : await prisma.purchaseRecord.create({ data });
  await writeRef(ctx, system, "PurchaseRecord", b.externalId, row.id, h, b.provenance);
  return count(ctx, ref ? "updated" : "created");
}

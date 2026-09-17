/**
 * Idempotent synchronisation. Every inbound record is upserted by (system,
 * entityType, externalId) through ExternalRef; a payload hash skips unchanged
 * records; every attempt is logged in SyncLog; transient failures retry with
 * backoff, permanent ones are recorded and skipped so one bad row never stops a feed.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { toDb, money } from "@/lib/money";
import { normalizeCfn, isPlaceholderSku } from "@/lib/cfn";
import type { CrmAdapter, ErpAdapter, GpoAdapter, CrmQuotePush } from "./types";
import { DevCrmAdapter, DevErpAdapter, DevGpoAdapter } from "./dev";
import { SalesforceCrmAdapter } from "./salesforce";
import { SapErpAdapter } from "./sap";
import { FileCrmAdapter, FileErpAdapter, FileGpoAdapter, FEED_FILES, feedDir, feedFilesPresent } from "./file";
import { audit } from "@/lib/audit";
import { publicErrorMessage } from "@/lib/api";
import { economicsToJson } from "@/lib/proposals/economics";

/** Adapter selection: API adapter when its credentials exist → file feed when INTEGRATION_FEED_DIR is set → labelled dev fixtures. */
export function crmAdapter(): CrmAdapter { return SalesforceCrmAdapter.configured() ? new SalesforceCrmAdapter() : FileCrmAdapter.configured() ? new FileCrmAdapter() : new DevCrmAdapter(); }
export function erpAdapter(): ErpAdapter { return SapErpAdapter.configured() ? new SapErpAdapter() : FileErpAdapter.configured() ? new FileErpAdapter() : new DevErpAdapter(); }
export function gpoAdapter(): GpoAdapter { return FileGpoAdapter.configured() ? new FileGpoAdapter() : new DevGpoAdapter(); }

const envSet = (names: string[]) => names.map((name) => ({ name, set: Boolean(process.env[name]) }));

export type IntegrationSystemStatus = {
  adapter: string;
  configured: boolean;
  /** false when credentials are present but the API adapter is still a skeleton */
  implemented: boolean;
  note: string;
  /** How to connect: the API route (env vars) and the file-feed route (files in INTEGRATION_FEED_DIR) */
  api: { name: string; env: { name: string; set: boolean }[]; implemented: boolean };
  feed: { files: { name: string; present: boolean }[] };
};

export function integrationStatus(): Record<"crm" | "erp" | "gpo", IntegrationSystemStatus> & { feedDir: string | null } {
  const present = feedFilesPresent();
  const dir = feedDir();
  const feed = (k: keyof typeof FEED_FILES) => ({ files: FEED_FILES[k].map((name) => ({ name, present: Boolean(present[name]) })) });
  const sf = SalesforceCrmAdapter.configured();
  const sap = SapErpAdapter.configured();
  const file = Boolean(dir);
  return {
    feedDir: dir,
    crm: {
      adapter: crmAdapter().system, configured: sf || file, implemented: !sf,
      note: sf ? "Salesforce credentials present — the Salesforce adapter is a skeleton; syncs fail until it is implemented" : file ? `File feed — ${dir}` : "DEVELOPMENT adapter (fixtures) — no CRM connected",
      api: { name: "Salesforce", env: envSet(["SF_LOGIN_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_API_VERSION"]), implemented: false },
      feed: feed("crm"),
    },
    erp: {
      adapter: erpAdapter().system, configured: sap || file, implemented: !sap,
      note: sap ? "SAP credentials present — the SAP adapter is a skeleton; syncs fail until it is implemented" : file ? `File feed — ${dir}` : "DEVELOPMENT adapter (fixtures) — no ERP connected",
      api: { name: "SAP (OData)", env: envSet(["SAP_ODATA_BASE_URL", "SAP_CLIENT", "SAP_USER", "SAP_PASSWORD"]), implemented: false },
      feed: feed("erp"),
    },
    gpo: {
      adapter: gpoAdapter().system, configured: file, implemented: true,
      note: file ? `File feed — ${dir}` : "DEVELOPMENT adapter (fixtures) — no membership feed connected",
      api: { name: "GPO roster API", env: [], implemented: false },
      feed: feed("gpo"),
    },
  };
}

const hash = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<{ ok: true; value: T; attempt: number } | { ok: false; error: string; attempt: number }> {
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try { return { ok: true, value: await fn(), attempt: i }; } catch (e) { last = publicErrorMessage(e); if (i < attempts) await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1))); }
  }
  return { ok: false, error: last, attempt: attempts };
}

async function upsertRef(system: string, entityType: string, externalId: string, entityId: string, syncHash: string) {
  await prisma.externalRef.upsert({ where: { system_entityType_externalId: { system, entityType, externalId } }, create: { system, entityType, externalId, entityId, syncHash }, update: { entityId, syncHash, syncedAt: new Date() } });
}

async function log(system: string, direction: "IN" | "OUT", entityType: string, r: { entityId?: string | null; externalId?: string | null; status: string; attempt?: number; error?: string | null; payloadHash?: string | null }) {
  await prisma.syncLog.create({ data: { system, direction, entityType, entityId: r.entityId ?? null, externalId: r.externalId ?? null, status: r.status, attempt: r.attempt ?? 1, error: r.error ?? null, payloadHash: r.payloadHash ?? null } });
}

export type SyncReport = { system: string; entityType: string; created: number; updated: number; skipped: number; failed: number; errors: string[] };
const report = (system: string, entityType: string): SyncReport => ({ system, entityType, created: 0, updated: 0, skipped: 0, failed: 0, errors: [] });

export async function syncCrmAccounts(actorUserId: string | null): Promise<SyncReport> {
  const crm = crmAdapter();
  const rep = report(crm.system, "Account");
  const rows = await crm.pullAccounts();
  // Parents first so children can link.
  rows.sort((a, b) => (a.parentExternalId ? 1 : 0) - (b.parentExternalId ? 1 : 0));
  for (const a of rows) {
    const h = hash(a);
    const ref = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: crm.system, entityType: "Account", externalId: a.externalId } } });
    if (ref?.syncHash === h) { rep.skipped++; continue; }
    const res = await withRetry(async () => {
      const parent = a.parentExternalId ? await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: crm.system, entityType: "Account", externalId: a.parentExternalId } } }) : null;
      const owner = a.ownerEmail ? await prisma.user.findUnique({ where: { email: a.ownerEmail } }) : null;
      const data = { name: a.name, accountNumber: a.accountNumber ?? undefined, type: a.type ?? "SOLD_TO", parentAccountId: parent?.entityId ?? null, territory: a.territory ?? null, segment: a.segment ?? null, region: a.region ?? null, country: a.country ?? "US", currency: a.currency ?? "USD", isStrategic: Boolean(a.isStrategic), ownerUserId: owner?.id ?? null, externalCrmId: a.externalId };
      // Reconcile: ExternalRef → externalCrmId → the account number (accounts created before the
      // CRM was connected — from seeds, requests or a purchase feed — get linked, not duplicated).
      // An account number already bound to a *different* CRM record is a real conflict and fails loudly.
      let targetId = ref?.entityId ?? (await prisma.account.findUnique({ where: { externalCrmId: a.externalId }, select: { id: true } }))?.id ?? null;
      if (!targetId && a.accountNumber) {
        const byNumber = await prisma.account.findUnique({ where: { accountNumber: a.accountNumber }, select: { id: true, externalCrmId: true } });
        if (byNumber?.externalCrmId && byNumber.externalCrmId !== a.externalId) throw new Error(`account number ${a.accountNumber} is already linked to CRM record ${byNumber.externalCrmId}; resolve in CRM before syncing`);
        targetId = byNumber?.id ?? null;
      }
      const acc = targetId ? await prisma.account.update({ where: { id: targetId }, data }) : await prisma.account.create({ data });
      if (a.gpoName) {
        const gpo = await prisma.gpo.upsert({ where: { name: a.gpoName }, create: { name: a.gpoName }, update: {} });
        const existing = await prisma.gpoMembership.findFirst({ where: { accountId: acc.id, gpoId: gpo.id, effectiveTo: null } });
        if (!existing) await prisma.gpoMembership.create({ data: { accountId: acc.id, gpoId: gpo.id, tier: a.gpoTier ?? null, effectiveFrom: new Date(), source: "crm" } });
        else if (existing.tier !== (a.gpoTier ?? null)) await prisma.gpoMembership.update({ where: { id: existing.id }, data: { tier: a.gpoTier ?? null } });
      }
      return acc;
    });
    if (res.ok) { await upsertRef(crm.system, "Account", a.externalId, res.value.id, h); ref ? rep.updated++ : rep.created++; await log(crm.system, "IN", "Account", { entityId: res.value.id, externalId: a.externalId, status: "OK", attempt: res.attempt, payloadHash: h }); }
    else { rep.failed++; rep.errors.push(`${a.externalId}: ${res.error}`); await log(crm.system, "IN", "Account", { externalId: a.externalId, status: "FAILED", attempt: res.attempt, error: res.error, payloadHash: h }); }
  }
  // Opportunities
  const opps = await crm.pullOpportunities();
  for (const o of opps) {
    const h = hash(o);
    const ref = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: crm.system, entityType: "Opportunity", externalId: o.externalId } } });
    if (ref?.syncHash === h) continue;
    const accRef = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: crm.system, entityType: "Account", externalId: o.accountExternalId } } });
    if (!accRef) { await log(crm.system, "IN", "Opportunity", { externalId: o.externalId, status: "SKIPPED", error: "account not synced" }); continue; }
    const owner = o.ownerEmail ? await prisma.user.findUnique({ where: { email: o.ownerEmail } }) : null;
    const data = { accountId: accRef.entityId, name: o.name, stage: o.stage, ownerUserId: owner?.id ?? null, closeDate: o.closeDate ? new Date(o.closeDate) : null, amount: toDb(o.amount), currency: o.currency ?? "USD", externalCrmId: o.externalId };
    const opp = await prisma.opportunity.upsert({ where: { externalCrmId: o.externalId }, create: data, update: data });
    await upsertRef(crm.system, "Opportunity", o.externalId, opp.id, h);
    await log(crm.system, "IN", "Opportunity", { entityId: opp.id, externalId: o.externalId, status: "OK", payloadHash: h });
  }
  await audit({ actorUserId, entityType: "Integration", entityId: crm.system, action: "SYNC_CRM", after: rep });
  return rep;
}

export async function syncErp(actorUserId: string | null, companyId: string): Promise<SyncReport[]> {
  const erp = erpAdapter();
  const skuRep = report(erp.system, "OwnProduct");
  for (const s of await erp.pullSkuMaster()) {
    if (isPlaceholderSku(s.sku)) { skuRep.skipped++; continue; } // "N/A" / "TOTAL" rows in a SKU master export are not products
    const h = hash(s);
    const ref = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: erp.system, entityType: "OwnProduct", externalId: s.sku } } });
    if (ref?.syncHash === h) { skuRep.skipped++; continue; }
    const res = await withRetry(async () => prisma.ownProduct.upsert({ where: { companyId_sku: { companyId, sku: s.sku.toUpperCase() } }, create: { companyId, sku: s.sku.toUpperCase(), description: s.description, category: s.productFamily ?? null, listPrice: toDb(s.listPrice), currency: s.currency ?? "USD", status: s.status ?? null, isActive: !s.discontinued }, update: { description: s.description, category: s.productFamily ?? undefined, listPrice: toDb(s.listPrice) ?? undefined, currency: s.currency ?? undefined, status: s.status ?? undefined, isActive: !s.discontinued } }));
    if (res.ok) { await upsertRef(erp.system, "OwnProduct", s.sku, res.value.id, h); ref ? skuRep.updated++ : skuRep.created++; await log(erp.system, "IN", "OwnProduct", { entityId: res.value.id, externalId: s.sku, status: "OK", payloadHash: h }); }
    else { skuRep.failed++; skuRep.errors.push(`${s.sku}: ${res.error}`); await log(erp.system, "IN", "OwnProduct", { externalId: s.sku, status: "FAILED", error: res.error }); }
  }
  const costRep = report(erp.system, "StandardCost");
  for (const c of await erp.pullStandardCosts()) {
    const key = `${c.sku}|${c.plant ?? ""}|${c.region ?? ""}|${c.effectiveFrom}`;
    const h = hash(c);
    const ref = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: erp.system, entityType: "StandardCost", externalId: key } } });
    if (ref?.syncHash === h) { costRep.skipped++; continue; }
    const product = await prisma.ownProduct.findFirst({ where: { companyId, sku: c.sku.toUpperCase() } });
    if (!product) { costRep.skipped++; await log(erp.system, "IN", "StandardCost", { externalId: key, status: "SKIPPED", error: "unknown SKU" }); continue; }
    const data = { productId: product.id, plant: c.plant ?? null, region: c.region ?? null, currency: c.currency, costType: c.costType ?? "STANDARD", cost: toDb(c.cost)!, effectiveFrom: new Date(c.effectiveFrom), effectiveTo: c.effectiveTo ? new Date(c.effectiveTo) : null, source: "erp" };
    const row = ref ? await prisma.standardCost.update({ where: { id: ref.entityId }, data }) : await prisma.standardCost.create({ data });
    await upsertRef(erp.system, "StandardCost", key, row.id, h); ref ? costRep.updated++ : costRep.created++;
    await log(erp.system, "IN", "StandardCost", { entityId: row.id, externalId: key, status: "OK", payloadHash: h });
  }
  const purRep = report(erp.system, "PurchaseRecord");
  for (const p of await erp.pullPurchases()) {
    const h = hash(p);
    const ref = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: erp.system, entityType: "PurchaseRecord", externalId: p.externalId } } });
    if (ref?.syncHash === h) { purRep.skipped++; continue; }
    const account = p.accountExternalId ? await prisma.account.findUnique({ where: { externalCrmId: p.accountExternalId } }) : p.accountNumber ? await prisma.account.findUnique({ where: { accountNumber: p.accountNumber } }) : null;
    if (!account) { purRep.skipped++; await log(erp.system, "IN", "PurchaseRecord", { externalId: p.externalId, status: "SKIPPED", error: "unknown account" }); continue; }
    const product = await prisma.ownProduct.findFirst({ where: { companyId, sku: normalizeCfn(p.sku) } });
    const contract = p.contractNumber ? await prisma.contract.findUnique({ where: { contractNumber: p.contractNumber } }) : null;
    const won = await prisma.proposal.findFirst({ where: { accountId: account.id, status: "WON" }, orderBy: { decidedAt: "desc" } });
    const data = { accountId: account.id, productId: product?.id ?? null, sku: normalizeCfn(p.sku), quantity: toDb(p.quantity)!, netPrice: toDb(p.netPrice)!, currency: p.currency, invoiceDate: new Date(p.invoiceDate), contractId: contract?.id ?? null, proposalId: won?.id ?? null, source: "erp", externalId: p.externalId };
    const row = ref ? await prisma.purchaseRecord.update({ where: { id: ref.entityId }, data }) : await prisma.purchaseRecord.create({ data });
    await upsertRef(erp.system, "PurchaseRecord", p.externalId, row.id, h); ref ? purRep.updated++ : purRep.created++;
    await log(erp.system, "IN", "PurchaseRecord", { entityId: row.id, externalId: p.externalId, status: "OK", payloadHash: h });
  }
  await audit({ actorUserId, entityType: "Integration", entityId: erp.system, action: "SYNC_ERP", after: [skuRep, costRep, purRep] });
  if (skuRep.created || skuRep.updated) { const { requestEmbeddingRefresh } = await import("@/lib/match/embeddings"); await requestEmbeddingRefresh("OwnProduct"); }
  return [skuRep, costRep, purRep];
}

export async function syncGpoMemberships(actorUserId: string | null): Promise<SyncReport> {
  const g = gpoAdapter();
  const rep = report(g.system, "GpoMembership");
  for (const m of await g.pullMemberships()) {
    const key = `${m.gpoName}|${m.accountExternalId ?? m.accountNumber}|${m.effectiveFrom}`;
    const h = hash(m);
    const ref = await prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system: g.system, entityType: "GpoMembership", externalId: key } } });
    if (ref?.syncHash === h) { rep.skipped++; continue; }
    const account = m.accountExternalId ? await prisma.account.findUnique({ where: { externalCrmId: m.accountExternalId } }) : m.accountNumber ? await prisma.account.findUnique({ where: { accountNumber: m.accountNumber } }) : null;
    if (!account) { rep.skipped++; await log(g.system, "IN", "GpoMembership", { externalId: key, status: "SKIPPED", error: "unknown account" }); continue; }
    const gpo = await prisma.gpo.upsert({ where: { name: m.gpoName }, create: { name: m.gpoName, code: m.gpoCode ?? null }, update: {} });
    // Membership changes never rewrite history: the previous open membership is closed, a new row is opened.
    const data = { accountId: account.id, gpoId: gpo.id, tier: m.tier ?? null, effectiveFrom: new Date(m.effectiveFrom), effectiveTo: m.effectiveTo ? new Date(m.effectiveTo) : null, source: m.source ?? "gpo-feed", verifiedAt: new Date() };
    const row = ref ? await prisma.gpoMembership.update({ where: { id: ref.entityId }, data }) : await prisma.gpoMembership.create({ data });
    if (!ref) await prisma.gpoMembership.updateMany({ where: { accountId: account.id, gpoId: gpo.id, id: { not: row.id }, effectiveTo: null, effectiveFrom: { lt: row.effectiveFrom } }, data: { effectiveTo: row.effectiveFrom } });
    await upsertRef(g.system, "GpoMembership", key, row.id, h); ref ? rep.updated++ : rep.created++;
    await log(g.system, "IN", "GpoMembership", { entityId: row.id, externalId: key, status: "OK", payloadHash: h });
  }
  await audit({ actorUserId, entityType: "Integration", entityId: g.system, action: "SYNC_GPO", after: rep });
  return rep;
}

/** Push an approved proposal to CRM as a quote (idempotent by proposal id + payload hash). */
export async function pushQuote(actorUserId: string | null, proposalId: string) {
  const crm = crmAdapter();
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true, opportunity: true, lines: { orderBy: { lineNo: "asc" } } } });
  if (!["APPROVED", "WON"].includes(p.status)) throw new Error("Only approved proposals are pushed to CRM");
  const econ = p.economicsJson ? (JSON.parse(p.economicsJson) as ReturnType<typeof economicsToJson>) : null;
  const payload: CrmQuotePush = {
    proposalId: p.id, reference: p.reference, accountExternalId: p.account.externalCrmId ?? p.account.id, opportunityExternalId: p.opportunity?.externalCrmId ?? null, status: p.status, currency: p.currency,
    totalValue: econ?.revenue ?? "0", customerSavings: econ?.customerSavings ?? null, blendedMarginPct: process.env.CRM_PUSH_MARGIN === "true" ? econ?.blendedMarginPct ?? null : null, validThrough: p.validThrough?.toISOString() ?? null,
    lines: p.lines.filter((l) => l.included).map((l) => ({ sku: l.sku, description: l.description, competitorCode: l.competitorCode, quantity: l.quantity.toString(), unitPrice: l.proposedPrice?.toString() ?? null, matchType: l.matchType, equivalenceLevel: l.equivalenceLevel, approvalState: l.approvalState })),
  };
  const h = hash(payload);
  const ref = await prisma.externalRef.findFirst({ where: { system: crm.system, entityType: "Proposal", entityId: p.id } });
  if (ref?.syncHash === h) { await log(crm.system, "OUT", "Proposal", { entityId: p.id, externalId: ref.externalId, status: "SKIPPED", payloadHash: h, error: "unchanged" }); return { externalId: ref.externalId, skipped: true }; }
  const res = await withRetry(() => crm.pushQuote(payload));
  if (!res.ok) { await log(crm.system, "OUT", "Proposal", { entityId: p.id, status: "FAILED", attempt: res.attempt, error: res.error, payloadHash: h }); throw new Error(`CRM push failed: ${res.error}`); }
  await upsertRef(crm.system, "Proposal", res.value.externalId, p.id, h);
  await log(crm.system, "OUT", "Proposal", { entityId: p.id, externalId: res.value.externalId, status: "OK", attempt: res.attempt, payloadHash: h });
  await audit({ actorUserId, entityType: "Proposal", entityId: p.id, action: "PUSHED_TO_CRM", after: { system: crm.system, externalId: res.value.externalId } });
  return { externalId: res.value.externalId, skipped: false };
}

export { money };

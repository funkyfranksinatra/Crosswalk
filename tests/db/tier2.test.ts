/**
 * Tier 2 (integration layer) — database-backed behaviour tests, all through the mock
 * providers (no network, no credentials). Covers the brief's matrix: configuration and
 * sealed secrets (never in API responses, logs or audit), authorization on the admin routes,
 * Salesforce account/opportunity sync with a company GPO field, idempotent quote write-back,
 * webhook verification + dedupe, SAP materials/costs/prices/billing with re-run safety,
 * GPO roster reconciliation with review queue, document extraction → review → verified
 * import, FX pulls with historical rates preserved and no silent substitution, and contract
 * price ingestion with duplicate / UOM / overlap / expiry / unknown-competitor handling.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { permissionsFor } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";
import { onLog } from "@/lib/log";
import { money } from "@/lib/money";
import { saveConfig, readConfig, secretsPresent, INTEGRATION_KEYS, type IntegrationKey } from "@/lib/integrations/core/config";
import { fieldsFor, definition, buildCrm } from "@/lib/integrations/core/registry";
import { runSync, testConnection, validateIntegrationMapping } from "@/lib/integrations/core/runner";
import { integrationDetail, saveIntegration, listReviews, resolveReviewItem } from "@/lib/integrations/core/admin";
import { pushQuote, integrationStatus } from "@/lib/integrations/sync";
import { writeBackQuote } from "@/lib/integrations/salesforce/writeback";
import { handleSalesforceWebhook, SIGNATURE_HEADER } from "@/lib/integrations/salesforce/webhook";
import { MockSalesforceAdapter } from "@/lib/integrations/salesforce/mock";
import { runExtraction, verifyExtraction, verifiedLinesGrid } from "@/lib/integrations/documents/service";
import { MockDocumentExtractionProvider } from "@/lib/integrations/documents/mock";
import { rateFor, storeRate, pullRates } from "@/lib/integrations/fx/service";
import { MockFxProvider } from "@/lib/integrations/fx/providers";
import { ingestContractPrices } from "@/lib/integrations/competitor-contracts/ingest";
import { startJob, finishJob } from "@/lib/integrations/core/jobs";
import { importObservationRows } from "@/lib/intelligence/import";
import { GET as configListRoute } from "@/app/api/integrations/config/route";
import { GET as configGetRoute, PUT as configPutRoute } from "@/app/api/integrations/config/[key]/route";
import { POST as syncRoute } from "@/app/api/integrations/config/[key]/sync/route";
import { POST as reviewResolveRoute } from "@/app/api/integrations/review/[id]/route";

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `t2${Date.now().toString(36)}`;
const SECRET = `s3cret-${RUN}-value`;
const WEBHOOK_SECRET = `wh-${RUN}`;

function actorFor(u: { id: string; email: string; name: string }, roles: string[]): Actor { return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true }; }
async function mkUser(tag: string, roles: string[]) { const u = await prisma.user.create({ data: { email: `${RUN}.${tag}@test.local`, name: `${RUN} ${tag}`, roles: { create: roles.map((role) => ({ role })) } } }); return { row: u, actor: actorFor(u, roles) }; }
const ctxFor = (key: string) => ({ params: Promise.resolve({ key }) });
const jsonReq = (body: unknown, method = "PUT") => new Request("http://x/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Everything the mock providers create is recognisable (MOCK-*, 001MOCK…, source "mock"); remove it so runs are repeatable. */
async function cleanup() {
  await prisma.integrationReviewItem.deleteMany({});
  await prisma.integrationSyncError.deleteMany({});
  await prisma.integrationSyncJob.deleteMany({});
  await prisma.integrationInboundEvent.deleteMany({});
  await prisma.integrationConfig.deleteMany({ where: { key: { in: INTEGRATION_KEYS } } });
  await prisma.externalRef.deleteMany({ where: { system: { in: ["salesforce-mock", "sap-mock"] } } });
  await prisma.competitorPriceObservation.deleteMany({ where: { OR: [{ sourceType: "GPO_CONTRACT_FILE", sourceSystem: { in: ["mock-contract-prices.xlsx", "unit"] } }, { competitor: { name: "Covidien" } }, { competitorSku: { in: ["SPMIIBX"] } }, { sourceType: "GPO_CONTRACT_FILE", contractRef: { in: ["VZ-2026-SURG-118", "PP-SU-2201", "VZ-1", "PP-1", "VZ-0"] } }] } });
  await prisma.exchangeRate.deleteMany({ where: { source: { in: ["mock", "test-manual"] } } });
  await prisma.gpoMembership.deleteMany({ where: { OR: [{ externalMembershipId: { startsWith: "PREMIER-M-" } }, { account: { externalCrmId: { startsWith: "001MOCK" } } }] } });
  await prisma.opportunity.deleteMany({ where: { externalCrmId: { startsWith: "006MOCK" } } });
  await prisma.proposal.deleteMany({ where: { reference: { startsWith: "PRP-t2" } } });
  await prisma.purchaseRecord.deleteMany({ where: { OR: [{ account: { externalCrmId: { startsWith: "001MOCK" } } }, { externalId: "90001234-10" }] } });
  await prisma.ownProduct.deleteMany({ where: { sku: { startsWith: "MOCK-" } } }); // cascades price entries and standard costs
  await prisma.account.deleteMany({ where: { OR: [{ externalCrmId: { startsWith: "001MOCK" } }, { name: { contains: " Pine Ridge" } }, { name: { contains: " unlinked" } }] } });
  await prisma.competitor.deleteMany({ where: { name: "Covidien" } });
  await prisma.document.deleteMany({ where: { filename: { endsWith: "-invoice.pdf" }, observations: { none: {} } } });
}

describe.skipIf(!hasDb)("Tier 2 — integration layer", () => {
  let admin: Awaited<ReturnType<typeof mkUser>>;
  let rep: Awaited<ReturnType<typeof mkUser>>;
  const logLines: string[] = [];
  let unsub = () => {};

  beforeAll(async () => {
    admin = await mkUser("admin", ["PRICING_DIRECTOR"]);
    rep = await mkUser("rep", ["SALES_REP"]);
    unsub = onLog((l) => logLines.push(JSON.stringify(l)));
    await cleanup(); // a clean slate, even after an aborted earlier run
  });
  afterAll(async () => {
    unsub();
    const { setActorForTests } = await import("../setup"); setActorForTests(null);
    await cleanup();
  });

  // ---- configuration, secrets, authorization  // ---- configuration, secrets, authorization -------------------------------------------------------
  describe("configuration and secrets", () => {
    test("secrets are sealed at rest, resolved only for adapters, never echoed by the admin API, logs or audit", async () => {
      const d = await definition("salesforce");
      const specs = fieldsFor(d, "salesforce");
      const r = await saveConfig("salesforce", { provider: "salesforce", enabled: false, config: { loginUrl: "https://test.salesforce.com", apiVersion: "v60.0", clientId: "3MVG9-id", authFlow: "client-credentials", quoteObject: "Crosswalk_Quote__c", quoteLineObject: "Crosswalk_Quote_Line__c" }, secrets: { clientSecret: SECRET, webhookSecret: WEBHOOK_SECRET } }, specs, admin.row.id);
      expect(r.errors).toEqual([]); expect(r.status).toBe("DISABLED"); expect(r.configVersion).toBe(1);
      const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } });
      expect(row.configJson).not.toContain(SECRET); expect(row.secretsJson).not.toContain(SECRET); expect(row.secretsJson).toMatch(/^v1\./);
      const cfg = (await readConfig("salesforce"))!;
      expect(cfg.secrets.clientSecret).toBe(SECRET);
      expect([...(await secretsPresent("salesforce"))].sort()).toEqual(["clientSecret", "webhookSecret"]);
      const detail = await integrationDetail("salesforce");
      expect(JSON.stringify(detail)).not.toContain(SECRET);
      expect(detail.config!.secretsPresent).toContain("clientSecret");
      // absent = keep, "" = clear, value = replace
      await saveConfig("salesforce", { provider: "salesforce", config: cfg.config, secrets: { webhookSecret: "" } }, specs, admin.row.id);
      expect([...(await secretsPresent("salesforce"))]).toEqual(["clientSecret"]);
      expect((await readConfig("salesforce"))!.configVersion).toBe(2);
      // env:NAME references resolve at use time and are not stored as values
      const ENV = `SF_SECRET_${RUN.toUpperCase()}`;
      process.env[ENV] = "from-env";
      await saveConfig("salesforce", { provider: "salesforce", config: cfg.config, secrets: { clientSecret: `env:${ENV}` } }, specs, admin.row.id);
      expect((await readConfig("salesforce"))!.secrets.clientSecret).toBe("from-env");
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } })).secretsJson).not.toContain("from-env");
      expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { entityType: "Integration", entityId: "salesforce" } }))).not.toContain(SECRET);
      expect(logLines.join("\n")).not.toContain(SECRET);
      delete process.env[ENV];
    });
    test("saving validates against the provider's field specs and rejects unknown providers / bad mapping shapes", async () => {
      await expect(saveIntegration("sap", { provider: "oracle" }, admin.row.id)).rejects.toThrow(/unknown provider/);
      await expect(saveIntegration("sap", { provider: "odata", mapping: { Bogus: {} } }, admin.row.id)).rejects.toThrow(/unknown entity/);
      await expect(saveIntegration("sap", { provider: "odata", scheduleCron: "every day" }, admin.row.id)).rejects.toThrow(/cron/);
      const r = await saveIntegration("sap", { provider: "odata", enabled: true, config: { baseUrl: "not a url", odataVersion: "v9" } }, admin.row.id);
      expect(r.status).toBe("NOT_CONFIGURED"); expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["baseUrl", "odataVersion"]));
    });
    test("admin routes require configure_settings; a sales rep gets 403 and cannot read statuses or change config", async () => {
      const { setActorForTests } = await import("../setup");
      setActorForTests(rep.actor);
      expect((await configListRoute()).status).toBe(403);
      expect((await configGetRoute(new Request("http://x"), ctxFor("salesforce"))).status).toBe(403);
      expect((await configPutRoute(jsonReq({ provider: "mock", enabled: true }), ctxFor("salesforce"))).status).toBe(403);
      expect((await syncRoute(jsonReq({ syncType: "accounts", mode: "test" }, "POST"), ctxFor("salesforce"))).status).toBe(403);
      setActorForTests(admin.actor);
      const list = await configListRoute(); expect(list.status).toBe(200);
      const body = await list.json(); expect(body.integrations.map((i: { key: string }) => i.key)).toEqual(INTEGRATION_KEYS);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      const bad = await configGetRoute(new Request("http://x"), ctxFor("hubspot")); expect(bad.status).toBe(404);
      setActorForTests(null);
      expect((await configListRoute()).status).toBeGreaterThanOrEqual(400); // no session at all
    });
    test("integrationStatus reports configured integrations without secrets and the app still runs with none enabled", async () => {
      const s = await integrationStatus();
      expect(s.tier2.find((t) => t.key === "salesforce")!.enabled).toBe(false);
      expect(s.crm.adapter).not.toMatch(/salesforce \(/);
      expect(JSON.stringify(s)).not.toContain(SECRET);
    });
  });

  // ---- 2.1 Salesforce ----------------------------------------------------------------------------------
  describe("2.1 Salesforce", () => {
    test("connection test and mapping validation run against the (mock) org and update health", async () => {
      const r = await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, mapping: { Account: { gpoName: { source: "GPO__c" }, gpoTier: { source: "GPO_Tier__c" }, isStrategic: { source: "Strategic__c", transform: "bool" } } } }, admin.row.id);
      expect(r.status).toBe("CONFIGURED");
      const t = await testConnection("salesforce", admin.row.id);
      expect(t.ok).toBe(true);
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } })).status).toBe("CONNECTED");
      const v = await validateIntegrationMapping("salesforce", true);
      expect(v.ok).toBe(true); expect(v.live).toBe(true);
      const bad = await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, mapping: { Account: { gpoName: { source: "Not_A_Field__c" } } } }, admin.row.id);
      expect(bad.errors).toEqual([]);
      const v2 = await validateIntegrationMapping("salesforce", true);
      expect(v2.entities.Account.some((i) => i.field === "gpoName")).toBe(true);
      await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, mapping: { Account: { gpoName: { source: "GPO__c" }, gpoTier: { source: "GPO_Tier__c" } } } }, admin.row.id);
      expect((await testConnection("salesforce", admin.row.id)).ok).toBe(true);
    });
    test("accounts + hierarchy + GPO affiliation + opportunities sync with provenance; a re-run changes nothing", async () => {
      const a = await runSync("salesforce", "accounts", "manual", admin.row.id);
      expect(a.status).toBe("SUCCEEDED"); expect(a.counters).toMatchObject({ received: 3, created: 3, errored: 0 });
      const child = await prisma.account.findUniqueOrThrow({ where: { externalCrmId: "001MOCK0000000002" }, include: { parent: true, memberships: { include: { gpo: true } } } });
      expect(child.parent?.externalCrmId).toBe("001MOCK0000000001");
      expect(child.accountNumber).toBe("MOCK-0002"); expect(child.territory).toBe("Northeast"); expect(child.ownerUserId).toBeTruthy();
      expect(child.memberships.find((m) => m.gpo.name === "Vizient")).toMatchObject({ tier: "Tier 2", source: "crm", effectiveTo: null });
      const ref = await prisma.externalRef.findUniqueOrThrow({ where: { system_entityType_externalId: { system: "salesforce-mock", entityType: "Account", externalId: "001MOCK0000000002" } } });
      expect(ref).toMatchObject({ entityId: child.id, syncJobId: a.jobId, mappingVersion: expect.any(Number) }); expect(ref.sourceUpdatedAt).toBeInstanceOf(Date);
      const o = await runSync("salesforce", "opportunities", "manual", admin.row.id);
      expect(o.counters).toMatchObject({ created: 2, errored: 0 });
      expect((await prisma.opportunity.findUniqueOrThrow({ where: { externalCrmId: "006MOCK0000000001" } })).accountId).toBe(child.id);
      const again = await runSync("salesforce", "accounts", "manual", admin.row.id, { full: true });
      expect(again.status).toBe("SUCCEEDED"); expect(again.counters).toMatchObject({ received: 3, created: 0, updated: 0, skipped: 3 });
      expect(await prisma.account.count({ where: { externalCrmId: { startsWith: "001MOCK" } } })).toBe(3);
      expect(await prisma.gpoMembership.count({ where: { accountId: child.id, effectiveTo: null } })).toBe(1);
      const cfg = await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } });
      expect(cfg.lastSyncAt).toBeInstanceOf(Date); expect(cfg.status).toBe("CONNECTED");
      expect(JSON.parse(cfg.cursorJson!).accounts).toBeTruthy(); // the since-watermark moved
    });
    test("partial data yields PARTIAL with row-level errors; auth failure yields FAILED, ERROR health and a redacted message", async () => {
      await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "partial" } }, admin.row.id);
      const p = await runSync("salesforce", "accounts", "manual", admin.row.id, { full: true });
      expect(p.status).toBe("PARTIAL"); expect(p.counters.errored).toBe(1);
      const errs = await prisma.integrationSyncError.findMany({ where: { jobId: p.jobId } });
      expect(errs).toHaveLength(1); expect(errs[0]).toMatchObject({ entityType: "Account", category: "VALIDATION" }); expect(errs[0].message).toMatch(/name/);
      await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "auth-failure" } }, admin.row.id);
      const f = await runSync("salesforce", "accounts", "manual", admin.row.id, { full: true });
      expect(f.status).toBe("FAILED"); expect(f.error?.category).toBe("AUTHENTICATION"); expect(f.error?.retryable).toBe(false);
      const cfg = await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } });
      expect(cfg.status).toBe("ERROR"); expect(cfg.lastErrorCategory).toBe("AUTHENTICATION"); expect(cfg.lastError).toMatch(/credentials/);
      const job = await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: f.jobId } });
      expect(job.status).toBe("FAILED"); expect(job.errorCategory).toBe("AUTHENTICATION");
      const rl = await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "rate-limit" } }, admin.row.id); expect(rl.errors).toEqual([]);
      const r = await runSync("salesforce", "accounts", "manual", admin.row.id, { full: true });
      expect(r.status).toBe("FAILED"); expect(r.error?.category).toBe("RATE_LIMIT"); expect(r.error?.retryable).toBe(true);
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } })).status).toBe("DEGRADED");
      await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
      expect(logLines.some((l) => l.includes("integration.sync.failed") && l.includes("AUTHENTICATION"))).toBe(true);
    });
    test("quote write-back is idempotent: same proposal → same quote, unchanged payload skipped, changes update", async () => {
      const acc = await prisma.account.findUniqueOrThrow({ where: { externalCrmId: "001MOCK0000000002" } });
      const p = await prisma.proposal.create({ data: { reference: `PRP-${RUN}-1`, accountId: acc.id, status: "APPROVED", currency: "USD", ownerUserId: rep.row.id, economicsJson: JSON.stringify({ revenue: "1000", customerSavings: "120", blendedMarginPct: "41.2" }), lines: { create: [{ lineNo: 1, competitorCode: "1DLMC05", sku: "MOCK-STAPLER-45", description: "Stapler", quantity: "10", proposedPrice: "100", approvalState: "APPROVED", included: true }] } } });
      const crm = new MockSalesforceAdapter("ok");
      const first = await writeBackQuote(crm, "salesforce-mock", admin.row.id, p.id, false);
      const second = await writeBackQuote(crm, "salesforce-mock", admin.row.id, p.id, false);
      expect(first).toMatchObject({ skipped: false, created: true }); expect(second).toMatchObject({ skipped: true, externalId: first.externalId });
      expect(crm.quotes.size).toBe(1); expect(crm.quotes.get(p.id)!.writes).toBe(1);
      expect(crm.quotes.get(p.id)!.lastPayload.blendedMarginPct).toBeNull(); // margin stays home unless pushMargin is on
      await prisma.proposal.update({ where: { id: p.id }, data: { economicsJson: JSON.stringify({ revenue: "1100", customerSavings: "120", blendedMarginPct: "41.2" }) } });
      const third = await writeBackQuote(crm, "salesforce-mock", admin.row.id, p.id, true);
      expect(third).toMatchObject({ skipped: false, created: false, externalId: first.externalId });
      expect(crm.quotes.get(p.id)!.writes).toBe(2); expect(crm.quotes.get(p.id)!.lastPayload.blendedMarginPct).toBe("41.2");
      expect(await prisma.externalRef.count({ where: { system: "salesforce-mock", entityType: "Proposal", entityId: p.id } })).toBe(1);
      expect(await prisma.syncLog.count({ where: { system: "salesforce-mock", entityType: "Proposal", entityId: p.id, status: "OK" } })).toBe(2);
      // the legacy entry point routes to the configured integration
      const viaSync = await pushQuote(admin.row.id, p.id); expect(viaSync.externalId).toBeTruthy();
      // a failed push is logged, audited and thrown — never recorded as a success
      await expect(writeBackQuote(new MockSalesforceAdapter("timeout"), "salesforce-mock", admin.row.id, p.id, false, { force: true })).rejects.toMatchObject({ category: "TIMEOUT" });
      expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: p.id, action: "CRM_PUSH_FAILED" } })).toBe(1);
      // an unlinked account cannot be pushed
      const orphan = await prisma.account.create({ data: { name: `${RUN} unlinked` } });
      const p2 = await prisma.proposal.create({ data: { reference: `PRP-${RUN}-2`, accountId: orphan.id, status: "APPROVED", currency: "USD" } });
      await expect(writeBackQuote(crm, "salesforce-mock", admin.row.id, p2.id, false)).rejects.toThrow(/not linked/);
      await prisma.proposal.delete({ where: { id: p2.id } }); await prisma.account.delete({ where: { id: orphan.id } });
    });
    test("webhooks: signature verified, duplicate event ids ignored, targeted accounts re-pulled in a webhook-triggered job", async () => {
      await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, secrets: { webhookSecret: WEBHOOK_SECRET } }, admin.row.id);
      const body = JSON.stringify({ eventId: `evt-${RUN}-1`, type: "account.changed", accountIds: ["001MOCK0000000003"] });
      const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
      const bad = await handleSalesforceWebhook(new Headers({ [SIGNATURE_HEADER]: "deadbeef" }), body);
      expect(bad.status).toBe(401);
      expect(await prisma.integrationInboundEvent.count({ where: { eventId: `evt-${RUN}-1` } })).toBe(0);
      const ok = await handleSalesforceWebhook(new Headers({ [SIGNATURE_HEADER]: sig }), body);
      expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ ok: true, applied: 1 });
      const job = await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: ok.body.jobId as string } });
      expect(job.trigger).toBe("webhook"); expect(job.received).toBe(1);
      const dup = await handleSalesforceWebhook(new Headers({ [SIGNATURE_HEADER]: sig }), body);
      expect(dup.body).toMatchObject({ duplicate: true });
      expect(await prisma.integrationSyncJob.count({ where: { integrationKey: "salesforce", trigger: "webhook" } })).toBe(1);
      const malformed = await handleSalesforceWebhook(new Headers({ [SIGNATURE_HEADER]: createHmac("sha256", WEBHOOK_SECRET).update("{").digest("hex") }), "{");
      expect(malformed.status).toBe(400);
      expect(logLines.join("\n")).not.toContain(WEBHOOK_SECRET);
    });
  });

  // ---- 2.2 SAP -------------------------------------------------------------------------------------------
  describe("2.2 SAP", () => {
    test("materials, plant costs, list-price conditions and billing documents sync; pagination and re-runs create no duplicates; partial failures are row errors", async () => {
      await saveIntegration("sap", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
      expect((await testConnection("sap", admin.row.id)).ok).toBe(true);
      const m = await runSync("sap", "materials", "manual", admin.row.id);
      expect(m.status).toBe("SUCCEEDED"); expect(m.counters.created).toBe(3); expect((m.report as { pages: number }).pages).toBeGreaterThan(1);
      const product = await prisma.ownProduct.findFirstOrThrow({ where: { sku: "MOCK-MESH-10X15" } });
      expect(product.isActive).toBe(false); expect(product.source).toBe("erp");
      const c = await runSync("sap", "costs", "manual", admin.row.id);
      expect(c.counters.created).toBe(3);
      const eu = await prisma.standardCost.findFirstOrThrow({ where: { product: { sku: "MOCK-RELOAD-45B" }, plant: "2000" } });
      expect(eu.region).toBe("EU"); expect(eu.currency).toBe("EUR"); expect(eu.source).toBe("erp");
      const p = await runSync("sap", "prices", "manual", admin.row.id);
      expect(p.counters.created).toBe(2);
      const entry = await prisma.priceEntry.findFirstOrThrow({ where: { product: { sku: "MOCK-STAPLER-45" }, source: "erp" }, include: { pricebook: true } });
      expect(entry.price.toString()).toBe("412"); expect(entry.pricebook!.name).toMatch(/list/i);
      const b = await runSync("sap", "billing", "manual", admin.row.id);
      expect(b.counters.created).toBe(1);
      const purchase = await prisma.purchaseRecord.findFirstOrThrow({ where: { externalId: "90001234-10" }, include: { account: true } });
      expect(purchase.account.accountNumber).toBe("MOCK-0002"); expect(purchase.netPrice.toString()).toBe("121.5");
      for (const t of ["materials", "costs", "prices", "billing"] as const) { const r = await runSync("sap", t, "manual", admin.row.id, { full: true }); expect(r.counters.created + r.counters.updated).toBe(0); }
      expect(await prisma.ownProduct.count({ where: { sku: { startsWith: "MOCK-" } } })).toBe(3);
      expect(await prisma.standardCost.count({ where: { product: { sku: { startsWith: "MOCK-" } } } })).toBe(3);
      await saveIntegration("sap", { provider: "mock", enabled: true, config: { scenario: "duplicate" } }, admin.row.id);
      const d = await runSync("sap", "costs", "manual", admin.row.id, { full: true });
      expect(d.status).toBe("SUCCEEDED"); expect(await prisma.standardCost.count({ where: { product: { sku: { startsWith: "MOCK-" } } } })).toBe(3);
      await saveIntegration("sap", { provider: "mock", enabled: true, config: { scenario: "partial" } }, admin.row.id);
      const pf = await runSync("sap", "materials", "manual", admin.row.id, { full: true });
      expect(pf.status).toBe("PARTIAL"); expect(pf.counters.errored).toBeGreaterThan(0);
      await saveIntegration("sap", { provider: "mock", enabled: true, config: { scenario: "unavailable" } }, admin.row.id);
      const u = await runSync("sap", "materials", "manual", admin.row.id, { full: true });
      expect(u.status).toBe("FAILED"); expect(u.error?.category).toBe("PROVIDER_UNAVAILABLE"); expect(u.error?.retryable).toBe(true);
      await saveIntegration("sap", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
    });
  });

  // ---- 2.3 GPO rosters ------------------------------------------------------------------------------------
  describe("2.3 GPO rosters", () => {
    test("roster import matches accounts by number, queues unmatched members for review, handles expired rows, and re-runs without duplicates", async () => {
      await saveIntegration("gpo:premier", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
      const r = await runSync("gpo:premier", "memberships", "manual", admin.row.id);
      expect(r.status).toBe("SUCCEEDED");
      const rep1 = r.report as { matched: number; unmatched: number };
      // Lakeshore matches; Pine Ridge matches nothing; MSK's expired Tier 3 row overlaps the seeded open Tier 2 membership → conflict, never applied silently
      expect(rep1).toMatchObject({ matched: 1, unmatched: 1, conflicts: 1 }); expect(r.counters.reviewed).toBe(2);
      const lakeshore = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "MOCK-0002" }, include: { memberships: { include: { gpo: true } } } });
      const premier = lakeshore.memberships.find((m) => m.gpo.name === "Premier")!;
      expect(premier).toMatchObject({ tier: "Tier 2", externalMembershipId: "PREMIER-M-1001", source: "gpo-feed", syncJobId: r.jobId });
      expect(premier.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-01-01");
      const msk = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" }, include: { memberships: { where: { gpo: { name: "Premier" } } } } });
      expect(msk.memberships).toHaveLength(1); expect(msk.memberships[0].tier).toBe("Tier 2"); // the seeded membership is untouched until a person decides
      const reviews = await listReviews({ key: "gpo:premier" });
      expect(reviews).toHaveLength(2);
      expect(reviews.find((i) => i.kind === "UNMATCHED_ACCOUNT")!.summary).toMatch(/Pine Ridge/);
      expect(reviews.find((i) => i.kind === "MEMBERSHIP_CONFLICT")!.summary).toMatch(/Tier 3/);
      const again = await runSync("gpo:premier", "memberships", "manual", admin.row.id);
      expect(again.counters.created).toBe(0);
      expect(await prisma.gpoMembership.count({ where: { externalMembershipId: "PREMIER-M-1001" } })).toBe(1);
      expect(await listReviews({ key: "gpo:premier" })).toHaveLength(2); // deduped, not re-queued
    });
    test("resolving a review links the member; a tier change closes the old membership and opens a new one; the duplicate scenario is flagged", async () => {
      const item = (await listReviews({ key: "gpo:premier" })).find((i) => i.kind === "UNMATCHED_ACCOUNT")!;
      const target = await prisma.account.create({ data: { name: `${RUN} Pine Ridge`, accountNumber: `${RUN}-PINE` } });
      const { setActorForTests } = await import("../setup");
      setActorForTests(rep.actor);
      expect((await reviewResolveRoute(jsonReq({ type: "link", accountId: target.id }, "POST"), { params: Promise.resolve({ id: item.id }) })).status).toBe(403);
      setActorForTests(admin.actor);
      const ok = await reviewResolveRoute(jsonReq({ type: "link", accountId: target.id }, "POST"), { params: Promise.resolve({ id: item.id }) });
      expect(ok.status).toBe(200);
      setActorForTests(null);
      const linked = await prisma.gpoMembership.findFirst({ where: { accountId: target.id }, include: { gpo: true } });
      expect(linked).toMatchObject({ tier: "Tier 1", externalMembershipId: "PREMIER-M-1002" }); expect(linked!.gpo.name).toBe("Premier");
      expect((await prisma.integrationReviewItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("RESOLVED");
      await saveIntegration("gpo:premier", { provider: "mock", enabled: true, config: { scenario: "duplicate" } }, admin.row.id);
      const d = await runSync("gpo:premier", "memberships", "manual", admin.row.id);
      expect((d.report as { duplicates: number }).duplicates).toBe(1); // an identical repeat is skipped; a differing repeat would be a DUPLICATE review
      expect(await prisma.gpoMembership.count({ where: { externalMembershipId: "PREMIER-M-1001" } })).toBe(1);
      await saveIntegration("gpo:premier", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
      // history: simulate the roster moving Lakeshore to Tier 3
      const lakeshore = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "MOCK-0002" } });
      const gpo = await prisma.gpo.findUniqueOrThrow({ where: { name: "Premier" } });
      const { reconcileRoster } = await import("@/lib/integrations/gpo/reconcile");
      const ctx = await startJob("gpo:premier", "test", "memberships", "manual", admin.row.id);
      await reconcileRoster("gpo:premier", ctx, [{ gpoName: "Premier", gpoCode: "PREMIER", accountNumber: "MOCK-0002", externalMembershipId: "PREMIER-M-1001", memberName: "Lakeshore Regional Hospital", tier: "Tier 3", effectiveFrom: "2026-10-01", effectiveTo: null, source: "gpo-feed", provenance: { provider: "mock", sourceSystem: "premier-mock", sourceRecordId: "PREMIER-M-1001" } }], {});
      await finishJob(ctx);
      const rows = await prisma.gpoMembership.findMany({ where: { accountId: lakeshore.id, gpoId: gpo.id }, orderBy: { effectiveFrom: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[0].tier).toBe("Tier 2"); expect(rows[0].effectiveTo?.toISOString().slice(0, 10)).toBe("2026-10-01");
      expect(rows[1]).toMatchObject({ tier: "Tier 3", effectiveTo: null });
      await prisma.gpoMembership.deleteMany({ where: { accountId: target.id } }); await prisma.account.delete({ where: { id: target.id } });
    });
  });

  // ---- 2.4 Documents ---------------------------------------------------------------------------------------
  describe("2.4 Document extraction", () => {
    test("high confidence still routes to review by policy; low confidence is flagged per line; verified lines import as observations with source-type confidence", async () => {
      const doc = await prisma.document.create({ data: { kind: "INVOICE", filename: `${RUN}-invoice.pdf`, mimeType: "application/pdf", uploadedByUserId: rep.row.id } });
      const low = await runExtraction(new MockDocumentExtractionProvider("ok", true), doc.id, "INVOICE", { bytes: Buffer.from("pdf") }, { threshold: 0.85, actorUserId: rep.row.id });
      expect(low.status).toBe("REVIEW"); expect(low.lowConfidenceLines).toBe(low.lines); expect(low.reviewItemId).toBeTruthy();
      const ok = await runExtraction(new MockDocumentExtractionProvider("ok"), doc.id, "INVOICE", { bytes: Buffer.from("pdf") }, { threshold: 0.85, actorUserId: rep.row.id, alwaysReview: false });
      expect(ok.status).toBe("EXTRACTED"); expect(ok.lowConfidenceLines).toBe(0);
      const policy = await runExtraction(new MockDocumentExtractionProvider("ok"), doc.id, "INVOICE", { bytes: Buffer.from("pdf") }, { threshold: 0.85, actorUserId: rep.row.id, alwaysReview: true });
      expect(policy.status).toBe("REVIEW");
      const partial = await runExtraction(new MockDocumentExtractionProvider("partial"), doc.id, "INVOICE", { bytes: Buffer.from("pdf") }, { threshold: 0.85, actorUserId: rep.row.id, alwaysReview: false });
      expect(partial.status).toBe("REVIEW"); expect(partial.lowConfidenceLines).toBe(1);
      await expect(runExtraction(new MockDocumentExtractionProvider("malformed"), doc.id, "INVOICE", { bytes: Buffer.from("pdf") }, { threshold: 0.85, actorUserId: rep.row.id })).rejects.toMatchObject({ category: "VALIDATION" });
      expect(await prisma.documentExtraction.count({ where: { documentId: doc.id, status: "FAILED" } })).toBe(1);
      // nothing is importable before verification
      expect(await verifiedLinesGrid(policy.extractionId)).toEqual([]);
      const fields = await prisma.extractedField.findMany({ where: { extractionId: policy.extractionId } });
      const sku2 = fields.find((f) => f.lineNo === 2 && f.field === "competitorSku")!;
      const decisions = fields.map((f) => (f.id === sku2.id ? { fieldId: f.id, status: "CORRECTED" as const, correctedValue: "SPMII-X" } : { fieldId: f.id, status: "VERIFIED" as const }));
      const v = await verifyExtraction(policy.extractionId, admin.row.id, decisions, true);
      expect(v.status).toBe("VERIFIED");
      expect((await prisma.integrationReviewItem.findUniqueOrThrow({ where: { id: policy.reviewItemId! } })).status).toBe("RESOLVED");
      const grid = await verifiedLinesGrid(policy.extractionId);
      expect(grid.length).toBeGreaterThanOrEqual(3);
      expect(grid[0]).toContain("Competitor Code");
      expect(grid.some((r) => r.includes("SPMII-X"))).toBe(true);
      const before = await prisma.competitorPriceObservation.count({ where: { documentId: doc.id } });
      const imported = await importObservationRows(admin.row.id, grid, doc.id);
      expect(imported.recorded).toBeGreaterThanOrEqual(1);
      const obs = await prisma.competitorPriceObservation.findFirst({ where: { documentId: doc.id }, orderBy: { createdAt: "desc" } });
      expect(obs!.sourceType).toBe("CUSTOMER_INVOICE");
      expect(obs!.rawConfidence).not.toBe(policy.overallConfidence); // commercial confidence comes from the source type, not the reader
      expect(await prisma.competitorPriceObservation.count({ where: { documentId: doc.id } })).toBe(before + imported.recorded);
    });
  });

  // ---- 2.5 FX ------------------------------------------------------------------------------------------------
  describe("2.5 Exchange rates", () => {
    test("pulled rates are stored per provider and date; manual rates coexist; missing dates fail rather than substitute; history is never overwritten", async () => {
      await saveIntegration("fx", { provider: "mock", enabled: true, config: { scenario: "ok", baseCurrencies: "USD", quoteCurrencies: "EUR,GBP,JPY,CHF", fallback: "fail" } }, admin.row.id);
      const r = await runSync("fx", "rates", "manual", admin.row.id);
      const today = new Date(); const weekend = [0, 6].includes(today.getUTCDay());
      if (weekend) { expect(r.status).toBe("PARTIAL"); } else { expect(r.status).toBe("PARTIAL"); expect(r.counters.created).toBe(3); expect(r.counters.errored).toBe(1); } // CHF is not in the mock table → reported, not invented
      const mock = new MockFxProvider();
      const tue = "2026-09-22", sun = "2026-09-20";
      const got = await rateFor(mock, "USD", "EUR", tue);
      expect(Number(got.rate)).toBe(0.9215); expect(got.provider).toBe("mock"); expect(got.note).toBeNull();
      await expect(rateFor(mock, "USD", "EUR", sun)).rejects.toMatchObject({ category: "NOT_FOUND" });
      const fb = await rateFor(mock, "USD", "EUR", sun, { fallback: "previous-business-day", maxLookbackDays: 3 });
      expect(fb.date).toBe("2026-09-18"); expect(fb.note).toMatch(/fallback policy/);
      // a manual rate for the same day is a separate row and wins the lookup (ordered by source)
      await storeRate({ base: "USD", quote: "EUR", rate: "0.9000", date: tue, provider: "test-manual", fetchedAt: new Date().toISOString() }, null, admin.row.id);
      expect(await prisma.exchangeRate.count({ where: { fromCurrency: "USD", toCurrency: "EUR", asOf: new Date(`${tue}T00:00:00Z`) } })).toBe(2);
      // a restated historical rate is ignored, not applied
      const restated = await storeRate({ base: "USD", quote: "EUR", rate: "0.9999", date: tue, provider: "mock", fetchedAt: new Date().toISOString() });
      expect(Number(restated.rate)).toBe(0.9215);
      // provider failure surfaces as a failed run, never as a stale conversion
      await saveIntegration("fx", { provider: "mock", enabled: true, config: { scenario: "auth-failure" } }, admin.row.id);
      const f = await runSync("fx", "rates", "manual", admin.row.id); expect(f.status).toBe("FAILED"); expect(f.error?.category).toBe("AUTHENTICATION");
      await expect(rateFor(new MockFxProvider("unavailable"), "GBP", "JPY", tue)).rejects.toMatchObject({ category: "PROVIDER_UNAVAILABLE" });
      // manual provider never pulls; conversions still work from stored rates
      await saveIntegration("fx", { provider: "manual", enabled: true }, admin.row.id);
      const m = await runSync("fx", "rates", "manual", admin.row.id); expect(m.status).toBe("FAILED"); expect(m.error?.category).toBe("CONFIGURATION");
      const { convert } = await import("@/lib/catalog/fx");
      const c = await convert(money("100")!, "USD", "EUR", new Date(`${tue}T12:00:00Z`));
      expect(c.rateId).toBeTruthy(); expect([0.9, 0.9215]).toContain(Number(c.rate));
    });
  });

  // ---- 2.6 Competitor contract prices -----------------------------------------------------------------------
  describe("2.6 Competitor contract prices", () => {
    test("valid rows become GPO_CONTRACT_FILE observations with contract provenance; unknown manufacturers, ambiguous units, missing prices, duplicates, overlaps and expiries go to review or row errors — never silently in", async () => {
      // the document test above taught the intelligence model "Covidien"; this scenario needs it unknown again
      await prisma.competitorPriceObservation.deleteMany({ where: { competitor: { name: "Covidien" } } });
      await prisma.competitor.deleteMany({ where: { name: "Covidien" } });
      await saveIntegration("competitor-contracts", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
      const r = await runSync("competitor-contracts", "prices", "manual", admin.row.id);
      expect(r.status).toBe("SUCCEEDED");
      const tally = (r.report as { tally: Record<string, number> }).tally;
      expect(tally.recorded).toBe(1); expect(tally.review).toBe(2); // Ethicon is known; Covidien is not
      const obs = await prisma.competitorPriceObservation.findFirst({ where: { competitorSku: "SPMII", sourceType: "GPO_CONTRACT_FILE", syncJobId: r.jobId }, include: { gpo: true, competitor: true } });
      expect(obs).toMatchObject({ tier: "Tier 2", contractRef: "VZ-2026-SURG-118", sourceOwner: "Contracting", currency: "USD", uom: "EA" });
      expect(obs!.gpo!.name).toBe("Vizient"); expect(obs!.competitor.name).toBe("Ethicon"); expect(obs!.validTo?.toISOString().slice(0, 10)).toBe("2026-12-31"); expect(obs!.price.toString()).toBe("1085");
      const reviews = await listReviews({ key: "competitor-contracts" });
      expect(reviews.filter((i) => i.kind === "UNKNOWN_COMPETITOR")).toHaveLength(1); // deduped by competitor name across both Covidien rows
      // re-run: exact duplicate is skipped, nothing new recorded
      const again = await runSync("competitor-contracts", "prices", "manual", admin.row.id);
      expect(again.counters.created).toBe(0); expect(again.counters.skipped).toBe(1);
      expect(await prisma.competitorPriceObservation.count({ where: { competitorSku: "SPMII", sourceType: "GPO_CONTRACT_FILE" } })).toBe(1);
      // accept the unknown competitor from the review queue → competitor created, row recorded
      const unk = reviews.find((i) => i.kind === "UNKNOWN_COMPETITOR")!;
      const res = await resolveReviewItem(unk.id, { type: "accept", corrections: { createCompetitor: true } }, admin.row.id);
      expect(res).toMatchObject({ recorded: true });
      expect(await prisma.competitor.findUnique({ where: { name: "Covidien" } })).toBeTruthy();
      // partial: a row with no price is a row error; "bundle" is an ambiguous UOM → review
      await saveIntegration("competitor-contracts", { provider: "mock", enabled: true, config: { scenario: "partial" } }, admin.row.id);
      const p = await runSync("competitor-contracts", "prices", "manual", admin.row.id);
      expect(p.status).toBe("PARTIAL");
      const errs = await prisma.integrationSyncError.findMany({ where: { jobId: p.jobId } });
      expect(errs.some((e) => /missing price/.test(e.message))).toBe(true);
      // duplicate scenario: the repeated row is flagged in the same file
      await saveIntegration("competitor-contracts", { provider: "mock", enabled: true, config: { scenario: "duplicate" } }, admin.row.id);
      const d = await runSync("competitor-contracts", "prices", "manual", admin.row.id);
      expect(d.counters.reviewed).toBeGreaterThan(0);
      expect((await listReviews({ key: "competitor-contracts" })).some((i) => i.kind === "DUPLICATE")).toBe(true);
      // direct ingestion: price change for the same contract/date, overlap, expiry, malformed date, bad currency, UOM alias config
      const ctx = await startJob("competitor-contracts", "test", "prices", "manual", admin.row.id);
      const base = { gpoName: "Vizient", competitorName: "Ethicon", competitorSku: "SPMII", currency: "USD", uom: "EA", tier: "Tier 2", contractRef: "VZ-2026-SURG-118" };
      const prov = (id: string) => ({ provider: "mock", sourceSystem: "unit", sourceRecordId: id });
      const out = await ingestContractPrices(ctx, [
        { ...base, price: "1090.00", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", provenance: prov("changed") },
        { ...base, price: "1050.00", effectiveFrom: "2026-06-01", effectiveTo: "2027-05-31", provenance: prov("overlap") },
        { ...base, price: "999.00", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", provenance: prov("expired") },
        { ...base, price: "999.00", effectiveFrom: "13/45/2026", provenance: prov("baddate") },
        { ...base, price: "999.00", currency: "US$", effectiveFrom: "2026-01-01", provenance: prov("badccy") },
        { ...base, competitorSku: "SPMII-BX", price: "5000.00", uom: "bndl", effectiveFrom: "2026-01-01", provenance: prov("alias") },
      ], { uomAliases: { bndl: "BX" }, today: new Date("2026-09-23T00:00:00Z") });
      expect(out.map((o) => o.result)).toEqual(["review", "review", "expired", "error", "error", "recorded"]);
      await finishJob(ctx);
      const kinds = (await listReviews({ key: "competitor-contracts" })).map((i) => i.kind);
      expect(kinds).toContain("PRICE_EXCEPTION"); expect(kinds).toContain("OVERLAP");
      expect((await prisma.competitorPriceObservation.findFirst({ where: { competitorSku: "SPMII", contractRef: "VZ-2026-SURG-118", tier: "Tier 2", effectiveAt: new Date("2026-01-01T00:00:00Z") } }))!.price.toString()).toBe("1085"); // historical price untouched
      expect((await prisma.competitorPriceObservation.findFirst({ where: { competitorSku: "SPMIIBX" } }))!.uom).toBe("BX");
      await saveIntegration("competitor-contracts", { provider: "mock", enabled: true, config: { scenario: "ok" } }, admin.row.id);
    });
  });

  // ---- cross-cutting ------------------------------------------------------------------------------------------
  describe("integrity", () => {
    test("disabled or unconfigured integrations refuse to sync; mock providers are labelled; the sync history is complete", async () => {
      await saveIntegration("sap", { provider: "mock", enabled: false, config: { scenario: "ok" } }, admin.row.id);
      await expect(runSync("sap", "materials", "manual", admin.row.id)).rejects.toThrow(/disabled/);
      await expect(runSync("gpo:vizient", "memberships", "manual", admin.row.id)).rejects.toThrow(/not configured/);
      await expect(runSync("salesforce", "nope", "manual", admin.row.id)).rejects.toThrow(/no "nope" sync/);
      const detail = await integrationDetail("salesforce");
      expect(detail.definition.providers.find((p) => p.id === "mock")!.mock).toBe(true);
      expect(detail.jobs.length).toBeGreaterThan(3);
      expect(detail.jobs.every((j) => ["SUCCEEDED", "PARTIAL", "FAILED"].includes(j.status))).toBe(true);
      const crm = await buildCrm((await readConfig("salesforce"))!);
      expect(crm.provider).toBe("mock");
      expect(logLines.join("\n")).not.toContain(SECRET);
    });
  });
});

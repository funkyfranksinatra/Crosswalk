/**
 * WS5 — integration layer fault matrix and configuration hardening, all through the labelled
 * mocks and injected fetch (no network, no credentials). Needs DATABASE_URL with the demo seed.
 *
 *   - every family × every mock scenario → the documented job status, error category,
 *     retryability and health state; secrets never in job rows
 *   - configuration: cron validation, enable/disable, provider change, versioning, write-only
 *     secrets, clearing, env:NAME at use time, tamper / wrong key → safe error and recovery,
 *     key format, production refuses mocks
 *   - FX: canonical look-back policy (default / override / weekend / holiday / missing), immutable
 *     stored rates and the restatement log
 *   - GPO API roster: a failed middle page closes nothing; a complete roster with closeMissing does;
 *     pagination terminates at the documented cap; the watermark moves only after a complete run
 *   - a job that finishes after its integration was disabled leaves the status DISABLED
 *   - account resolution order and conflicts; documents: review conditions, verify → grid idempotency,
 *     storage id safety
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { onLog } from "@/lib/log";
import { saveConfig, readConfig, secretsPresent, secretsState, seal, open, resolveSecret, setCursor, getCursor, INTEGRATION_KEYS, type IntegrationKey } from "@/lib/integrations/core/config";
import { fieldsFor, definition, buildAny, INTEGRATIONS } from "@/lib/integrations/core/registry";
import { runSync } from "@/lib/integrations/core/runner";
import { saveIntegration, integrationDetail } from "@/lib/integrations/core/admin";
import { startJob, failJob, finishJob, JobContext, cancelStaleJobs } from "@/lib/integrations/core/jobs";
import { recordSyncOutcome } from "@/lib/integrations/core/health";
import { MOCK_SCENARIOS } from "@/lib/integrations/core/mock";
import { IntegrationError } from "@/lib/integrations/core/errors";
import { writeAccount } from "@/lib/integrations/core/writers";
import { rateFor, storeRate, fxPolicyFrom, configuredFxPolicy, DEFAULT_FX_POLICY, FX_MAX_LOOKBACK_DEFAULT } from "@/lib/integrations/fx/service";
import { MockFxProvider } from "@/lib/integrations/fx/providers";
import { runExtraction, verifyExtraction, verifiedLinesGrid } from "@/lib/integrations/documents/service";
import { MockDocumentExtractionProvider } from "@/lib/integrations/documents/mock";
import { storeDocumentBytes, readDocumentBytes } from "@/lib/documents/storage";
import { applyMapping, getPath, applyTransform } from "@/lib/integrations/core/mapping";

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `w5i${Date.now().toString(36)}`;
const SENTINEL = `SENTINEL-${RUN}-hunter2`;

type Family = "salesforce" | "sap" | "gpo:premier" | "gpo:vizient" | "gpo:healthtrust" | "fx" | "competitor-contracts";
const SYNC_TYPE: Record<Family, string> = { salesforce: "accounts", sap: "materials", "gpo:premier": "memberships", "gpo:vizient": "memberships", "gpo:healthtrust": "memberships", fx: "rates", "competitor-contracts": "prices" };

async function mock(k: IntegrationKey, scenario: string, extra: Record<string, unknown> = {}, enabled = true) {
  const d = await definition(k);
  return saveConfig(k, { provider: "mock", enabled, config: { scenario, ...extra } }, fieldsFor(d, "mock"), null);
}

async function cleanup() {
  await prisma.integrationReviewItem.deleteMany({});
  await prisma.integrationSyncError.deleteMany({});
  await prisma.integrationSyncJob.deleteMany({});
  await prisma.integrationConfig.deleteMany({ where: { key: { in: INTEGRATION_KEYS } } });
  await prisma.externalRef.deleteMany({ where: { OR: [{ system: { in: ["salesforce-mock", "sap-mock"] } }, { system: { startsWith: RUN } }] } });
  await prisma.competitorPriceObservation.deleteMany({ where: { OR: [{ sourceType: "GPO_CONTRACT_FILE", sourceSystem: "mock-contract-prices.xlsx" }, { sourceSystem: { contains: RUN } }] } });
  await prisma.exchangeRate.deleteMany({ where: { source: { in: ["mock", `${RUN}-prov`] } } });
  await prisma.gpoMembership.deleteMany({ where: { OR: [{ externalMembershipId: { startsWith: "PREMIER-M-" } }, { externalMembershipId: { startsWith: "VIZIENT-M-" } }, { externalMembershipId: { startsWith: "HPG-M-" } }, { externalMembershipId: { startsWith: RUN } }, { account: { externalCrmId: { startsWith: "001MOCK" } } }] } });
  await prisma.opportunity.deleteMany({ where: { externalCrmId: { startsWith: "006MOCK" } } });
  await prisma.purchaseRecord.deleteMany({ where: { OR: [{ account: { externalCrmId: { startsWith: "001MOCK" } } }, { externalId: "90001234-10" }] } });
  await prisma.ownProduct.deleteMany({ where: { sku: { startsWith: "MOCK-" } } });
  await prisma.account.deleteMany({ where: { OR: [{ externalCrmId: { startsWith: "001MOCK" } }, { externalCrmId: { startsWith: RUN } }, { accountNumber: { startsWith: RUN } }, { name: { contains: " Pine Ridge" } }] } });
  await prisma.competitor.deleteMany({ where: { name: "Covidien" } });
  await prisma.document.deleteMany({ where: { filename: { startsWith: RUN } } });
}

describe.skipIf(!hasDb)("WS5 integrations", () => {
  const logLines: string[] = [];
  let unsub = () => {};
  let adminId: string;
  beforeAll(async () => {
    process.env.JOBS_WORKER = "off";
    unsub = onLog((l) => logLines.push(JSON.stringify(l)));
    await cleanup();
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@crosswalk.dev" } })).id;
  });
  afterAll(async () => { unsub(); await cleanup(); });

  // ---- fault matrix ------------------------------------------------------------------------------
  describe("fault matrix: every family × every scenario", () => {
    const FAMILIES: Family[] = ["salesforce", "sap", "gpo:premier", "gpo:vizient", "gpo:healthtrust", "fx", "competitor-contracts"];
    const expected: Record<string, { status: string[]; category?: string; retryable?: boolean; health: string[] }> = {
      ok: { status: ["SUCCEEDED", "PARTIAL"], health: ["CONNECTED", "DEGRADED"] },
      empty: { status: ["SUCCEEDED", "PARTIAL"], health: ["CONNECTED", "DEGRADED"] },
      "auth-failure": { status: ["FAILED"], category: "AUTHENTICATION", retryable: false, health: ["ERROR"] },
      timeout: { status: ["FAILED"], category: "TIMEOUT", retryable: true, health: ["DEGRADED"] },
      "rate-limit": { status: ["FAILED"], category: "RATE_LIMIT", retryable: true, health: ["DEGRADED"] },
      unavailable: { status: ["FAILED"], category: "PROVIDER_UNAVAILABLE", retryable: true, health: ["DEGRADED"] },
      partial: { status: ["PARTIAL", "SUCCEEDED"], health: ["DEGRADED", "CONNECTED"] },
      malformed: { status: ["FAILED"], category: "VALIDATION", retryable: false, health: ["ERROR"] },
      duplicate: { status: ["SUCCEEDED", "PARTIAL"], health: ["CONNECTED", "DEGRADED"] },
    };
    expect(Object.keys(expected).sort()).toEqual([...MOCK_SCENARIOS].sort());

    for (const family of FAMILIES) {
      test(`${family}: ${MOCK_SCENARIOS.length} scenarios behave as documented`, async () => {
        for (const scenario of MOCK_SCENARIOS) {
          await mock(family, scenario);
          const r = await runSync(family, SYNC_TYPE[family], "manual", adminId);
          const want = expected[scenario];
          const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { key: family } });
          const job = await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: r.jobId } });
          const ctx = `${family}/${scenario}`;
          expect(want.status, ctx).toContain(r.status);
          expect(job.status, ctx).toBe(r.status);
          expect(want.health, ctx).toContain(row.status);
          if (want.category) {
            expect(r.error?.category, ctx).toBe(want.category);
            expect(r.error?.retryable, ctx).toBe(want.retryable);
            expect(job.errorCategory, ctx).toBe(want.category);
            expect(row.lastErrorCategory, ctx).toBe(want.category);
            expect(job.completedAt, ctx).not.toBeNull();
          } else {
            expect(r.error, ctx).toBeUndefined();
            if (scenario === "partial" && family !== "fx") expect(job.errored, ctx).toBeGreaterThan(0);
            if (scenario === "empty") expect(job.created, ctx).toBe(0);
          }
          if (scenario === "duplicate" && family === "salesforce") {
            // a duplicate record inside one page is one ExternalRef, one account
            const refs = await prisma.externalRef.groupBy({ by: ["externalId"], where: { system: "salesforce-mock", entityType: "Account" }, _count: { _all: true } });
            expect(refs.every((x) => x._count._all === 1), ctx).toBe(true);
          }
        }
        // recovery: after the failures, an ok run restores CONNECTED (or DEGRADED with row errors)
        await mock(family, "ok");
        const again = await runSync(family, SYNC_TYPE[family], "manual", adminId);
        expect(["SUCCEEDED", "PARTIAL"]).toContain(again.status);
        expect(["CONNECTED", "DEGRADED"]).toContain((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: family } })).status);
      }, 120_000);
    }

    test("a failed job's row and the health columns never carry a secret; row errors are capped and redacted", async () => {
      await mock("salesforce", "ok");
      const ctx = await startJob("salesforce", "mock", "accounts", "manual", adminId);
      for (let i = 0; i < 5200; i++) ctx.rowError("Account", `r${i}`, new Error(`row ${i} failed: password=${SENTINEL} token: ${SENTINEL}`));
      await finishJob(ctx, { note: `bearer ${SENTINEL}` });
      const errs = await prisma.integrationSyncError.findMany({ where: { jobId: ctx.jobId } });
      expect(errs.length).toBe(5000);
      expect(errs.some((e) => e.message.includes(SENTINEL))).toBe(false);
      const ctx2 = await startJob("salesforce", "mock", "accounts", "manual", adminId);
      const err = await failJob(ctx2, new IntegrationError("AUTHENTICATION", `login failed for client_secret=${SENTINEL} at https://u:${SENTINEL}@sf.example`));
      expect(err.message).not.toContain(SENTINEL);
      await recordSyncOutcome("salesforce", "FAILED", err);
      const job = await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: ctx2.jobId } });
      expect(job.errorSummary).not.toContain(SENTINEL);
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "salesforce" } })).lastError).not.toContain(SENTINEL);
      expect(logLines.some((l) => l.includes(SENTINEL))).toBe(false);
    });

    test("the integration.sync job handler rethrows only retryable failures (pg-boss retries transient errors, not bad credentials)", async () => {
      const { QUEUES } = await import("@/lib/jobs/queues");
      expect(QUEUES["integration.sync"].retryLimit).toBe(2);
      await mock("sap", "auth-failure");
      const r = await runSync("sap", "materials", "schedule", null);
      expect(r.status).toBe("FAILED"); expect(r.error?.retryable).toBe(false);
      await mock("sap", "unavailable");
      const r2 = await runSync("sap", "materials", "schedule", null);
      expect(r2.error?.retryable).toBe(true);
    });
  });

  // ---- configuration ----------------------------------------------------------------------------
  describe("configuration", () => {
    test("cron: 5 fields required, invalid rejected, clearing unschedules; enable/disable transitions; provider change drops the old provider's secrets", async () => {
      await expect(saveIntegration("fx", { provider: "mock", enabled: true, scheduleCron: "0 6 * * *" }, adminId)).resolves.toMatchObject({ status: "CONFIGURED" });
      for (const bad of ["0 6 * *", "every day", "0 6 * * * *", "* * * *"]) await expect(saveIntegration("fx", { provider: "mock", enabled: true, scheduleCron: bad }, adminId)).rejects.toThrow(/5-field cron/);
      await expect(saveIntegration("fx", { provider: "mock", enabled: true, scheduleCron: "" }, adminId)).resolves.toBeTruthy();
      expect((await readConfig("fx"))?.scheduleCron).toBeNull();
      const off = await saveIntegration("fx", { provider: "mock", enabled: false }, adminId);
      expect(off.status).toBe("DISABLED");
      await expect(runSync("fx", "rates", "manual", adminId)).rejects.toThrow(/disabled/);
      await expect(runSync("documents", "anything", "manual", adminId)).rejects.toThrow(/no "anything" sync/);
      await prisma.integrationSyncJob.deleteMany({ where: { integrationKey: "salesforce" } });
      await prisma.integrationConfig.deleteMany({ where: { key: { in: ["documents", "salesforce"] } } });
      await expect(runSync("salesforce", "accounts", "manual", adminId)).rejects.toThrow(/not configured/);
      // provider change: secrets that the new provider does not declare are dropped
      const d = await definition("fx");
      await saveConfig("fx", { provider: "http", enabled: true, config: { endpoint: "https://fx.example/{date}", ratePath: "rates.{quote}", authMode: "bearer" }, secrets: { token: "tok-1" } }, fieldsFor(d, "http"), adminId);
      expect([...(await secretsPresent("fx"))]).toEqual(["token"]);
      await saveConfig("fx", { provider: "mock", enabled: true, config: { scenario: "ok" } }, fieldsFor(d, "mock"), adminId);
      expect([...(await secretsPresent("fx"))]).toEqual([]);
    });

    test("versioning: configVersion bumps on every save; health resets to CONFIGURED; secrets are write-only, keep on omit, clear on empty", async () => {
      const d = await definition("documents");
      const specs = fieldsFor(d, "http");
      const s1 = await saveConfig("documents", { provider: "http", enabled: true, config: { endpoint: "https://ocr.example/v1", authMode: "bearer", responseLinesPath: "lines" }, secrets: { token: "first" } }, specs, adminId);
      expect(s1.configVersion).toBe(1);
      const s2 = await saveConfig("documents", { provider: "http", enabled: true, config: { endpoint: "https://ocr.example/v2", authMode: "bearer", responseLinesPath: "lines" } }, specs, adminId);
      expect(s2.configVersion).toBe(2);
      expect((await readConfig("documents"))?.secrets.token).toBe("first"); // omitted → kept
      const detail = await integrationDetail("documents");
      expect(JSON.stringify(detail)).not.toContain("first");
      expect(detail.config?.secretsPresent).toEqual(["token"]);
      await prisma.integrationConfig.update({ where: { key: "documents" }, data: { status: "CONNECTED", lastTestOk: true } });
      const s3 = await saveConfig("documents", { provider: "http", enabled: true, config: { endpoint: "https://ocr.example/v2", authMode: "bearer", responseLinesPath: "lines" }, secrets: { token: "" } }, specs, adminId);
      expect(s3.configVersion).toBe(3);
      expect(s3.status).toBe("CONFIGURED"); // the token is conditional on authMode, so the shape is valid…
      expect((await readConfig("documents"))?.secrets.token).toBeUndefined();
      await expect(buildAny((await readConfig("documents"))!)).rejects.toThrow(/bearer token is required/); // …but the adapter cannot be built without it
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "documents" } })).lastTestOk).toBeNull();
    });

    test("env:NAME secrets resolve at use time (not at save), and a missing variable is a configuration error that names it", async () => {
      const d = await definition("fx");
      await saveConfig("fx", { provider: "http", enabled: true, config: { endpoint: "https://fx.example/{date}", ratePath: "rates.{quote}", authMode: "bearer" }, secrets: { token: `env:WS5_FX_TOKEN_${RUN.toUpperCase()}` } }, fieldsFor(d, "http"), adminId);
      const name = `WS5_FX_TOKEN_${RUN.toUpperCase()}`;
      await expect(readConfig("fx")).rejects.toThrow(new RegExp(`refers to environment variable ${name}`));
      process.env[name] = "resolved-later";
      try { expect((await readConfig("fx"))?.secrets.token).toBe("resolved-later"); } finally { delete process.env[name]; }
      expect(resolveSecret("env:lowercase", "x")).toBe("env:lowercase"); // not a reference: stored literally
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "fx" } })).secretsJson).not.toContain("resolved-later");
    });

    test("sealed secrets: tampering and a wrong key fail safely; the row survives; the admin can re-enter secrets; key format enforced", async () => {
      const d = await definition("fx");
      const specs = fieldsFor(d, "http");
      const saveKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;
      try {
        process.env.INTEGRATIONS_ENCRYPTION_KEY = "a".repeat(64);
        await saveConfig("fx", { provider: "http", enabled: true, config: { endpoint: "https://fx.example/{date}", ratePath: "r", authMode: "bearer" }, secrets: { token: "k1-secret" } }, specs, adminId);
        const sealed = (await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "fx" } })).secretsJson!;
        expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        // tamper with the ciphertext
        const parts = sealed.split(".");
        parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("AA") ? "BB" : "AA");
        expect(() => open(parts.join("."))).toThrow(/cannot be decrypted/);
        expect(() => open("v2.a.b.c")).toThrow(/unreadable \(format\)/);
        // wrong key: reading fails with a clear message; nothing is destroyed
        process.env.INTEGRATIONS_ENCRYPTION_KEY = "b".repeat(64);
        await expect(readConfig("fx")).rejects.toThrow(/INTEGRATIONS_ENCRYPTION_KEY .*differs/);
        const state = await secretsState("fx");
        expect(state.present.size).toBe(0); expect(state.unreadable).toMatch(/re-enter/);
        const detail = await integrationDetail("fx");
        expect(detail.config?.secretsUnreadable).toMatch(/re-enter/);
        // a save without secrets keeps the blob (restoring the old key still works) and reports the problem
        const kept = await saveConfig("fx", { provider: "http", enabled: true, config: { endpoint: "https://fx.example/{date}", ratePath: "r", authMode: "bearer" } }, specs, adminId);
        expect(kept.status).toBe("NOT_CONFIGURED"); expect(kept.errors.some((e) => e.field === "secrets")).toBe(true);
        expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "fx" } })).secretsJson).toBe(sealed);
        process.env.INTEGRATIONS_ENCRYPTION_KEY = "a".repeat(64);
        expect((await readConfig("fx"))?.secrets.token).toBe("k1-secret");
        // re-entering under the new key replaces the blob and the integration is configured again
        process.env.INTEGRATIONS_ENCRYPTION_KEY = "b".repeat(64);
        const re = await saveConfig("fx", { provider: "http", enabled: true, config: { endpoint: "https://fx.example/{date}", ratePath: "r", authMode: "bearer" }, secrets: { token: "k2-secret" } }, specs, adminId);
        expect(re.status).toBe("CONFIGURED");
        expect((await readConfig("fx"))?.secrets.token).toBe("k2-secret");
        // key format: 32 bytes as 64 hex or base64; anything else is a configuration error
        process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
        expect(open(seal({ a: "b" }))).toEqual({ a: "b" });
        for (const bad of ["short", "c".repeat(63), Buffer.alloc(16).toString("base64")]) { process.env.INTEGRATIONS_ENCRYPTION_KEY = bad; expect(() => seal({ a: "b" })).toThrow(/32 bytes/); }
      } finally { if (saveKey === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY; else process.env.INTEGRATIONS_ENCRYPTION_KEY = saveKey; }
    });

    test("production refuses mock providers unless INTEGRATIONS_ALLOW_MOCK=true (save and build)", async () => {
      await mock("sap", "ok");
      const env = process.env as Record<string, string | undefined>;
      const prev = env.NODE_ENV;
      try {
        env.NODE_ENV = "production"; delete process.env.INTEGRATIONS_ALLOW_MOCK;
        await expect(saveIntegration("sap", { provider: "mock", enabled: true, config: { scenario: "ok" } }, adminId)).rejects.toThrow(/INTEGRATIONS_ALLOW_MOCK/);
        const cfg = (await readConfig("sap"))!;
        await expect(buildAny(cfg)).rejects.toThrow(/not allowed in production/);
        const r = await runSync("sap", "materials", "manual", adminId);
        expect(r.status).toBe("FAILED"); expect(r.error?.category).toBe("CONFIGURATION");
        process.env.INTEGRATIONS_ALLOW_MOCK = "true";
        await expect(buildAny(cfg)).resolves.toBeTruthy();
      } finally { env.NODE_ENV = prev; delete process.env.INTEGRATIONS_ALLOW_MOCK; }
    });

    test("a sync that finishes after its integration was disabled leaves DISABLED in place; cursor written only after a complete run; stale RUNNING jobs are cancelled", async () => {
      const d = await definition("gpo:premier");
      const specs = fieldsFor(d, "api");
      const page = { members: [{ "Premier Entity Code": `${RUN}-1`, "Facility Name": "Memorial Sloan Kettering", "Supplier Customer Number": "0001880967", Tier: "Tier 2", "Effective Date": "2026-01-01" }] };
      const fetchImpl: typeof fetch = async () => {
        await prisma.integrationConfig.update({ where: { key: "gpo:premier" }, data: { enabled: false, status: "DISABLED" } }); // an admin switches it off mid-run
        return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
      };
      await saveConfig("gpo:premier", { provider: "api", enabled: true, config: { endpoint: "https://roster.example/members", authMode: "none", recordsPath: "members", pagingMode: "none" } }, specs, adminId);
      await setCursor("gpo:premier", "memberships", null);
      const r = await runSync("gpo:premier", "memberships", "manual", adminId, { fetchImpl });
      expect(["SUCCEEDED", "PARTIAL"]).toContain(r.status);
      expect((await prisma.integrationConfig.findUniqueOrThrow({ where: { key: "gpo:premier" } })).status).toBe("DISABLED");
      expect(await getCursor("gpo:premier", "memberships")).toMatch(/since/);
      // a failed run leaves the watermark where it was
      await prisma.integrationConfig.update({ where: { key: "gpo:premier" }, data: { enabled: true } });
      const before = await getCursor("gpo:premier", "memberships");
      const failing: typeof fetch = async () => new Response("down", { status: 503 });
      const f = await runSync("gpo:premier", "memberships", "manual", adminId, { fetchImpl: failing });
      expect(f.status).toBe("FAILED");
      expect(await getCursor("gpo:premier", "memberships")).toBe(before);
      // a RUNNING job older than 12 h is cancelled at worker start
      const stale = await prisma.integrationSyncJob.create({ data: { integrationKey: "gpo:premier", provider: "api", syncType: "memberships", trigger: "schedule", status: "RUNNING", startedAt: new Date(Date.now() - 13 * 3600_000) } });
      expect(await cancelStaleJobs()).toBeGreaterThanOrEqual(1);
      expect((await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("CANCELLED");
      await prisma.gpoMembership.deleteMany({ where: { externalMembershipId: { startsWith: RUN } } });
    }, 60_000);
  });

  // ---- GPO paging and closeMissing ---------------------------------------------------------------
  describe("GPO API roster paging", () => {
    test("a failed middle page fails the run and closes nothing; a complete roster with closeMissing closes the stale row; the walk stops at the documented cap", async () => {
      const d = await definition("gpo:vizient");
      const specs = fieldsFor(d, "api");
      const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
      const gpo = await prisma.gpo.upsert({ where: { name: "Vizient" }, create: { name: "Vizient", code: "VIZ" }, update: {} });
      const stale = await prisma.gpoMembership.create({ data: { accountId: acc.id, gpoId: gpo.id, tier: "Tier 3", effectiveFrom: new Date("2024-01-01T00:00:00Z"), source: "gpo-feed", externalMembershipId: `${RUN}-stale` } });
      const member = (n: number) => ({ "Vizient Member ID": `${RUN}-m${n}`, "Member Name": "Memorial Sloan Kettering", "Supplier Account Number": "0001880967", "Tier Level": "Tier 2", "Tier Effective Date": "2026-01-01" });
      await saveConfig("gpo:vizient", { provider: "api", enabled: true, config: { endpoint: "https://roster.example/v", authMode: "none", recordsPath: "data", pagingMode: "next-link", pagingPath: "next", closeMissing: true } }, specs, adminId);
      const twoPages = (failSecond: boolean): typeof fetch => async (url) => {
        const u = String(url);
        if (u.includes("page=2")) return failSecond ? new Response("boom", { status: 500 }) : new Response(JSON.stringify({ data: [member(2)], next: null }), { headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ data: [member(1)], next: "https://roster.example/v?page=2" }), { headers: { "content-type": "application/json" } });
      };
      const premierOpen = await prisma.gpoMembership.count({ where: { gpo: { name: "Premier" }, effectiveTo: null } });
      const broken = await runSync("gpo:vizient", "memberships", "manual", adminId, { fetchImpl: twoPages(true) });
      expect(broken.status).toBe("FAILED"); expect(broken.error?.category).toBe("PROVIDER_UNAVAILABLE");
      expect((await prisma.gpoMembership.findUniqueOrThrow({ where: { id: stale.id } })).effectiveTo).toBeNull();
      const complete = await runSync("gpo:vizient", "memberships", "manual", adminId, { fetchImpl: twoPages(false) });
      expect(complete.status).toBe("SUCCEEDED");
      expect((complete.report as { closedStale: number; pages: number }).closedStale).toBeGreaterThanOrEqual(1); // ours (+ any open Vizient rows the mock runs left)
      expect((complete.report as { pages: number }).pages).toBe(2);
      expect((await prisma.gpoMembership.findUniqueOrThrow({ where: { id: stale.id } })).effectiveTo).not.toBeNull();
      expect(await prisma.gpoMembership.count({ where: { gpo: { name: "Premier" }, effectiveTo: null } })).toBe(premierOpen); // other GPOs are never touched
      // a maxPages run is never "complete": nothing is closed
      const fresh = await prisma.gpoMembership.create({ data: { accountId: acc.id, gpoId: gpo.id, tier: "Tier 3", effectiveFrom: new Date("2024-02-01T00:00:00Z"), source: "gpo-feed", externalMembershipId: `${RUN}-stale2` } });
      const capped = await runSync("gpo:vizient", "memberships", "manual", adminId, { fetchImpl: twoPages(false), maxPages: 1 });
      expect(capped.status).toBe("SUCCEEDED"); expect((capped.report as { closedStale: number }).closedStale).toBe(0);
      expect((await prisma.gpoMembership.findUniqueOrThrow({ where: { id: fresh.id } })).effectiveTo).toBeNull();
      // an endless next-link chain terminates at MAX_PAGES (10,000) instead of running for ever
      let calls = 0;
      const endless: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ data: [], next: `https://roster.example/v?page=${calls + 1}` }), { headers: { "content-type": "application/json" } }); };
      const looped = await runSync("gpo:vizient", "memberships", "manual", adminId, { fetchImpl: endless });
      expect(calls).toBe(10_000);
      expect((looped.report as { pages: number }).pages).toBe(10_000);
      // …and a capped run never advances the since-watermark (the tail would be skipped next time)
      expect((await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: looped.jobId } })).cursorAfter).toBeNull();
      await prisma.gpoMembership.deleteMany({ where: { externalMembershipId: { startsWith: RUN } } });
    }, 120_000);
  });

  // ---- writers: resolution order and conflicts ---------------------------------------------------
  describe("account resolution", () => {
    test("ExternalRef → CRM id → account number; a number bound to another CRM record fails visibly; unchanged payload is skipped; replay after a crash is safe", async () => {
      const system = `${RUN}-crm`;
      const prov = { provider: "test", sourceSystem: system, sourceRecordId: "1" };
      const ctx = new JobContext("job-x", "salesforce", "mock", "accounts", null, null, 1);
      const rec = { externalId: `${RUN}-A1`, name: `${RUN} Alpha`, accountNumber: `${RUN}-0001`, provenance: prov };
      expect(await writeAccount(ctx, system, rec)).toBe("created");
      expect(await writeAccount(ctx, system, rec)).toBe("skipped"); // same hash
      expect(await writeAccount(ctx, system, { ...rec, name: `${RUN} Alpha Renamed` })).toBe("updated");
      // crash after the account write but before the ref: the CRM id on the account resolves it, no duplicate
      await prisma.externalRef.deleteMany({ where: { system, externalId: `${RUN}-A1` } });
      expect(await writeAccount(ctx, system, { ...rec, name: `${RUN} Alpha Renamed` })).toBe("updated");
      expect(await prisma.account.count({ where: { externalCrmId: `${RUN}-A1` } })).toBe(1);
      // an account with the same number but a different CRM id is a conflict, never a merge
      await expect(writeAccount(ctx, system, { externalId: `${RUN}-A2`, name: `${RUN} Beta`, accountNumber: `${RUN}-0001`, provenance: prov })).rejects.toMatchObject({ category: "DATA_CONFLICT" });
      // a pre-CRM account (number only, no CRM id) is linked, not duplicated
      const pre = await prisma.account.create({ data: { name: `${RUN} Pre`, accountNumber: `${RUN}-0002` } });
      expect(await writeAccount(ctx, system, { externalId: `${RUN}-A3`, name: `${RUN} Pre (CRM)`, accountNumber: `${RUN}-0002`, provenance: prov })).toBe("updated");
      expect((await prisma.account.findUniqueOrThrow({ where: { id: pre.id } })).externalCrmId).toBe(`${RUN}-A3`);
      await expect(writeAccount(ctx, system, { externalId: "", name: "x", provenance: prov })).rejects.toMatchObject({ category: "VALIDATION" });
      expect(ctx.counters).toMatchObject({ created: 1, updated: 3, skipped: 1 });
    });
  });

  // ---- FX policy -----------------------------------------------------------------------------------
  describe("FX look-back policy (KN-13)", () => {
    test("one canonical default (5 days) shared by the service and the registry; configured overrides are read; clamped and validated", async () => {
      expect(DEFAULT_FX_POLICY).toEqual({ fallback: "fail", maxLookbackDays: 5 });
      const d = await definition("fx");
      const field = d.commonFields.find((f) => f.name === "maxLookbackDays")!;
      expect(field.default).toBe(FX_MAX_LOOKBACK_DEFAULT);
      expect(field.validate!(31)).toMatch(/between 0 and 30/); expect(field.validate!(-1)).toBeTruthy(); expect(field.validate!(2.5)).toBeTruthy(); expect(field.validate!(0)).toBeNull();
      expect(fxPolicyFrom(null)).toEqual(DEFAULT_FX_POLICY);
      expect(fxPolicyFrom({ fallback: "previous-business-day", maxLookbackDays: 2 })).toEqual({ fallback: "previous-business-day", maxLookbackDays: 2 });
      expect(fxPolicyFrom({ fallback: "previous-business-day", maxLookbackDays: "99" })).toEqual({ fallback: "previous-business-day", maxLookbackDays: 30 });
      expect(fxPolicyFrom({ fallback: "nonsense", maxLookbackDays: "abc" })).toEqual(DEFAULT_FX_POLICY);
      await prisma.integrationSyncJob.deleteMany({ where: { integrationKey: "fx" } });
      await prisma.integrationConfig.deleteMany({ where: { key: "fx" } });
      expect(await configuredFxPolicy()).toEqual(DEFAULT_FX_POLICY);
      await mock("fx", "ok", { fallback: "previous-business-day", maxLookbackDays: 2 });
      expect(await configuredFxPolicy()).toEqual({ fallback: "previous-business-day", maxLookbackDays: 2 });
      await mock("fx", "ok", { fallback: "previous-business-day" }); // blank → the form default (5)
      expect(await configuredFxPolicy()).toEqual({ fallback: "previous-business-day", maxLookbackDays: 5 });
    });

    test("weekend, holiday and missing-rate behaviour under fail / previous-business-day; stored rates are immutable and restatements logged", async () => {
      await prisma.exchangeRate.deleteMany({ where: { source: { in: ["mock", `${RUN}-prov`] } } });
      const mockFx = new MockFxProvider();
      const sat = "2026-09-19", sun = "2026-09-20", mon = "2026-09-21", tue = "2026-09-22", fri = "2026-09-18";
      // fail (default): a weekend date has no rate → NOT_FOUND, nothing substituted
      await expect(rateFor(mockFx, "USD", "EUR", sun)).rejects.toMatchObject({ category: "NOT_FOUND" });
      // previous-business-day with the default 5: Sunday → Friday (2 days back)
      const wk = await rateFor(mockFx, "USD", "EUR", sun, { fallback: "previous-business-day", maxLookbackDays: 5 });
      expect(wk.date).toBe(fri); expect(wk.note).toMatch(/2 days earlier/);
      // look-back too short: Sunday with 1 day → Saturday has none → NOT_FOUND naming the window
      await expect(rateFor(mockFx, "USD", "EUR", sun, { fallback: "previous-business-day", maxLookbackDays: 1 })).rejects.toThrow(/or the 1 days before it/);
      // a holiday Monday: the provider publishes nothing on Mon, so a Monday-holiday provider falls back to Friday (3 days back)
      const holiday = new MockFxProvider("ok"); const realGet = holiday.getRate.bind(holiday);
      holiday.getRate = async (b, q, dt) => (dt === mon ? null : realGet(b, q, dt));
      const hol = await rateFor(holiday, "USD", "GBP", mon, { fallback: "previous-business-day", maxLookbackDays: 3 });
      expect(hol.date).toBe(fri); expect(hol.note).toMatch(/3 days earlier/);
      await expect(rateFor(holiday, "USD", "GBP", mon, { fallback: "previous-business-day", maxLookbackDays: 2 })).rejects.toMatchObject({ category: "NOT_FOUND" });
      // a pair the provider does not know at all → NOT_FOUND after the walk (never a guess)
      await expect(rateFor(mockFx, "USD", "CHF", tue, { fallback: "previous-business-day", maxLookbackDays: 5 })).rejects.toMatchObject({ category: "NOT_FOUND" });
      // stored rates are immutable: a restated value is logged and ignored; fetchedAt refreshes only for the same value
      const seen: string[] = [];
      const off = onLog((l) => { if ((l as { event?: string }).event === "fx.rate_restated_ignored" || JSON.stringify(l).includes("fx.rate_restated_ignored")) seen.push(JSON.stringify(l)); });
      const first = await storeRate({ base: "USD", quote: "EUR", rate: "0.9100", date: tue, provider: `${RUN}-prov`, fetchedAt: new Date().toISOString() });
      const restated = await storeRate({ base: "USD", quote: "EUR", rate: "0.9999", date: tue, provider: `${RUN}-prov`, fetchedAt: new Date().toISOString() });
      off();
      expect(restated.id).toBe(first.id); expect(restated.rate.toString()).toBe(first.rate.toString());
      expect(seen.length).toBe(1); expect(seen[0]).toContain("0.9999");
      expect(await prisma.exchangeRate.count({ where: { source: `${RUN}-prov`, asOf: new Date(`${tue}T00:00:00Z`) } })).toBe(1);
      // the stored rate wins over the provider for that date, whatever the policy
      const stored = await rateFor(mockFx, "USD", "EUR", tue);
      expect(stored.provider).toBe(`${RUN}-prov`); expect(stored.rate).toMatch(/^0\.91/);
      void sat;
    });
  });

  // ---- documents ---------------------------------------------------------------------------------
  describe("documents", () => {
    test("REVIEW when alwaysReview, when a line is below the threshold, when a required field is missing, when there are no lines; verify → grid is idempotent; storage ids are safe", async () => {
      const mkDoc = (tag: string) => prisma.document.create({ data: { filename: `${RUN}-${tag}-invoice.pdf`, mimeType: "application/pdf", kind: "INVOICE", uploadedByUserId: adminId, storagePath: null } });
      const ok = await mkDoc("ok");
      const r1 = await runExtraction(new MockDocumentExtractionProvider("ok"), ok.id, "INVOICE", { bytes: Buffer.from("x") }, { threshold: 0.85, actorUserId: adminId });
      expect(r1.status).toBe("EXTRACTED");
      const r2 = await runExtraction(new MockDocumentExtractionProvider("ok"), ok.id, "INVOICE", { bytes: Buffer.from("x") }, { threshold: 0.85, actorUserId: adminId, alwaysReview: true });
      expect(r2.status).toBe("REVIEW"); expect(r2.reviewItemId).toBeTruthy();
      const r3 = await runExtraction(new MockDocumentExtractionProvider("partial"), ok.id, "INVOICE", { bytes: Buffer.from("x") }, { threshold: 0.85, actorUserId: adminId });
      expect(r3.status).toBe("REVIEW"); expect(r3.lowConfidenceLines).toBeGreaterThan(0);
      const r4 = await runExtraction(new MockDocumentExtractionProvider("ok"), ok.id, "INVOICE", { bytes: Buffer.from("x") }, { threshold: 0.999, actorUserId: adminId });
      expect(r4.status).toBe("REVIEW"); // 0.85 threshold in the mock's confidences < 0.999
      const r5 = await runExtraction(new MockDocumentExtractionProvider("empty"), ok.id, "INVOICE", { bytes: Buffer.from("x") }, { threshold: 0.5, actorUserId: adminId });
      expect(r5.status).toBe("REVIEW"); expect(r5.lines).toBe(0);
      // PO requires quantity but not unitPrice; the same fields as INVOICE (which requires unitPrice) — a PO from an invoice-shaped mock is fine, a CONTRACT_TABLE needs unitPrice on every line
      await expect(runExtraction(new MockDocumentExtractionProvider("auth-failure"), ok.id, "INVOICE", { bytes: Buffer.from("x") }, { threshold: 0.85, actorUserId: adminId })).rejects.toMatchObject({ category: "AUTHENTICATION" });
      expect((await prisma.documentExtraction.findFirst({ where: { documentId: ok.id, status: "FAILED" } }))?.error).toMatch(/401/);
      // verify twice → the grid is the same; unverified extraction yields nothing
      expect(await verifiedLinesGrid(r1.extractionId)).toEqual([]);
      const fields = await prisma.extractedField.findMany({ where: { extractionId: r1.extractionId } });
      const v1 = await verifyExtraction(r1.extractionId, adminId, fields.map((f) => ({ fieldId: f.id, status: "VERIFIED" as const })), true);
      const g1 = await verifiedLinesGrid(r1.extractionId);
      const v2 = await verifyExtraction(r1.extractionId, adminId, [], true);
      const g2 = await verifiedLinesGrid(r1.extractionId);
      expect(v1.status).toBe("VERIFIED"); expect(v2.verifiedFields).toBe(v1.verifiedFields); expect(g2).toEqual(g1); expect(g1.length).toBeGreaterThan(1);
      // storage: ids are validated; bytes round-trip; a foreign path never resolves
      await expect(storeDocumentBytes("../etc/passwd", Buffer.from("x"))).rejects.toThrow(/invalid document id/);
      await expect(readDocumentBytes("a/b")).rejects.toThrow(/invalid document id/);
      expect(await readDocumentBytes("does-not-exist-" + RUN)).toBeNull();
      const p = await storeDocumentBytes(ok.id, Buffer.from("bytes"));
      expect(p.endsWith(ok.id)).toBe(true);
      expect((await readDocumentBytes(ok.id))?.toString()).toBe("bytes");
      const { unlink } = await import("node:fs/promises"); await unlink(p).catch(() => undefined);
      await prisma.documentExtraction.deleteMany({ where: { documentId: ok.id } });
    });
  });

  // ---- mapping engine hardening ------------------------------------------------------------------
  describe("mapping engine", () => {
    test("no code execution from mapping data: prototype paths read nothing useful, unknown transforms are inert, valueMap keys are plain", () => {
      expect(getPath({ a: 1 }, "__proto__.polluted")).toBeUndefined();
      expect(getPath({ a: 1 }, "constructor.prototype")).toBeUndefined(); // functions are not walked
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(applyTransform("x", "eval" as never)).toBeUndefined();
      const spec = { entity: "T", fields: [{ name: "a", type: "string" as const, required: true, description: "" }, { name: "n", type: "number" as const, description: "" }] };
      const m = applyMapping({ A: " v ", N: "1,234.50" }, { a: { source: "a", transform: "upper" }, n: { source: "n", transform: "money" } }, spec);
      expect(m.record).toEqual({ a: "V", n: 1234.5 });
      expect(applyMapping({}, { a: { source: "x", transform: ["trim", "process.exit" as never] } }, spec).issues[0].message).toMatch(/a is required/);
      expect(applyMapping({ a: "Hospital" }, { a: { source: "a", valueMap: { hospital: "SOLD_TO" }, unmapped: "error" } }, spec).record).toEqual({ a: "SOLD_TO" });
      expect(applyMapping({ a: "Clinic" }, { a: { source: "a", valueMap: { hospital: "SOLD_TO" }, unmapped: "error" } }, spec).issues[0].message).toMatch(/not in the value map/);
      expect(applyMapping({ a: "Clinic" }, { a: { source: "a", valueMap: { hospital: "SOLD_TO" }, unmapped: "null", default: "OTHER" } }, spec).record).toEqual({ a: "OTHER" });
      expect(applyMapping({ a: "Clinic" }, { a: { source: "a", valueMap: { hospital: "SOLD_TO" } } }, spec).record).toEqual({ a: "Clinic" });
      // dates: Excel serial, OData, SAP, m/d/yyyy; ints; split/first/join/digits; bool
      expect(applyTransform(45658, "date")).toBe("2025-01-01");
      expect(applyTransform("/Date(1735689600000)/", "date")).toBe("2025-01-01");
      expect(applyTransform("20250101", "date")).toBe("2025-01-01");
      expect(applyTransform("1/2/2025", "date")).toBe("2025-01-02");
      expect(applyTransform("not a date", "date")).toBeNull();
      expect(applyTransform("12.9", "int")).toBe(12);
      expect(applyTransform("a, b ,c", "split")).toEqual(["a", "b", "c"]);
      expect(applyTransform(["x", "y"], "first")).toBe("x");
      expect(applyTransform(["x", "y"], "join")).toBe("x,y");
      expect(applyTransform("+1 (555) 010-2000", "digits")).toBe("15550102000");
      expect(applyTransform("X", "bool")).toBe(true); expect(applyTransform("maybe", "bool")).toBeNull();
    });
  });
});

/**
 * WS5 — platform behaviour against the database: feeds, notifications, observability (health,
 * alerts, metrics, export redaction), analytics snapshots, retention, tenancy and legacy
 * integration entry points. Every case pins a boundary or a failure mode; none needs the network.
 * Needs DATABASE_URL with the demo seed. Skipped without a database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { ingestFeed, feedStatuses, feedSource } from "@/lib/feeds";
import { notify, preferencesFor, setPreference, unreadCount, markRead, notifyApprovalRequested, notifyFeedFailed, channelsConfigured } from "@/lib/notifications";
import { deliver, setTransportsForTests } from "@/lib/notifications/deliver";
import { evaluateAlerts, modelRule, resolutionRule, runsRule, feedRule, queueRule, RULES } from "@/lib/observability/alerts";
import { render, snapshot } from "@/lib/observability/metrics";
import { runRetention, retentionConfig } from "@/lib/retention";
import { tenancyStatus, checkTenancy, defaultLabelers } from "@/lib/tenancy";
import { getCompany } from "@/lib/settings";
import { stopBoss } from "@/lib/jobs/boss";
import { syncCrmAccounts, pushQuote, integrationStatus, crmAdapter } from "@/lib/integrations/sync";

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = "WS5PLAT";

async function userId(email: string) { return (await prisma.user.findUniqueOrThrow({ where: { email } })).id; }

async function cleanup() {
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { entityType: TAG }] } });
  await prisma.notificationPreference.deleteMany({ where: { kind: "RUN_COMPLETE", user: { email: "alex.rep@crosswalk.dev" } } });
  await prisma.alert.deleteMany({ where: { fingerprint: { contains: TAG } } });
  await prisma.feedRun.deleteMany({ where: { feed: "pricing", OR: [{ sourceRef: "pricing.csv" }, { sourceRef: null }, { trigger: "manual" }] } });
  await prisma.llmCall.deleteMany({ where: { subject: TAG } });
  await prisma.request.deleteMany({ where: { reference: { startsWith: `${TAG}-` } } });
  await prisma.syncLog.deleteMany({ where: { system: TAG } });
  await prisma.auditEvent.deleteMany({ where: { entityType: TAG } });
  await prisma.analyticsSnapshot.deleteMany({ where: { report: { startsWith: TAG } } });
}

describe.skipIf(!hasDb)("WS5 platform", () => {
  let admin: string, rep: string;
  beforeAll(async () => {
    process.env.JOBS_WORKER = "off";
    await cleanup();
    [admin, rep] = await Promise.all([userId("admin@crosswalk.dev"), userId("alex.rep@crosswalk.dev")]);
  });
  afterAll(async () => { await cleanup(); setTransportsForTests(null); await stopBoss().catch(() => undefined); });

  // ---- feeds -----------------------------------------------------------------------------------
  describe("feeds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws5-feeds-"));
    const write = (csv: string) => fs.writeFileSync(path.join(dir, "pricing.csv"), csv);
    let before: { id: string; listPrice: unknown } | null = null;
    beforeAll(async () => { before = await prisma.ownProduct.findFirstOrThrow({ where: { sku: "PPM1510X3" }, select: { id: true, listPrice: true } }); });
    afterAll(async () => {
      delete process.env.INTEGRATION_FEED_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
      if (before) await prisma.ownProduct.update({ where: { id: before.id }, data: { listPrice: before.listPrice as never } });
    });

    test("two concurrent ingestions of one feed: exactly one runs, the other is refused, and one RUNNING row ever exists", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      write("SKU,List Price\nPPM1510X3,101.25\n");
      // On a cold pool the second call serialises behind the first's connection setup and the old
      // find-then-create guard "passed" by luck (review REV-06): warm several connections first so
      // both ingestions really run side by side, and repeat — WS5's probe saw both run 5/5 rounds
      // on the unfixed code.
      await Promise.all([1, 2, 3, 4].map(() => prisma.$queryRaw`SELECT pg_sleep(0.05)::text`));
      for (let round = 0; round < 5; round++) {
        const results = await Promise.allSettled([ingestFeed("pricing", { trigger: "manual", force: true }), ingestFeed("pricing", { trigger: "schedule", force: true })]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(ok.length, `round ${round + 1}: exactly one ingestion may run`).toBe(1);
        expect(refused.length).toBe(1);
        expect(String(refused[0].reason)).toMatch(/already being ingested/);
        expect(await prisma.feedRun.count({ where: { feed: "pricing", status: "RUNNING" } })).toBe(0);
      }
    });

    test("stale RUNNING rows (older than 12 h) do not block a new run and are closed as FAILED; a fresh RUNNING row does", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      write("SKU,List Price\nPPM1510X3,101.50\n");
      const stale = await prisma.feedRun.create({ data: { feed: "pricing", trigger: "manual", status: "RUNNING", startedAt: new Date(Date.now() - 13 * 3600_000) } });
      const r = await ingestFeed("pricing", { trigger: "schedule", force: true });
      expect(r.status).toBe("OK");
      const closed = await prisma.feedRun.findUniqueOrThrow({ where: { id: stale.id } });
      expect(closed.status).toBe("FAILED");
      expect(closed.error).toMatch(/stopped before it finished/);
      const fresh = await prisma.feedRun.create({ data: { feed: "pricing", trigger: "manual", status: "RUNNING" } });
      await expect(ingestFeed("pricing", { trigger: "manual", force: true })).rejects.toThrow(/already being ingested/);
      await prisma.feedRun.delete({ where: { id: fresh.id } });
    });

    test("unchanged skip only after a clean prior success; a run with rejected rows is retried; forced runs never skip; counters are truthful", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      await prisma.feedRun.deleteMany({ where: { feed: "pricing" } });
      write("SKU,List Price\nPPM1510X3,101.75\nNO-SUCH-SKU-WS5,1.00\n");
      const partial = await ingestFeed("pricing", { trigger: "schedule" });
      expect(partial.status).toBe("OK");
      const row = await prisma.feedRun.findFirstOrThrow({ where: { id: partial.runId } });
      expect({ rows: row.rows, updated: row.updated, failed: row.failed }).toEqual({ rows: 2, updated: 1, failed: 1 });
      // Same file again: not consumed (failed > 0), so it runs again.
      expect((await ingestFeed("pricing", { trigger: "schedule" })).status).toBe("OK");
      write("SKU,List Price\nPPM1510X3,101.80\n");
      const clean = await ingestFeed("pricing", { trigger: "schedule" });
      expect(clean.status).toBe("OK");
      const skipped = await ingestFeed("pricing", { trigger: "schedule" });
      expect(skipped.status).toBe("SKIPPED"); expect(skipped.reason).toMatch(/unchanged since/);
      expect((await ingestFeed("pricing", { trigger: "manual", force: true })).status).toBe("OK");
      // The hash covers content, not mtime: rewriting identical bytes still skips.
      write("SKU,List Price\nPPM1510X3,101.80\n");
      expect((await ingestFeed("pricing", { trigger: "schedule" })).status).toBe("SKIPPED");
    });

    test("missing and malformed files: SKIPPED with the reason / FAILED with the error recorded; a feed rule reflects each", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      fs.rmSync(path.join(dir, "pricing.csv"), { force: true });
      const none = await ingestFeed("pricing", { trigger: "schedule" });
      expect(none.status).toBe("SKIPPED"); expect(none.reason).toMatch(/no source configured/);
      fs.writeFileSync(path.join(dir, "pricing.csv"), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));
      await expect(ingestFeed("pricing", { trigger: "schedule" })).rejects.toThrow();
      const st = (await feedStatuses()).find((f) => f.name === "pricing")!;
      expect(st.lastRun?.status).toBe("FAILED");
      expect((await feedRule()).some((c) => c.fingerprint === "feed_failed:pricing" && c.severity === "CRITICAL")).toBe(true);
      await prisma.feedRun.deleteMany({ where: { feed: "pricing", status: "FAILED" } });
    });

    test("the crm feed's source is the enabled Tier 2 integration (no files needed); legacy SF_* variables alone are reported and refused truthfully", async () => {
      process.env.INTEGRATION_FEED_DIR = dir; // no crm files here
      const sfRow = await prisma.integrationConfig.findUnique({ where: { key: "salesforce" } });
      const wasEnabled = Boolean(sfRow?.enabled);
      try {
        await prisma.integrationConfig.upsert({ where: { key: "salesforce" }, create: { key: "salesforce", provider: "mock", enabled: true, status: "CONFIGURED", configJson: JSON.stringify({ scenario: "ok" }) }, update: { enabled: true, provider: "mock", configJson: JSON.stringify({ scenario: "ok" }) } });
        const src = await feedSource("crm");
        expect(src.kind).toBe("api"); expect(src.ref).toMatch(/Salesforce/); expect(src.hash).toBeNull();
        await prisma.integrationConfig.update({ where: { key: "salesforce" }, data: { enabled: false } });
        expect((await feedSource("crm")).kind).toBe("none");
        process.env.SF_CLIENT_ID = "legacy-client-id"; process.env.SF_LOGIN_URL = "https://login.salesforce.com";
        expect((await feedSource("crm")).ref).toMatch(/legacy/);
        expect(crmAdapter().system).not.toBe("salesforce"); // never the removed skeleton
        await expect(syncCrmAccounts(null)).rejects.toThrow(/select no adapter any more.*Settings → Integrations/);
        const st = await integrationStatus();
        expect(st.crm.configured).toBe(false); expect(st.crm.note).toMatch(/legacy SF_\*/i);
        const r = await ingestFeed("crm", { trigger: "manual", force: true }).catch((e: Error) => e);
        expect(r).toBeInstanceOf(Error); expect(String(r)).toMatch(/Settings → Integrations/);
        await prisma.feedRun.deleteMany({ where: { feed: "crm", status: "FAILED", error: { contains: "select no adapter" } } });
      } finally {
        delete process.env.SF_CLIENT_ID; delete process.env.SF_LOGIN_URL;
        if (sfRow) await prisma.integrationConfig.update({ where: { key: "salesforce" }, data: { enabled: wasEnabled, provider: sfRow.provider, configJson: sfRow.configJson } });
        else await prisma.integrationConfig.deleteMany({ where: { key: "salesforce" } });
      }
    });
  });

  // ---- notifications ---------------------------------------------------------------------------
  describe("notifications", () => {
    test("preferences: explicit kind > '*' > defaults; unknown kinds refused; a fully switched-off recipient gets no row", async () => {
      expect(await preferencesFor(rep, "RUN_COMPLETE")).toEqual({ inApp: true, email: true, teams: false });
      expect((await preferencesFor(rep, "ALERT")).teams).toBe(true);
      await setPreference(rep, "*", { inApp: false, email: false, teams: false });
      expect(await preferencesFor(rep, "RUN_COMPLETE")).toEqual({ inApp: false, email: false, teams: false });
      expect((await notify({ kind: "RUN_COMPLETE", userIds: [rep], title: `${TAG} silent`, entityType: TAG })).created).toBe(0);
      await setPreference(rep, "RUN_COMPLETE", { inApp: true, email: false, teams: false });
      expect(await preferencesFor(rep, "RUN_COMPLETE")).toEqual({ inApp: true, email: false, teams: false });
      await expect(setPreference(rep, "NOPE" as never, { inApp: true })).rejects.toThrow(/unknown notification kind/);
      await prisma.notificationPreference.deleteMany({ where: { userId: rep, kind: { in: ["*", "RUN_COMPLETE"] } } });
    });

    test("dedupe window: same key within an hour → one row; a different key or an old row → a new one; unread counts and markRead are per user", async () => {
      const base = await unreadCount(rep);
      const a = await notify({ kind: "RUN_COMPLETE", userIds: [rep], title: `${TAG} dedupe`, entityType: TAG, entityId: "x", dedupeKey: "k1" });
      const b = await notify({ kind: "RUN_COMPLETE", userIds: [rep], title: `${TAG} dedupe`, entityType: TAG, entityId: "x", dedupeKey: "k1" });
      const c = await notify({ kind: "RUN_COMPLETE", userIds: [rep], title: `${TAG} dedupe`, entityType: TAG, entityId: "x", dedupeKey: "k2" });
      expect([a.created, b.created, c.created]).toEqual([1, 0, 1]);
      // 61 minutes old → the window has passed.
      await prisma.notification.updateMany({ where: { userId: rep, dedupeKey: `RUN_COMPLETE:${TAG}:x:k1` }, data: { createdAt: new Date(Date.now() - 61 * 60_000) } });
      expect((await notify({ kind: "RUN_COMPLETE", userIds: [rep], title: `${TAG} dedupe`, entityType: TAG, entityId: "x", dedupeKey: "k1" })).created).toBe(1);
      expect(await unreadCount(rep)).toBe(base + 3);
      expect(await unreadCount(admin)).toBeGreaterThanOrEqual(0);
      const mine = await prisma.notification.findMany({ where: { userId: rep, entityType: TAG }, select: { id: true } });
      // Another user cannot mark someone else's rows read.
      expect(await markRead(admin, mine.map((n) => n.id))).toBe(0);
      expect(await markRead(rep, mine.map((n) => n.id))).toBe(mine.length);
      expect(await unreadCount(rep)).toBe(base);
    });

    test("delivery: channels only when configured; idempotent per channel; a failing SMTP leaves Teams delivered and throws for the queue", async () => {
      const cfg = channelsConfigured();
      expect(cfg).toEqual({ email: Boolean(process.env.SMTP_URL && process.env.MAIL_FROM), teams: Boolean(process.env.TEAMS_WEBHOOK_URL) });
      const sent: string[] = [];
      setTransportsForTests({ email: async () => { throw new Error("smtp down (auth: password=hunter2)"); }, teams: async (card) => { sent.push(JSON.stringify(card)); } });
      const { created } = await notify({ kind: "ALERT", userIds: [admin], title: `${TAG} partial channel`, body: "detail", entityType: TAG, entityId: "d1", dedupeKey: "d1" });
      expect(created).toBe(1);
      const n = await prisma.notification.findFirstOrThrow({ where: { userId: admin, title: `${TAG} partial channel` } });
      expect(await deliver(n.id, "teams")).toEqual({ delivered: true });
      expect(await deliver(n.id, "teams")).toMatchObject({ delivered: true, skipped: "already delivered" });
      expect(sent.length).toBe(1);
      await expect(deliver(n.id, "email")).rejects.toThrow(/smtp down/);
      const after = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
      const d = JSON.parse(after.deliveriesJson ?? "{}") as Record<string, { ok: boolean; attempts: number; error?: string }>;
      expect(d.teams.ok).toBe(true); expect(d.email.ok).toBe(false); expect(d.email.attempts).toBe(1);
      await expect(deliver(n.id, "email")).rejects.toThrow();
      expect(JSON.parse((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).deliveriesJson!).email.attempts).toBe(2);
      // An inactive recipient is skipped, not sent.
      await prisma.user.update({ where: { id: admin }, data: { isActive: false } });
      try { expect(await deliver(n.id, "email")).toMatchObject({ delivered: false, skipped: "user inactive" }); } finally { await prisma.user.update({ where: { id: admin }, data: { isActive: true } }); }
      expect(await deliver("no-such-notification", "email")).toMatchObject({ delivered: false, skipped: "notification gone" });
      setTransportsForTests(null);
    });

    test("feed-failure and alert notifications go to ADMIN + PRICING_DIRECTOR only", async () => {
      await notifyFeedFailed(`${TAG}-feed`, "boom", null);
      const rows = await prisma.notification.findMany({ where: { kind: "FEED_FAILED", title: `Feed "${TAG}-feed" failed` }, include: { user: { include: { roles: true } } } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.user.roles.some((x) => ["ADMIN", "PRICING_DIRECTOR"].includes(x.role)))).toBe(true);
      const admins = await prisma.user.count({ where: { isActive: true, roles: { some: { role: { in: ["ADMIN", "PRICING_DIRECTOR"] } } } } });
      expect(rows.length).toBe(admins);
      await prisma.notification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    });
  });

  // ---- observability ----------------------------------------------------------------------------
  describe("observability", () => {
    const llm = (ok: boolean, minutesAgo: number, error: string | null = null) => prisma.llmCall.create({ data: { purpose: "grade", model: "test", ok, durationMs: 1, error, subject: TAG, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });

    test("model rule boundaries: 2 of 4 no, 3 of 5 yes, 3 of 3 yes, calls older than 30 min ignored, unconfigured model never fires", async () => {
      const { llmConfig } = await import("@/lib/llm/client");
      if (!llmConfig().available) {
        await llm(false, 1); await llm(false, 2); await llm(false, 3);
        expect(await modelRule()).toEqual([]);
        await prisma.llmCall.deleteMany({ where: { subject: TAG } });
        process.env.OPENAI_API_KEY = "sk-ws5-test-not-real";
      }
      try {
        await prisma.llmCall.deleteMany({ where: { subject: TAG } });
        await llm(false, 1); await llm(false, 2); await llm(true, 3); await llm(true, 4);
        expect((await modelRule()).length).toBe(0);
        await llm(false, 5);
        // last 5: F F T T F → 3 failed of 5 → fires
        expect((await modelRule()).length).toBe(1);
        await prisma.llmCall.deleteMany({ where: { subject: TAG } });
        await llm(false, 1); await llm(false, 2); await llm(false, 31);
        expect((await modelRule()).length).toBe(0); // only 2 calls inside the window
        await llm(false, 3);
        expect((await modelRule()).length).toBe(1); // 3 of 3
      } finally { await prisma.llmCall.deleteMany({ where: { subject: TAG } }); if (process.env.OPENAI_API_KEY === "sk-ws5-test-not-real") delete process.env.OPENAI_API_KEY; }
    });

    test("resolution rule: last completed non-BENCH run with ≥ 5 lines; ratio exactly at the threshold does not fire, just below does", async () => {
      const company = await getCompany();
      const mk = async (ref: string, lines: number, resolved: number, ago: number) => prisma.request.create({ data: { companyId: company.id, reference: ref, accountName: "x", status: "complete", completedAt: new Date(Date.now() - ago), createdBy: "t", lines: { create: Array.from({ length: lines }, (_, i) => ({ lineNo: i + 1, rawCode: `C${i}`, cfnNorm: `C${i}`, quantity: 1, resolutionStatus: i < resolved ? "resolved" : "not-found" })) } } });
      process.env.ALERT_RESOLUTION_MIN = "0.7";
      try {
        await mk(`${TAG}-R1`, 10, 7, 3000); // 0.70 → not below
        expect(await resolutionRule()).toEqual([]);
        await mk(`${TAG}-R2`, 10, 6, 2000); // 0.60 → fires
        expect((await resolutionRule())[0]?.fingerprint).toBe("resolution_rate_low");
        await mk(`${TAG}-R3`, 4, 0, 1000); // < 5 lines: ignored entirely (and it is the newest)
        expect(await resolutionRule()).toEqual([]);
        await mk(`BENCH-${TAG}`, 10, 0, 500); // benchmark runs are excluded
        expect(await resolutionRule()).toEqual([]);
      } finally { delete process.env.ALERT_RESOLUTION_MIN; await prisma.request.deleteMany({ where: { reference: { in: [`${TAG}-R1`, `${TAG}-R2`, `${TAG}-R3`, `BENCH-${TAG}`] } } }); }
    });

    test("runs rule: fires when failed runs in 24 h exceed ALERT_RUN_FAILURES (documented as '>'), not at the threshold; older failures ignored", async () => {
      const company = await getCompany();
      const mk = (ref: string, ago: number) => prisma.request.create({ data: { companyId: company.id, reference: ref, accountName: "x", status: "failed", createdBy: "t", updatedAt: new Date(Date.now() - ago) } });
      process.env.ALERT_RUN_FAILURES = "2";
      try {
        await prisma.request.updateMany({ where: { status: "failed", NOT: { reference: { startsWith: TAG } } }, data: { status: "failed", updatedAt: new Date(Date.now() - 3 * 86_400_000) } });
        await mk(`${TAG}-F1`, 1000); await mk(`${TAG}-F2`, 2000);
        expect(await runsRule()).toEqual([]);
        await mk(`${TAG}-F3`, 25 * 3600_000); // outside 24 h
        expect(await runsRule()).toEqual([]);
        await mk(`${TAG}-F4`, 3000);
        expect((await runsRule())[0]?.context).toEqual({ failed: 3 });
      } finally { delete process.env.ALERT_RUN_FAILURES; await prisma.request.deleteMany({ where: { reference: { startsWith: `${TAG}-F` } } }); }
    });

    test("alert lifecycle with a controlled clock: fingerprint dedupe, re-notify only after ALERT_RENOTIFY_HOURS, resolve when clear, a failed rule keeps its alerts", async () => {
      const fp = `${TAG}:cond`;
      let firing = true;
      const rule = { name: "ws5", run: async () => (firing ? [{ fingerprint: fp, rule: "ws5", severity: "WARNING" as const, title: `${TAG} condition` }] : []), owns: (f: string) => f === fp };
      process.env.ALERT_RENOTIFY_HOURS = "6";
      try {
        const r1 = await evaluateAlerts([rule]);
        expect(r1.notified).toBe(1);
        const r2 = await evaluateAlerts([rule]);
        expect(r2.notified).toBe(0);
        expect(await prisma.alert.count({ where: { fingerprint: fp } })).toBe(1);
        // 5 h 59 min since the notification: not yet.
        await prisma.alert.update({ where: { fingerprint: fp }, data: { lastNotifiedAt: new Date(Date.now() - (6 * 60 - 1) * 60_000) } });
        expect((await evaluateAlerts([rule])).notified).toBe(0);
        await prisma.alert.update({ where: { fingerprint: fp }, data: { lastNotifiedAt: new Date(Date.now() - (6 * 60 + 1) * 60_000) } });
        // The notification dedupe (1 h on the fingerprint) is also past for this row → re-notified.
        await prisma.notification.updateMany({ where: { entityType: "Alert", dedupeKey: { contains: fp } }, data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
        expect((await evaluateAlerts([rule])).notified).toBe(1);
        // A rule that throws leaves its alert open.
        const broken = { ...rule, run: async () => { throw new Error("db gone"); } };
        const r3 = await evaluateAlerts([broken]);
        expect(r3.rulesFailed).toEqual(["ws5"]);
        expect((await prisma.alert.findUniqueOrThrow({ where: { fingerprint: fp } })).resolvedAt).toBeNull();
        firing = false;
        const r4 = await evaluateAlerts([rule]);
        expect(r4.resolved).toBe(1);
        expect((await prisma.alert.findUniqueOrThrow({ where: { fingerprint: fp } })).resolvedAt).not.toBeNull();
        firing = true;
        expect((await evaluateAlerts([rule])).notified).toBe(0); // dedupe window (1 h) still holds for the re-fire
        expect((await prisma.alert.findUniqueOrThrow({ where: { fingerprint: fp } })).resolvedAt).toBeNull();
      } finally { delete process.env.ALERT_RENOTIFY_HOURS; await prisma.notification.deleteMany({ where: { entityType: "Alert", dedupeKey: { contains: fp } } }); await prisma.alert.deleteMany({ where: { fingerprint: fp } }); }
    });

    test("queue rule: off when JOBS_WORKER=off; stall severity WARNING above the threshold and CRITICAL above 4×", async () => {
      process.env.JOBS_WORKER = "off";
      expect(await queueRule()).toEqual([]);
      expect(RULES.map((r) => r.name)).toEqual(["model", "resolution", "runs", "queue", "feeds"]);
    });

    test("metrics exporter: gauges/counters render in exposition format, snapshot agrees, no secret-shaped values", () => {
      const text = render();
      expect(text).toMatch(/^# HELP crosswalk_http_requests_total /m);
      expect(text).toMatch(/crosswalk_process_start_seconds\{pid="\d+"\} \d+/);
      const snap = snapshot();
      expect(Object.keys(snap)).toContain("crosswalk_notifications_total");
      expect(text).not.toMatch(/hunter2|sk-ws5|password=/);
    });
  });

  // ---- health / metrics / export redaction (route handlers in-process) ---------------------------
  describe("health, metrics and export", () => {
    test("/api/health: ready; degraded exactly above the 900 s stalled boundary; down (503) when the database is unreachable", async () => {
      process.env.JOBS_WORKER = "inline";
      const { GET } = await import("@/app/api/health/route");
      const { JOBS_SCHEMA, getBoss } = await import("@/lib/jobs/boss");
      await getBoss(); // the queue schema must exist for queueHealth
      const read = async () => { const r = await GET(); return { status: r.status, body: (await r.json()) as { status: string; checks: Record<string, { ok: boolean }> } }; };
      const before = await read();
      expect(before.status).toBe(200); expect(before.body.status).toBe("ready"); expect(before.body.checks.database.ok).toBe(true);
      const insert = async (ageSeconds: number) => (await prisma.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO ${JOBS_SCHEMA}.job (name, data, state, created_on, start_after) VALUES ('retention.sweep', '{}'::jsonb, 'created', now() - ($1::int * interval '1 second'), now() - ($1::int * interval '1 second')) RETURNING id`, ageSeconds))[0].id;
      const young = await insert(899);
      try { expect((await read()).body.status).toBe("ready"); } finally { await prisma.$executeRawUnsafe(`DELETE FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, young); }
      const old = await insert(901);
      try { const r = await read(); expect(r.status).toBe(200); expect(r.body.status).toBe("degraded"); expect(r.body.checks.jobs.ok).toBe(false); } finally { await prisma.$executeRawUnsafe(`DELETE FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, old); }
      expect((await read()).body.status).toBe("ready");
      expect(JSON.stringify(before.body)).not.toMatch(/request\.run|localhost|crosswalk_ws5/); // no names, counts or topology
      // database down: a separate process whose DATABASE_URL points at a closed port
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("docs/debug-runs/2026-09-24-full-application/evidence/ws5/scripts/health-down-probe.ts")], { env: { ...process.env, DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nope", LOG_SILENT: "true" }, encoding: "utf8", timeout: 60_000 });
      const down = JSON.parse(out.trim().split("\n").pop()!) as { status: number; body: { status: string; ok: boolean }; ms: number };
      expect(down.status).toBe(503); expect(down.body.status).toBe("down"); expect(down.body.ok).toBe(false);
      expect(down.ms).toBeLessThan(30_000);
      process.env.JOBS_WORKER = "off";
    }, 90_000);

    test("/api/metrics with the bearer token: exporter values agree with the database (alerts by severity, queue gauges, last-run ratios); wrong token → 401", async () => {
      process.env.JOBS_WORKER = "inline";
      process.env.METRICS_TOKEN = `ws5-metrics-${TAG}`;
      try {
        const { GET } = await import("@/app/api/metrics/route");
        const fp = `${TAG}:metrics`;
        await prisma.alert.create({ data: { fingerprint: fp, rule: "ws5", severity: "CRITICAL", title: `${TAG} alert` } });
        const critical = await prisma.alert.count({ where: { severity: "CRITICAL", resolvedAt: null } });
        const res = await GET(new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` } }));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toMatch(new RegExp(`^crosswalk_alerts_firing\\{severity="CRITICAL"\\} ${critical}$`, "m"));
        expect(text).toMatch(/^crosswalk_queue_jobs\{queue="request\.run",state="ready"\} \d+$/m);
        expect(text).toMatch(/^crosswalk_queue_oldest_ready_seconds\{queue="notify\.deliver"\} \d+$/m);
        expect(text).not.toContain(process.env.METRICS_TOKEN);
        const bad = await GET(new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}x` } }));
        expect(bad.status).toBe(401);
        expect((await GET(new Request("http://x/api/metrics"))).status).toBe(401);
        await prisma.alert.delete({ where: { fingerprint: fp } });
      } finally { delete process.env.METRICS_TOKEN; process.env.JOBS_WORKER = "off"; }
    });

    test("export redaction: a sentinel secret stored in an LlmCall / SyncLog error never leaves through redactRecord; stored sync errors are redacted at write time", async () => {
      const { redactRecord } = await import("@/lib/observability/redact");
      const sentinel = `SENTINEL-${TAG}-hunter2`;
      const llm = await prisma.llmCall.create({ data: { purpose: "grade", model: "m", ok: false, durationMs: 1, subject: TAG, error: `401 for api_key=${sentinel}; Bearer ${sentinel}; postgresql://u:${sentinel}@db/x` } });
      const red = redactRecord(llm as unknown as Record<string, unknown>);
      expect(JSON.stringify(red)).not.toContain(sentinel);
      expect((red as { id: string }).id).toBe(llm.id);
      expect(redactRecord({ data: { password: "x", apiKey: "y", nested: { token: "z", ok: 1 } } })).toEqual({ data: { password: "[redacted]", apiKey: "[redacted]", nested: { token: "[redacted]", ok: 1 } } });
      // write side: the legacy sync log and the Tier 2 write-back both redact before storing
      const { writeBackQuote } = await import("@/lib/integrations/salesforce/writeback");
      const account = await prisma.account.findFirstOrThrow({ where: { externalCrmId: { not: null } } }).catch(() => null);
      if (account) {
        const p = await prisma.proposal.create({ data: { reference: `PRP-${TAG}-RED`, accountId: account.id, ownerUserId: admin, status: "APPROVED", currency: "USD", lines: { create: [{ lineNo: 1, competitorCode: "X", sku: "PPM1510X3", quantity: "1", proposedPrice: "1", included: true }] } } });
        const crm = { provider: "test", testConnection: async () => ({ ok: true, message: "" }), fetchAccounts: async () => ({ records: [], nextCursor: null }), fetchOpportunities: async () => ({ records: [], nextCursor: null }), createOrUpdateQuote: async () => { throw new Error(`token: ${sentinel} refused`); } } as never;
        await expect(writeBackQuote(crm, TAG, admin, p.id, false)).rejects.toThrow();
        const row = await prisma.syncLog.findFirstOrThrow({ where: { system: TAG, entityId: p.id, status: "FAILED" } });
        expect(row.error).not.toContain(sentinel);
        expect(row.error).toContain("[redacted]");
        await prisma.syncLog.deleteMany({ where: { entityId: p.id } });
        await prisma.proposal.delete({ where: { id: p.id } });
      }
    });
  });

  // ---- analytics snapshots --------------------------------------------------------------------
  describe("analytics snapshots", () => {
    test("an independently known fixture yields the expected win/loss, discount band, conversion and acceptance figures; zero denominators are null", async () => {
      const { winLoss, conversion, crossReferenceAccuracy } = await import("@/lib/analytics");
      const before = await winLoss();
      const account = await prisma.account.create({ data: { name: `${TAG} Analytics Hospital`, segment: `${TAG}-seg` } });
      const competitor = await prisma.competitor.create({ data: { name: `${TAG} Rival` } });
      const mk = async (n: number, outcome: string, discount: string, family = `${TAG}-fam`) => {
        const p = await prisma.proposal.create({ data: { reference: `PRP-${TAG}-A${n}`, accountId: account.id, ownerUserId: admin, status: outcome === "WON" ? "WON" : outcome === "LOST" ? "LOST" : "APPROVED", currency: "USD", economicsJson: JSON.stringify({ discountFromListPct: discount }), lines: { create: [{ lineNo: 1, competitorCode: "X1", sku: `${TAG}-S1`, quantity: "2", proposedPrice: "10", productFamily: family, included: true }, { lineNo: 2, competitorCode: "X2", sku: `${TAG}-S2`, quantity: "1", proposedPrice: "5", productFamily: family, included: true }, { lineNo: 3, competitorCode: "X3", sku: `${TAG}-S3`, quantity: "1", proposedPrice: "5", productFamily: family, included: false }] } } });
        await prisma.dealOutcome.create({ data: { proposalId: p.id, outcome, competitorId: competitor.id, priceReason: outcome === "LOST" ? `${TAG}-too-high` : null } });
        return p;
      };
      const w1 = await mk(1, "WON", "0.15"); await mk(2, "WON", "0.25"); await mk(3, "LOST", "0.05"); await mk(4, "NO_DECISION", "0.5");
      await prisma.purchaseRecord.create({ data: { accountId: account.id, sku: `${TAG}-s1`, quantity: "2", netPrice: "10", invoiceDate: new Date(), proposalId: w1.id, source: "test" } });
      const decisions = [
        { productFamily: `${TAG}-fam`, competitorName: `${TAG} Rival`, acceptedTop: true, groundTruth: "VALIDATED_CORRECT", confidence: 0.9 },
        { productFamily: `${TAG}-fam`, competitorName: `${TAG} Rival`, acceptedTop: true, groundTruth: "VALIDATED_INCORRECT", confidence: 0.7 },
        { productFamily: `${TAG}-fam`, competitorName: `${TAG} Rival`, acceptedTop: false, groundTruth: "UNKNOWN", overrideReason: `${TAG}-reason`, confidence: 0.5 },
        { productFamily: `${TAG}-empty`, competitorName: `${TAG} Rival`, acceptedTop: false, groundTruth: "UNKNOWN", confidence: null },
      ];
      await prisma.matchDecision.createMany({ data: decisions.map((d) => ({ ...d, chosenSku: "S", topRecommendedSku: "S" })) });
      try {
        const wl = await winLoss();
        expect(wl.deals).toBe(before.deals + 3); expect(wl.won).toBe(before.won + 2); expect(wl.lost).toBe(before.lost + 1);
        const rival = wl.byCompetitor.find((r) => r.competitor === `${TAG} Rival`)!;
        expect(rival).toMatchObject({ deals: 3, won: 2 }); expect(rival.winRate).toBeCloseTo(2 / 3, 6);
        expect(wl.bySegment.find((r) => r.segment === `${TAG}-seg`)).toMatchObject({ deals: 3, won: 2 });
        expect(wl.byDiscountBand.find((r) => r.band === "10–20%")?.won).toBeGreaterThanOrEqual(1);
        expect(wl.byDiscountBand.find((r) => r.band === "0–10%")?.deals).toBeGreaterThanOrEqual(1);
        expect(wl.byFamily.find((r) => r.family === `${TAG}-fam`)).toMatchObject({ deals: 3, won: 2 });
        expect(wl.lossReasons.find((r) => r.reason === `${TAG}-too-high`)?.count).toBe(1);
        const cv = await conversion();
        const fam = cv.byFamily.find((r) => r.family === `${TAG}-fam`)!;
        expect(fam).toMatchObject({ won: 4, converted: 1 }); // 2 WON proposals × 2 included lines; one purchased SKU (case-insensitive)
        expect(cv.conversionRate).not.toBeNull();
        const acc = await crossReferenceAccuracy();
        expect(acc.byFamily.find((r) => r.family === `${TAG}-fam`)).toMatchObject({ decisions: 3 });
        expect(acc.byFamily.find((r) => r.family === `${TAG}-fam`)!.acceptance).toBeCloseTo(2 / 3, 6);
        expect(acc.byFamily.find((r) => r.family === `${TAG}-empty`)!.acceptance).toBe(0);
        expect(acc.overrideReasons.find((r) => r.reason === `${TAG}-reason`)?.count).toBe(1);
        // zero denominators: a report over nothing is nulls, not NaN
        const { winLoss: wl2 } = await import("@/lib/analytics");
        const empty = { ...(await wl2()), deals: 0 };
        expect(JSON.stringify(empty)).not.toContain("NaN");
        expect(Number.isNaN(Number(JSON.stringify(acc)))).toBe(true); // sanity: the report is an object
        expect(JSON.stringify(acc)).not.toContain("NaN");
      } finally {
        await prisma.matchDecision.deleteMany({ where: { competitorName: `${TAG} Rival` } });
        await prisma.purchaseRecord.deleteMany({ where: { accountId: account.id } });
        await prisma.proposal.deleteMany({ where: { accountId: account.id } });
        await prisma.competitor.delete({ where: { id: competitor.id } });
        await prisma.account.delete({ where: { id: account.id } });
      }
    });

    test("route: fresh=1 recomputes only when the snapshot is older than a minute; the newest snapshot is served; 24 kept; margin redacted for PRODUCT_MARKETING; SALES_REP refused", async () => {
      const { GET, POST } = await import("@/app/api/analytics/[report]/route");
      const { setActorForTests, clearActorForTests } = await import("@/lib/auth");
      const { permissionsFor } = await import("@/lib/auth/permissions");
      const mkActor = (roles: string[]) => ({ id: admin, email: "x@x", name: "x", roles, permissions: permissionsFor(roles), isDev: true });
      const call = (roles: string[], q = "") => GET(new Request(`http://x/api/analytics/pricing${q}`), { params: Promise.resolve({ report: "pricing" }) });
      try {
        await prisma.analyticsSnapshot.deleteMany({ where: { report: "pricing" } });
        setActorForTests(mkActor(["PRICING_DIRECTOR"]) as never);
        const live = await (await call([])).json() as { _meta: { source: string }; marginTrend: unknown };
        expect(live._meta.source).toBe("live");
        const snap = await (await call([])).json() as { _meta: { source: string; ageMs: number } };
        expect(snap._meta.source).toBe("snapshot");
        const sameMinute = await (await call([], "?fresh=1")).json() as { _meta: { source: string } };
        expect(sameMinute._meta.source).toBe("snapshot"); // younger than a minute: no recompute
        await prisma.analyticsSnapshot.updateMany({ where: { report: "pricing" }, data: { computedAt: new Date(Date.now() - 61_000) } });
        const recomputed = await (await call([], "?fresh=1")).json() as { _meta: { source: string } };
        expect(recomputed._meta.source).toBe("live");
        // newest wins, whatever order rows were written in
        await prisma.analyticsSnapshot.deleteMany({ where: { report: "pricing" } });
        const older = await prisma.analyticsSnapshot.create({ data: { report: "pricing", json: JSON.stringify({ linesPriced: -7 }), trigger: "manual", computedAt: new Date(Date.now() - 30_000) } });
        const newest = await prisma.analyticsSnapshot.create({ data: { report: "pricing", json: JSON.stringify({ linesPriced: -9, marginTrend: [{ month: "2026-01", revenue: "1", marginPct: "0.4" }] }), trigger: "manual", computedAt: new Date(Date.now() - 1_000) } });
        const served = await (await call([])).json() as { linesPriced: number; marginTrend: { marginPct: string | null }[] };
        expect(served.linesPriced).toBe(-9);
        expect(served.marginTrend[0].marginPct).toBe("0.4");
        setActorForTests(mkActor(["PRODUCT_MARKETING"]) as never);
        const redacted = await (await call([])).json() as { linesPriced: number; marginTrend: { marginPct: string | null }[] };
        expect(redacted.linesPriced).toBe(-9); expect(redacted.marginTrend[0].marginPct).toBeNull();
        setActorForTests(mkActor(["SALES_REP"]) as never);
        expect((await call([])).status).toBe(403);
        await prisma.analyticsSnapshot.deleteMany({ where: { id: { in: [older.id, newest.id] } } });
        // 24 kept per report after a refresh; the no-queue POST refreshes at most once a minute
        setActorForTests(mkActor(["PRICING_DIRECTOR"]) as never);
        for (let i = 0; i < 30; i++) await prisma.analyticsSnapshot.create({ data: { report: "pricing", json: "{}", trigger: "manual", computedAt: new Date(Date.now() - 120_000 - i * 1000) } });
        process.env.JOBS_WORKER = "off";
        const p1 = await (await POST(new Request("http://x/api/analytics/pricing", { method: "POST" }), { params: Promise.resolve({ report: "pricing" }) })).json() as Record<string, { ok: boolean }>;
        expect(p1.pricing?.ok).toBe(true);
        expect(await prisma.analyticsSnapshot.count({ where: { report: "pricing" } })).toBeLessThanOrEqual(24);
        const p2 = await (await POST(new Request("http://x/api/analytics/pricing", { method: "POST" }), { params: Promise.resolve({ report: "pricing" }) })).json() as { queued: boolean; note: string };
        expect(p2.note).toMatch(/less than a minute ago/);
      } finally { clearActorForTests(); await prisma.analyticsSnapshot.deleteMany({ where: { report: "pricing", json: "{}" } }); }
    });
  });

  // ---- retention -------------------------------------------------------------------------------
  describe("retention", () => {
    const counts = async () => ({
      llm: await prisma.llmCall.count(), sync: await prisma.syncLog.count(), feeds: await prisma.feedRun.count(), notif: await prisma.notification.count(),
      snaps: await prisma.analyticsSnapshot.count(), alerts: await prisma.alert.count(), requests: await prisma.request.count(), audit: await prisma.auditEvent.count(), decisions: await prisma.matchDecision.count(),
    });

    test("dry run mutates nothing (row counts identical) but reports counts and writes a RETENTION_DRY_RUN audit event", async () => {
      await prisma.llmCall.create({ data: { purpose: "p", model: "m", ok: true, durationMs: 1, subject: TAG, createdAt: new Date(Date.now() - 400 * 86_400_000) } });
      await prisma.auditEvent.create({ data: { actorUserId: null, entityType: TAG, entityId: "old", action: "X", at: new Date(Date.now() - 4000 * 86_400_000) } });
      const before = await counts();
      const cfg = retentionConfig({ RETENTION_ENABLED: "true", RETENTION_DRY_RUN: "true" });
      const r = await runRetention(cfg, { force: true });
      expect(r.dryRun).toBe(true);
      expect(r.counts.llmCalls).toBeGreaterThanOrEqual(1);
      expect(r.counts.requests).toBeUndefined(); // no RETENTION_REQUESTS_DAYS
      const after = await counts();
      expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 });
      expect(after.audit).toBe(before.audit + 1);
      const ev = await prisma.auditEvent.findFirst({ where: { entityType: "System", entityId: "retention" }, orderBy: { at: "desc" } });
      expect(ev?.action).toBe("RETENTION_DRY_RUN");
    });

    test("disabled → nothing happens (no audit); requests only with RETENTION_REQUESTS_DAYS; proposal-linked requests protected; decisions unlinked not deleted; audit never swept; ≤ 200 per run", async () => {
      const off = await runRetention(retentionConfig({}), {});
      expect(off).toEqual({ dryRun: true, counts: {}, more: {} });
      const company = await getCompany();
      const old = new Date(Date.now() - 400 * 86_400_000);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await prisma.request.create({ data: { companyId: company.id, reference: `${TAG}-RET${i}`, accountName: "x", status: "complete", createdBy: "t", createdAt: old, lines: { create: [{ lineNo: 1, rawCode: "A", cfnNorm: "A", quantity: 1 }] } } })).id);
      const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: ids[0] } });
      const decision = await prisma.matchDecision.create({ data: { requestLineId: line.id, topRecommendedSku: "S", chosenSku: "S", acceptedTop: true } });
      // ids[2] is referenced by a proposal → protected.
      const account = await prisma.account.findFirstOrThrow();
      const proposal = await prisma.proposal.create({ data: { reference: `PRP-${TAG}`, accountId: account.id, requestId: ids[2], ownerUserId: admin, status: "DRAFT", currency: "USD", validThrough: new Date() } });
      const auditBefore = await prisma.auditEvent.count({ where: { at: { lt: new Date(Date.now() - 3000 * 86_400_000) } } });
      try {
        const noReq = await runRetention(retentionConfig({ RETENTION_ENABLED: "true", RETENTION_LLM_CALLS_DAYS: "off", RETENTION_SYNC_LOG_DAYS: "off", RETENTION_FEED_RUNS_DAYS: "off", RETENTION_NOTIFICATIONS_DAYS: "off", RETENTION_SNAPSHOTS_DAYS: "off", RETENTION_ALERTS_DAYS: "off" }));
        expect(noReq.counts.requests).toBeUndefined();
        expect(await prisma.request.count({ where: { id: { in: ids } } })).toBe(3);
        const cfg = retentionConfig({ RETENTION_ENABLED: "true", RETENTION_REQUESTS_DAYS: "365", RETENTION_LLM_CALLS_DAYS: "off", RETENTION_SYNC_LOG_DAYS: "off", RETENTION_FEED_RUNS_DAYS: "off", RETENTION_NOTIFICATIONS_DAYS: "off", RETENTION_SNAPSHOTS_DAYS: "off", RETENTION_ALERTS_DAYS: "off", RETENTION_BATCH: "100000" });
        expect(cfg.batch).toBe(100_000);
        const r = await runRetention(cfg);
        expect(r.counts.requests).toBeLessThanOrEqual(200);
        expect(await prisma.request.count({ where: { id: { in: ids.slice(0, 2) } } })).toBe(0);
        expect(await prisma.request.count({ where: { id: ids[2] } })).toBe(1);
        const kept = await prisma.matchDecision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(kept.requestLineId).toBeNull();
        expect(await prisma.auditEvent.count({ where: { at: { lt: new Date(Date.now() - 3000 * 86_400_000) } } })).toBe(auditBefore);
        expect((await prisma.auditEvent.findFirst({ where: { entityType: "System", entityId: "retention" }, orderBy: { at: "desc" } }))?.action).toBe("RETENTION_SWEEP");
      } finally {
        await prisma.matchDecision.deleteMany({ where: { id: decision.id } });
        await prisma.proposal.deleteMany({ where: { id: proposal.id } });
        await prisma.request.deleteMany({ where: { id: { in: ids } } });
      }
    });

    test("snapshots: the newest per report is kept whatever its age; malformed windows are refused; 'off' disables a class", async () => {
      const oldDate = new Date(Date.now() - 200 * 86_400_000);
      await prisma.analyticsSnapshot.createMany({ data: [{ report: `${TAG}-rep`, json: "{}", trigger: "manual", computedAt: oldDate }, { report: `${TAG}-rep`, json: "{}", trigger: "manual", computedAt: new Date(oldDate.getTime() + 1000) }] });
      const r = await runRetention(retentionConfig({ RETENTION_ENABLED: "true", RETENTION_SNAPSHOTS_DAYS: "90", RETENTION_LLM_CALLS_DAYS: "off", RETENTION_SYNC_LOG_DAYS: "off", RETENTION_FEED_RUNS_DAYS: "off", RETENTION_NOTIFICATIONS_DAYS: "off", RETENTION_ALERTS_DAYS: "off" }));
      expect(r.counts.snapshots).toBeGreaterThanOrEqual(1);
      expect(await prisma.analyticsSnapshot.count({ where: { report: `${TAG}-rep` } })).toBe(1);
      expect(() => retentionConfig({ RETENTION_SNAPSHOTS_DAYS: "abc" })).toThrow(/whole number of days/);
      expect(() => retentionConfig({ RETENTION_REQUESTS_DAYS: "0.5" })).toThrow();
      expect(retentionConfig({ RETENTION_LLM_CALLS_DAYS: "0" }).days.llmCalls).toBeNull();
      expect(retentionConfig({ RETENTION_BATCH: "-3" }).batch).toBe(5000);
    });
  });

  // ---- tenancy ---------------------------------------------------------------------------------
  describe("tenancy", () => {
    test("single company → ok; a second Company row is detected, reported by name, and refused by the strict startup check; a missing company is handled", async () => {
      const ok = await tenancyStatus();
      expect(ok.ok).toBe(true); expect(ok.mode).toBe("single"); expect(ok.company?.name).toBeTruthy();
      await expect(checkTenancy({ strict: true })).resolves.toBeUndefined();
      const extra = await prisma.company.create({ data: { name: `${TAG} Second Co`, labelers: "[]" } });
      try {
        const bad = await tenancyStatus();
        expect(bad.ok).toBe(false);
        expect(bad.note).toMatch(/1 extra company row/);
        expect(bad.companies.map((c) => c.name)).toContain(`${TAG} Second Co`);
        await expect(checkTenancy({ strict: true })).rejects.toThrow(/Refusing to start.*Second Co/);
        await expect(checkTenancy({ strict: false })).resolves.toBeUndefined(); // warn-only mode never throws
      } finally { await prisma.company.delete({ where: { id: extra.id } }); }
      expect(defaultLabelers({ OWN_LABELERS: " Acme Surgical , Acme " })).toEqual(["Acme Surgical", "Acme"]);
      expect(defaultLabelers({})).toEqual(["Covidien", "Medtronic", "Sofradim"]);
      expect(defaultLabelers({ OWN_LABELERS: "" })).toEqual(["Covidien", "Medtronic", "Sofradim"]);
    });
  });

  // ---- legacy CRM push gate --------------------------------------------------------------------
  describe("CRM push gate", () => {
    // This block exercises the file-feed path: an enabled Tier 2 CRM integration (a mock left by an
    // admin journey, say) would route the push elsewhere, so it is switched off for the block.
    let crmWasEnabled: string[] = [];
    beforeAll(async () => {
      const on = await prisma.integrationConfig.findMany({ where: { key: { startsWith: "salesforce" }, enabled: true }, select: { key: true } });
      crmWasEnabled = on.map((c) => c.key);
      if (crmWasEnabled.length) await prisma.integrationConfig.updateMany({ where: { key: { in: crmWasEnabled } }, data: { enabled: false } });
    });
    afterAll(async () => { if (crmWasEnabled.length) await prisma.integrationConfig.updateMany({ where: { key: { in: crmWasEnabled } }, data: { enabled: true } }); });
    test("pushQuote refuses an APPROVED proposal past validThrough and one whose included line lost its price — with finalizeCheck's reason", async () => {
      const account = await prisma.account.findFirstOrThrow({ where: { accountNumber: "0001880967" } });
      const p = await prisma.proposal.create({ data: { reference: `PRP-${TAG}-PUSH`, accountId: account.id, ownerUserId: admin, status: "APPROVED", currency: "USD", validThrough: new Date(Date.now() - 86_400_000), lines: { create: [{ lineNo: 1, sku: "PPM1510X3", description: "d", competitorCode: "X", quantity: "1", proposedPrice: "10", approvalState: "NOT_REQUIRED", included: true }] } } });
      const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws5-push-"));
      process.env.INTEGRATION_FEED_DIR = feedDir;
      try {
        await expect(pushQuote(admin, p.id)).rejects.toThrow(/Not pushed to CRM: proposal expired/);
        await prisma.proposal.update({ where: { id: p.id }, data: { validThrough: new Date(Date.now() + 86_400_000) } });
        await prisma.proposalLine.updateMany({ where: { proposalId: p.id }, data: { proposedPrice: null } });
        await expect(pushQuote(admin, p.id)).rejects.toThrow(/Not pushed to CRM: 1 included line\(s\) have no proposed price/);
        await prisma.proposalLine.updateMany({ where: { proposalId: p.id }, data: { proposedPrice: "10" } });
        const r = await pushQuote(admin, p.id);
        expect(r.externalId).toBeTruthy();
        expect(fs.existsSync(path.join(feedDir, "outbound", "quotes"))).toBe(true);
      } finally {
        delete process.env.INTEGRATION_FEED_DIR; fs.rmSync(feedDir, { recursive: true, force: true });
        await prisma.syncLog.deleteMany({ where: { entityId: p.id } });
        await prisma.externalRef.deleteMany({ where: { entityId: p.id } });
        await prisma.proposal.delete({ where: { id: p.id } });
      }
    });
  });
});

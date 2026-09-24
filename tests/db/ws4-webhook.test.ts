/**
 * WS4 — KN-01 handler side: POST /api/webhooks/salesforce called in-process with no session.
 * The proxy half (the open-list entry) is pinned in tests/unit/ws4-proxy.test.ts; the real-HTTP
 * proof through `next dev -p 3104` is in evidence/ws4/http-*.txt.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { setActorForTests } from "../setup";
import { saveIntegration } from "@/lib/integrations/core/admin";
import { POST } from "@/app/api/webhooks/salesforce/route";
import { SIGNATURE_HEADER } from "@/lib/integrations/salesforce/webhook";

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `ws4wh${Date.now().toString(36)}`;
const SECRET = `wh-${RUN}-secret`;
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const post = (body: string, headers: Record<string, string> = {}) => POST(new Request("http://localhost:3104/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
const event = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ eventId: `${RUN}-evt-${n}`, type: "account.changed", accountIds: ["001MOCK0000000003"], ...extra });

describe.skipIf(!hasDb)("WS4 — Salesforce webhook handler (HMAC is the only credential)", () => {
  let adminId = "";
  beforeAll(async () => {
    setActorForTests(null); // no session at all: the endpoint must not need one
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: "admin@crosswalk.dev" } })).id;
    await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, secrets: { webhookSecret: SECRET } }, adminId);
  });
  afterAll(async () => {
    await prisma.integrationInboundEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
    await prisma.integrationSyncJob.deleteMany({ where: { integrationKey: "salesforce", trigger: "webhook", startedAt: { gte: new Date(Date.now() - 600_000) } } }).catch(() => undefined);
    await saveIntegration("salesforce", { provider: "mock", enabled: false, config: { scenario: "ok" }, secrets: { webhookSecret: "" } }, adminId).catch(() => undefined);
    await prisma.account.deleteMany({ where: { externalCrmId: { startsWith: "001MOCK" } } }).catch(() => undefined);
  });

  test("a validly signed event is accepted and applied (2xx with a job id); the same event again is deduplicated", async () => {
    const body = event(1);
    const ok = await post(body, { [SIGNATURE_HEADER]: sign(body) });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j).toMatchObject({ ok: true, applied: 1 });
    expect(typeof j.jobId).toBe("string");
    const dup = await post(body, { [SIGNATURE_HEADER]: sign(body) });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await prisma.integrationInboundEvent.count({ where: { eventId: `${RUN}-evt-1` } })).toBe(1);
  });

  test("an invalid, missing, wrong-secret, prefixed, base64 or length-shifted signature is 401 and records nothing", async () => {
    const body = event(2);
    for (const sig of ["deadbeef", "", sign(body, "other-secret"), "sha256=" + sign(body), Buffer.from(sign(body), "hex").toString("base64"), sign(body) + "0", sign(body).slice(1)]) {
      const r = await post(body, sig ? { [SIGNATURE_HEADER]: sig } : {});
      expect(r.status, `sig=${sig.slice(0, 12)}`).toBe(401);
    }
    // a signature over a different body (replayed header on a tampered payload)
    const tampered = event(2, { accountIds: ["001MOCK0000000004"] });
    expect((await post(tampered, { [SIGNATURE_HEADER]: sign(body) })).status).toBe(401);
    expect(await prisma.integrationInboundEvent.count({ where: { eventId: `${RUN}-evt-2` } })).toBe(0);
  });

  test("a signed but malformed body is 400; a signed body with no account ids is accepted and ignored (202)", async () => {
    expect((await post("{", { [SIGNATURE_HEADER]: sign("{") })).status).toBe(400);
    const noType = JSON.stringify({ eventId: `${RUN}-evt-3` });
    expect((await post(noType, { [SIGNATURE_HEADER]: sign(noType) })).status).toBe(400);
    const empty = event(4, { accountIds: [] });
    const r = await post(empty, { [SIGNATURE_HEADER]: sign(empty) });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, ignored: true });
    const evil = event(5, { accountIds: ["../../etc/passwd", "001MOCK0000000003; DROP TABLE", 42] });
    const r2 = await post(evil, { [SIGNATURE_HEADER]: sign(evil) });
    expect(r2.status).toBe(202); // every id failed the shape check → nothing to apply
  });

  test("a body over 256 KB is 413 whether declared (content-length) or real; exactly 256 KB is accepted for verification", async () => {
    const big = JSON.stringify({ eventId: `${RUN}-evt-6`, type: "x", pad: "a".repeat(256 * 1024) });
    expect((await post(big, { [SIGNATURE_HEADER]: sign(big) })).status).toBe(413);
    expect((await post("{}", { "content-length": String(1024 * 1024) })).status).toBe(413);
    const edge = JSON.stringify({ eventId: `${RUN}-evt-7`, type: "x", pad: "" });
    const padded = edge.slice(0, -3) + "a".repeat(256 * 1024 - Buffer.byteLength(edge) + 0) + '"}';
    expect(Buffer.byteLength(padded)).toBeLessThanOrEqual(256 * 1024);
    expect((await post(padded, { [SIGNATURE_HEADER]: "00" })).status).toBe(401); // read and verified, not refused for size
    // multi-byte characters count in bytes, not characters
    const utf = JSON.stringify({ eventId: `${RUN}-evt-8`, type: "x", pad: "é".repeat(200 * 1024) }); // 400 KB in UTF-8, ~200k chars
    expect((await post(utf, { [SIGNATURE_HEADER]: sign(utf) })).status).toBe(413);
    expect(await prisma.integrationInboundEvent.count({ where: { eventId: { in: [`${RUN}-evt-6`, `${RUN}-evt-8`] } } })).toBe(0);
  });

  test("no webhook secret configured → 403; integration disabled → 404 — and a valid signature under the old secret no longer works", async () => {
    const body = event(9);
    await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, secrets: { webhookSecret: "" } }, adminId);
    expect((await post(body, { [SIGNATURE_HEADER]: sign(body) })).status).toBe(403);
    await saveIntegration("salesforce", { provider: "mock", enabled: false, config: { scenario: "ok" }, secrets: { webhookSecret: SECRET } }, adminId);
    expect((await post(body, { [SIGNATURE_HEADER]: sign(body) })).status).toBe(404);
    await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, secrets: { webhookSecret: SECRET } }, adminId);
    expect((await post(body, { [SIGNATURE_HEADER]: sign(body) })).status).toBe(200);
  });
});

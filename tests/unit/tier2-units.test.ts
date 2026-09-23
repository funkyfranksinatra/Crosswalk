/**
 * Tier 2 (integration layer) — pure / in-memory tests. No database, no network: every
 * external call goes through an injected fetch. Covers the mapping engine, error
 * classification and redaction, sealed secrets, webhook verification, the field-spec
 * validator, the registry factories, and each provider adapter against fixtures.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { applyMapping, validateMapping, mergeMapping, applyTransform, getPath, parseMappingBundle, type MappingSpec } from "@/lib/integrations/core/mapping";
import { IntegrationError, AuthenticationError, RateLimitError, TimeoutError, ProviderUnavailableError, ValidationError, ConfigurationError, redactMessage, asIntegrationError } from "@/lib/integrations/core/errors";
import { httpJson } from "@/lib/integrations/core/http";
import { seal, open, resolveSecret, redactSecrets } from "@/lib/integrations/core/config";
import { verifyWebhook } from "@/lib/integrations/core/webhooks";
import { validateConfig, normalizeConfig, type FieldSpec } from "@/lib/integrations/core/fields";
import { MOCK_SCENARIOS, parseScenario, mockAllowed } from "@/lib/integrations/core/mock";
import { rowsFromGrid, gridFromCsv, globToRegex } from "@/lib/integrations/core/tabular";
import { INTEGRATIONS, definition, fieldsFor, effectiveMapping, buildCrm, buildErp, buildGpoRoster, buildExtraction, buildFx, buildContractPrices } from "@/lib/integrations/core/registry";
import { ACCOUNT_SPEC, SALESFORCE_DEFAULT_MAPPING, soqlFields, QUOTE_SPEC } from "@/lib/integrations/salesforce/mapping";
import { MockSalesforceAdapter, MOCK_ACCOUNTS } from "@/lib/integrations/salesforce/mock";
import { SalesforceAdapter } from "@/lib/integrations/salesforce/adapter";
import { clearSalesforceTokenCache } from "@/lib/integrations/salesforce/auth";
import { parseEvent } from "@/lib/integrations/salesforce/webhook";
import { SAP_DEFAULT_MAPPING, MATERIAL_SPEC } from "@/lib/integrations/sap/mapping";
import { ODataClient } from "@/lib/integrations/sap/odata";
import { SapAdapter } from "@/lib/integrations/sap/adapter";
import { MockSapAdapter } from "@/lib/integrations/sap/mock";
import { GPO_PROFILES, MEMBERSHIP_SPEC } from "@/lib/integrations/gpo/profiles";
import { FileRosterAdapter } from "@/lib/integrations/gpo/file";
import { ApiRosterAdapter } from "@/lib/integrations/gpo/api";
import { MockGpoRosterAdapter } from "@/lib/integrations/gpo/mock";
import { mapExtractionResponse } from "@/lib/integrations/documents/http";
import { ManualExtractionProvider } from "@/lib/integrations/documents/manual";
import { MockDocumentExtractionProvider } from "@/lib/integrations/documents/mock";
import { MockFxProvider, HttpFxProvider, EcbFxProvider, assertCurrency } from "@/lib/integrations/fx/providers";
import { normalizeUom, CONTRACT_PRICE_SPEC, CONTRACT_PRICE_DEFAULT_MAPPING } from "@/lib/integrations/competitor-contracts/mapping";
import { FileContractPriceAdapter } from "@/lib/integrations/competitor-contracts/file";
import { MockCompetitorContractAdapter } from "@/lib/integrations/competitor-contracts/mock";
import { parseDate } from "@/lib/integrations/competitor-contracts/ingest";
import type { ResolvedConfig } from "@/lib/integrations/core/config";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const cfg = (key: ResolvedConfig["key"], provider: string, config: Record<string, unknown> = {}, secrets: Record<string, string> = {}, mapping = {}): ResolvedConfig => ({ key, provider, enabled: true, config, secrets, mapping, scheduleCron: null, configVersion: 1, status: "CONFIGURED" });

// ---- mapping engine ------------------------------------------------------------------------------

describe("mapping engine", () => {
  const spec: MappingSpec = { entity: "T", fields: [{ name: "id", type: "string", required: true, description: "" }, { name: "amount", type: "money", description: "" }, { name: "when", type: "date", description: "" }, { name: "kind", type: "enum", values: ["A", "B"], description: "" }, { name: "flag", type: "boolean", description: "" }] };
  test("applies sources, transforms, value maps, defaults and constants", () => {
    const { record, issues } = applyMapping<Record<string, unknown>>({ Id: " x1 ", Amt: "$1,234.50", D: "/Date(1735689600000)/", K: "alpha", F: "Yes" }, { id: { source: "Id", transform: "trim" }, amount: { source: "Amt", transform: "money" }, when: { source: "D", transform: "date" }, kind: { source: "K", valueMap: { alpha: "A" }, unmapped: "null" }, flag: { source: "F", transform: "bool" } }, spec);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(record).toMatchObject({ id: "x1", when: "2025-01-01", kind: "A", flag: true }); expect(Number(record.amount)).toBe(1234.5);
    expect(applyMapping<Record<string, unknown>>({}, { id: { constant: "fixed" }, kind: { source: "K", default: "B" } }, spec).record).toMatchObject({ id: "fixed", kind: "B" });
  });
  test("required fields missing and enum violations are errors; unknown value maps follow `unmapped`", () => {
    const r = applyMapping<Record<string, unknown>>({ K: "zeta" }, { id: { source: "Id" }, kind: { source: "K", valueMap: { alpha: "A" }, unmapped: "error" } }, spec);
    expect(r.issues.some((i) => i.field === "id" && i.level === "error")).toBe(true);
    expect(r.issues.some((i) => i.field === "kind" && i.level === "error")).toBe(true);
    const bad = applyMapping<Record<string, unknown>>({ Id: "1", K: "Z" }, { id: { source: "Id" }, kind: { source: "K" } }, spec);
    expect(bad.issues.some((i) => i.field === "kind")).toBe(true);
  });
  test("validateMapping reports unmapped required fields, unknown canonical fields and fields the provider lacks", () => {
    const issues = validateMapping({ kind: { source: "K" }, bogus: { source: "X" } }, spec, ["K", "Id"]);
    expect(issues.find((i) => i.field === "id")?.level).toBe("error");
    expect(issues.some((i) => i.field === "bogus")).toBe(true);
    expect(validateMapping({ id: { source: "Nope" } }, spec, ["Id"]).some((i) => i.field === "id" && /not.*(exist|found|provider)/i.test(i.message))).toBe(true);
  });
  test("mergeMapping overlays overrides on defaults; transforms handle the common shapes", () => {
    const m = mergeMapping({ a: { source: "A" }, b: { source: "B" } }, { b: { source: "B2" }, c: { constant: "c" } });
    expect(m).toEqual({ a: { source: "A" }, b: { source: "B2" }, c: { constant: "c" } });
    expect(applyTransform("20260115", "date")).toBe("2026-01-15");
    expect(applyTransform("1/15/2026", "date")).toBe("2026-01-15");
    expect(applyTransform(45000, "date")).toBe("2023-03-15"); // Excel serial
    expect(applyTransform("a; b", "split", ";")).toEqual(["a", "b"]);
    expect(applyTransform("(555) 123-4567", "digits")).toBe("5551234567");
    expect(getPath({ a: { b: [{ c: 1 }] } }, "a.b.0.c")).toBe(1);
    expect(parseMappingBundle("not json")).toEqual({});
  });
});

// ---- errors, http, redaction ---------------------------------------------------------------------

describe("errors and HTTP policy", () => {
  test("redactMessage strips tokens, passwords, keys and URL credentials", () => {
    const m = redactMessage("Authorization: Bearer abc.def.ghi failed for https://user:p%40ss@host/x?api_key=SECRET123 password=hunter2 -----BEGIN PRIVATE KEY----- zzz -----END PRIVATE KEY-----");
    expect(m).not.toMatch(/abc\.def|p%40ss|SECRET123|hunter2|zzz/);
    expect(m).toMatch(/host/);
  });
  test("asIntegrationError classifies unknown errors and keeps ours", () => {
    expect(asIntegrationError(new Error("boom")).category).toBe("UNKNOWN");
    expect(asIntegrationError(new Error("x"), "VALIDATION").category).toBe("VALIDATION");
    expect(asIntegrationError(new AuthenticationError("no")).category).toBe("AUTHENTICATION");
    const e = new RateLimitError("slow", 1000);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(1000);
  });
  test("httpJson maps statuses to error classes, retries 5xx and 429, honours timeouts", async () => {
    const seq = (responses: (() => Response)[]) => { let i = 0; return (async () => responses[Math.min(i++, responses.length - 1)]()) as unknown as typeof fetch; };
    await expect(httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({ error: "bad token" }, 401)]), retries: 0 })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({}, 403)]), retries: 0 })).rejects.toMatchObject({ category: "AUTHORIZATION" });
    await expect(httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({}, 429, { "retry-after": "0" }), () => json({}, 429, { "retry-after": "0" })]), retries: 1 })).rejects.toBeInstanceOf(RateLimitError);
    const ok = await httpJson<{ v: number }>("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({}, 503), () => json({ v: 1 })]), retries: 1 });
    expect(ok.body.v).toBe(1); expect(ok.attempts).toBe(2);
    await expect(httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({}, 500)]), retries: 0 })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({ message: "field x invalid" }, 400)]), retries: 0 })).rejects.toBeInstanceOf(ValidationError);
    const nf = await httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: seq([() => json({}, 404)]), retries: 0, notFoundOk: true });
    expect(nf.status).toBe(404);
    const hang = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); })) as unknown as typeof fetch;
    await expect(httpJson("https://x/a", {}, { provider: "t", operation: "op", fetchImpl: hang, timeoutMs: 30, retries: 0 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

// ---- config sealing, secrets, field specs ---------------------------------------------------------

describe("configuration and secrets", () => {
  test("seal/open round-trips and every ciphertext differs; tampering fails", () => {
    const a = seal({ clientSecret: "s3cret", token: "t" });
    const b = seal({ clientSecret: "s3cret", token: "t" });
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/s3cret/);
    expect(open(a)).toEqual({ clientSecret: "s3cret", token: "t" });
    expect(() => open(a.slice(0, -4) + "AAAA")).toThrow();
    expect(open(null)).toEqual({});
  });
  test("env:NAME references resolve from the environment; missing ones are configuration errors", () => {
    process.env.T2_TEST_SECRET = "from-env";
    expect(resolveSecret("env:T2_TEST_SECRET", "clientSecret")).toBe("from-env");
    expect(resolveSecret("plain", "clientSecret")).toBe("plain");
    expect(() => resolveSecret("env:T2_DOES_NOT_EXIST", "clientSecret")).toThrow(ConfigurationError);
    delete process.env.T2_TEST_SECRET;
  });
  test("redactSecrets masks secret fields anywhere in a structure", () => {
    const r = redactSecrets({ a: { clientSecret: "x", nested: [{ password: "y", ok: "z" }] } }, ["clientSecret", "password"]);
    expect(JSON.stringify(r)).not.toMatch(/"x"|"y"/);
    expect(JSON.stringify(r)).toMatch(/"z"/);
  });
  test("validateConfig enforces required, select options, numbers, urls, json and secret presence", () => {
    const specs: FieldSpec[] = [{ name: "url", label: "u", type: "url", required: true }, { name: "n", label: "n", type: "number" }, { name: "sel", label: "s", type: "select", options: [{ value: "a", label: "a" }] }, { name: "j", label: "j", type: "json" }, { name: "sec", label: "sec", type: "secret", secret: true, required: true }];
    const bad = validateConfig({ url: "not a url", n: "x", sel: "z", j: "{" }, specs, new Set());
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.field).sort()).toEqual(["j", "n", "sec", "sel", "url"]);
    expect(validateConfig({ url: "https://ok.example", n: 5, sel: "a", j: "{}" }, specs, new Set(["sec"])).ok).toBe(true);
    expect(normalizeConfig({ n: "5", sel: "a", extra: "dropped" }, specs)).toEqual({ n: 5, sel: "a" });
  });
  test("mock scenarios parse defensively and mocks are refused in production unless allowed", () => {
    expect(parseScenario("auth-failure")).toBe("auth-failure");
    expect(parseScenario("nope")).toBe("ok");
    expect(MOCK_SCENARIOS).toContain("rate-limit");
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(mockAllowed()).toBe(false);
    process.env.INTEGRATIONS_ALLOW_MOCK = "true";
    expect(mockAllowed()).toBe(true);
    delete process.env.INTEGRATIONS_ALLOW_MOCK;
    (process.env as Record<string, string>).NODE_ENV = env ?? "test";
  });
});

describe("webhook verification", () => {
  const body = JSON.stringify({ eventId: "e1", type: "account.changed", accountIds: ["001000000000001AAA"] });
  test("HMAC signatures verify, wrong or missing signatures are authentication errors", () => {
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(() => verifyWebhook({ mode: "hmac-sha256", secret: "shh", header: "x-sig" }, new Headers({ "x-sig": sig }), body)).not.toThrow();
    expect(() => verifyWebhook({ mode: "hmac-sha256", secret: "shh", header: "x-sig" }, new Headers({ "x-sig": sig }), body + " ")).toThrow(AuthenticationError);
    expect(() => verifyWebhook({ mode: "hmac-sha256", secret: "shh", header: "x-sig" }, new Headers(), body)).toThrow(AuthenticationError);
    expect(() => verifyWebhook({ mode: "shared-secret", secret: "k", header: "x-key" }, new Headers({ "x-key": "k" }), body)).not.toThrow();
    expect(() => verifyWebhook({ mode: "shared-secret", secret: "k", header: "x-key" }, new Headers({ "x-key": "kk" }), body)).toThrow(AuthenticationError);
    expect(() => verifyWebhook({ mode: "basic", username: "u", password: "p" }, new Headers({ authorization: `Basic ${Buffer.from("u:p").toString("base64")}` }), body)).not.toThrow();
  });
  test("event bodies are validated, ids filtered to Salesforce shapes", () => {
    expect(parseEvent(body)).toEqual({ eventId: "e1", type: "account.changed", accountIds: ["001000000000001AAA"], opportunityIds: [] });
    expect(() => parseEvent("{")).toThrow(ValidationError);
    expect(() => parseEvent(JSON.stringify({ type: "x" }))).toThrow(ValidationError);
    expect(parseEvent(JSON.stringify({ eventId: "e", type: "t", accountIds: ["../etc", 5, "001000000000001AAA"] })).accountIds).toEqual(["001000000000001AAA"]);
  });
});

// ---- registry ------------------------------------------------------------------------------------

describe("registry", () => {
  test("every integration declares providers with a mock, secret fields are flagged, mapping specs load", async () => {
    for (const d of Object.values(INTEGRATIONS)) {
      expect(d.providers.some((p) => p.mock)).toBe(true);
      for (const p of d.providers) for (const f of p.fields) if (f.type === "secret" || f.type === "multiline-secret") expect(f.secret).toBe(true);
      const full = await definition(d.key);
      expect(Object.keys(full.mappingSpecs).length).toBeGreaterThan(0);
    }
    expect(fieldsFor(await definition("salesforce"), "salesforce").some((f) => f.name === "clientSecret" && f.secret)).toBe(true);
    expect(() => fieldsFor(INTEGRATIONS.sap, "oracle")).toThrow(ConfigurationError);
  });
  test("no GPO field name is assumed: the Salesforce default mapping leaves gpoName to the company", async () => {
    const d = await definition("salesforce");
    expect(d.defaultMapping.Account.gpoName).toBeUndefined();
    const eff = effectiveMapping(d, { Account: { gpoName: { source: "GPO_Name__c" }, gpoTier: { source: "GPO_Tier__c" } } });
    expect(eff.Account.gpoName).toEqual({ source: "GPO_Name__c" });
    expect(eff.Account.name).toEqual({ source: "Name" });
    expect(soqlFields(eff.Account)).toContain("GPO_Name__c");
  });
  test("factories build every provider from config; live providers refuse to start without their secrets", async () => {
    expect((await buildCrm(cfg("salesforce", "mock", { scenario: "ok" }))).provider).toBe("mock");
    await expect(buildCrm(cfg("salesforce", "salesforce", { clientId: "id", loginUrl: "https://login.salesforce.com" }))).rejects.toThrow(ConfigurationError);
    expect((await buildCrm(cfg("salesforce", "salesforce", { clientId: "id" }, { clientSecret: "s" }))).provider).toBe("salesforce");
    expect((await buildErp(cfg("sap", "mock"))).provider).toBe("mock");
    await expect(buildErp(cfg("sap", "odata", { baseUrl: "https://sap.example/odata", materialsService: "API_PRODUCT_SRV", materialsEntitySet: "A_Product", username: "u" }))).rejects.toThrow(ConfigurationError);
    expect((await buildGpoRoster(cfg("gpo:premier", "mock"))).gpoName).toBe("Premier");
    expect((await buildGpoRoster(cfg("gpo:vizient", "file", { directory: "/tmp/nowhere", pattern: "*.csv" }))).provider).toBe("file");
    await expect(buildGpoRoster(cfg("gpo:vizient", "file", {}))).rejects.toThrow(ConfigurationError);
    expect((await buildGpoRoster(cfg("gpo:healthtrust", "api", { endpoint: "https://api.example/members", authMode: "bearer" }, { token: "t" }))).provider).toBe("api");
    expect((await buildExtraction(cfg("documents", "manual"))).provider).toBe("manual");
    expect((await buildExtraction(cfg("documents", "mock", { lowConfidence: "true" }))).provider).toBe("mock");
    expect((await buildFx(cfg("fx", "ecb"))).provider).toBe("ecb");
    expect((await buildFx(cfg("fx", "manual"))).provider).toBe("manual");
    expect((await buildContractPrices(cfg("competitor-contracts", "mock"))).provider).toBe("mock");
  });
  test("mock providers are refused in production unless INTEGRATIONS_ALLOW_MOCK=true", async () => {
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    await expect(buildCrm(cfg("salesforce", "mock"))).rejects.toThrow(/not allowed in production/);
    process.env.INTEGRATIONS_ALLOW_MOCK = "true";
    expect((await buildCrm(cfg("salesforce", "mock"))).provider).toBe("mock");
    delete process.env.INTEGRATIONS_ALLOW_MOCK;
    (process.env as Record<string, string>).NODE_ENV = env ?? "test";
  });
});

// ---- 2.1 Salesforce ----------------------------------------------------------------------------------

describe("2.1 Salesforce", () => {
  test("default mapping turns an SObject into a canonical account; a company GPO field maps when configured", () => {
    const raw = { Id: "001A", Name: "Mercy", AccountNumber: "0009", ParentId: null, Type: "Hospital", Industry: "Acute", BillingState: "OH", BillingCountryCode: "US", CurrencyIsoCode: "USD", Owner: { Email: "rep@x.example", Territory__c: "Midwest" }, LastModifiedDate: "2026-09-01T00:00:00.000+0000", GPO__c: "Vizient", GPO_Tier__c: "Tier 2" };
    const base = applyMapping<Record<string, unknown>>(raw, SALESFORCE_DEFAULT_MAPPING.Account, ACCOUNT_SPEC).record;
    expect(base).toMatchObject({ externalId: "001A", name: "Mercy", accountNumber: "0009", type: "SOLD_TO", territory: "Midwest", ownerEmail: "rep@x.example", country: "US" });
    expect(base.gpoName).toBeUndefined();
    const withGpo = applyMapping<Record<string, unknown>>(raw, mergeMapping(SALESFORCE_DEFAULT_MAPPING.Account, { gpoName: { source: "GPO__c" }, gpoTier: { source: "GPO_Tier__c" } }), ACCOUNT_SPEC).record;
    expect(withGpo).toMatchObject({ gpoName: "Vizient", gpoTier: "Tier 2" });
    expect(validateMapping(SALESFORCE_DEFAULT_MAPPING.Quote, QUOTE_SPEC).filter((i) => i.level === "error")).toEqual([]);
  });
  test("mock adapter pages with cursors, honours scenarios, and quote write-back is idempotent by key", async () => {
    const m = new MockSalesforceAdapter("ok");
    const p1 = await m.fetchAccounts(); expect(p1.records).toHaveLength(2); expect(p1.nextCursor).toBe("mock:2");
    const p2 = await m.fetchAccounts({ cursor: p1.nextCursor }); expect(p2.records).toHaveLength(1); expect(p2.nextCursor).toBeNull();
    const q = { idempotencyKey: "P1", proposalId: "P1", reference: "PRP-1", accountExternalId: MOCK_ACCOUNTS[1].externalId, status: "APPROVED", proposalStatus: "APPROVED", approvalStatus: "APPROVED", currency: "USD", totalValue: "100", contractValue: "100", customerSavings: null, blendedMarginPct: null, validThrough: null, createdAt: "2026-09-01T00:00:00Z", lines: [{ sku: "A", description: "d", competitorCode: "C", quantity: "1", unitPrice: "100", matchType: null, equivalenceLevel: null, approvalState: "APPROVED" }] };
    const a = await m.createOrUpdateQuote(q); const b = await m.createOrUpdateQuote({ ...q, totalValue: "120" });
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(a.externalId).toBe(b.externalId); expect(m.quotes.size).toBe(1); expect(m.quotes.get("P1")!.writes).toBe(2);
    await expect(new MockSalesforceAdapter("auth-failure").fetchAccounts()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(new MockSalesforceAdapter("rate-limit").fetchAccounts()).rejects.toBeInstanceOf(RateLimitError);
    await expect(new MockSalesforceAdapter("timeout").createOrUpdateQuote(q)).rejects.toBeInstanceOf(TimeoutError);
    await expect(new MockSalesforceAdapter("malformed").fetchOpportunities()).rejects.toBeInstanceOf(ValidationError);
    expect((await new MockSalesforceAdapter("partial").fetchAccounts({ limit: 10 })).records.at(-1)!.name).toBe("");
    expect((await new MockSalesforceAdapter("duplicate").fetchAccounts({ limit: 10 })).records).toHaveLength(4);
  });
  test("real adapter: token flow, SOQL with the mapped fields, queryMore cursors, upsert by external id, 401 re-auth, REQUEST_LIMIT_EXCEEDED → rate limit", async () => {
    clearSalesforceTokenCache();
    const calls: { url: string; method: string; body?: string; auth?: string | null }[] = [];
    let tokens = 0; let firstQuery = true; let limitHit = false;
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u); const h = new Headers(init?.headers); calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, auth: h.get("authorization") });
      if (url.endsWith("/services/oauth2/token")) { tokens++; return json({ access_token: `tok${tokens}`, instance_url: "https://inst.example" }); }
      if (url.includes("/query?q=") || url.includes("/query/?q=")) {
        if (firstQuery) { firstQuery = false; return json({ totalSize: 3, done: false, nextRecordsUrl: "/services/data/v60.0/query/01gNEXT-2000", records: [{ Id: "001A", Name: "A", Type: "Hospital", Owner: { Email: "o@x" }, LastModifiedDate: "2026-09-01T00:00:00.000+0000", GPO__c: "Premier" }] }); }
        return json({ done: true, records: [] });
      }
      if (url.includes("/query/01gNEXT")) return json({ done: true, records: [{ Id: "001B", Name: "B", Owner: null, LastModifiedDate: "2026-09-02T00:00:00.000+0000" }] });
      if (url.includes("/sobjects/Account/describe")) return json({ fields: [{ name: "Id" }, { name: "Name" }, { name: "GPO__c" }, { name: "OwnerId", relationshipName: "Owner" }] });
      if (url.includes("/describe")) return json({ fields: [{ name: "Id" }, { name: "Name" }, { name: "Crosswalk_Proposal_Id__c" }] });
      if (url.includes("/sobjects/Crosswalk_Quote__c/Crosswalk_Proposal_Id__c/")) { if (h.get("authorization") === "Bearer tok1" && calls.filter((c) => c.url.includes("Crosswalk_Proposal_Id__c")).length === 1) return json([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }], 401); return json({ id: "a0Q1", success: true }, 201); }
      if (url.includes("/composite/sobjects")) return json([{ id: "a0R1", success: true }, { id: "a0R2", success: true }]);
      if (url.includes("/limits")) return limitHit ? json([{ message: "TotalRequests Limit exceeded.", errorCode: "REQUEST_LIMIT_EXCEEDED" }], 403) : json({ DailyApiRequests: { Max: 100000, Remaining: 99000 } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const sf = new SalesforceAdapter({ auth: { flow: "client-credentials", loginUrl: "https://login.example", clientId: "id", clientSecret: "sec" }, apiVersion: "v60.0", mapping: { Account: { gpoName: { source: "GPO__c" } } }, quoteObject: "Crosswalk_Quote__c", quoteLineObject: "Crosswalk_Quote_Line__c", fetchImpl: f });
    const p1 = await sf.fetchAccounts({ since: new Date("2026-08-01T00:00:00Z") });
    expect(p1.records[0]).toMatchObject({ externalId: "001A", name: "A", type: "SOLD_TO", gpoName: "Premier", ownerEmail: "o@x" });
    expect(p1.records[0].provenance).toMatchObject({ provider: "salesforce", sourceRecordId: "001A" });
    expect(p1.nextCursor).toMatch(/^more:/);
    const soql = decodeURIComponent(calls.find((c) => c.url.includes("/query"))!.url);
    expect(soql).toMatch(/GPO__c/); expect(soql).toMatch(/LastModifiedDate > 2026-08-01/); expect(soql).not.toMatch(/sec/);
    const p2 = await sf.fetchAccounts({ cursor: p1.nextCursor }); expect(p2.records[0].externalId).toBe("001B"); expect(p2.nextCursor).toBeNull();
    const q = await sf.createOrUpdateQuote({ idempotencyKey: "P9", proposalId: "P9", reference: "PRP-9", accountExternalId: "001000000000001AAA", status: "APPROVED", proposalStatus: "APPROVED", approvalStatus: "APPROVED", currency: "USD", totalValue: "10", contractValue: "10", customerSavings: "1", blendedMarginPct: null, validThrough: null, createdAt: "2026-09-01T00:00:00Z", lines: [{ sku: "S", description: null, competitorCode: "C", quantity: "1", unitPrice: "10", matchType: null, equivalenceLevel: null, approvalState: "APPROVED" }, { sku: "S2", description: null, competitorCode: "C2", quantity: "2", unitPrice: "5", matchType: null, equivalenceLevel: null, approvalState: "APPROVED" }] });
    expect(q).toMatchObject({ externalId: "a0Q1", created: true });
    expect(tokens).toBe(2); // re-authenticated once after the 401
    const upsert = calls.find((c) => c.url.includes("/Crosswalk_Proposal_Id__c/P9") && c.method === "PATCH" && c.auth === "Bearer tok2")!;
    expect(upsert).toBeTruthy();
    expect(JSON.parse(upsert.body!)).toMatchObject({ Account__c: "001000000000001AAA", Total_Value__c: 10 }); expect(JSON.parse(upsert.body!).Name).toMatch(/PRP-9/);
    expect(JSON.parse(upsert.body!).Margin_Pct__c).toBeUndefined();
    const lines = calls.find((c) => c.url.includes("/composite/sobjects"))!;
    expect(JSON.parse(lines.body!).records.map((r: { Crosswalk_Line_Id__c: string }) => r.Crosswalk_Line_Id__c)).toEqual(["P9-1", "P9-2"]);
    const client = (sf as unknown as { client: { limits: () => Promise<unknown> } }).client;
    const t = await sf.testConnection(); // the org lacks most mapped fields: the test connects but reports exactly what does not fit
    expect(t.ok).toBe(false); expect(t.message).toMatch(/Account\.accountNumber → "AccountNumber" does not exist/); expect(t.details?.Account).toMatch(/fields$/);
    limitHit = true;
    await expect(client.limits()).rejects.toBeInstanceOf(RateLimitError);
    expect(JSON.stringify(calls)).not.toMatch(/"sec"/); // the secret only ever travels in the token request body
    expect(calls.filter((c) => c.body?.includes("client_secret=sec")).every((c) => c.url.endsWith("/token"))).toBe(true);
  });
});

// ---- 2.2 SAP ----------------------------------------------------------------------------------------------

describe("2.2 SAP", () => {
  test("OData client normalises v2 and v4 payloads and pages through next links", async () => {
    const f = (async (u: string | URL) => {
      const url = String(u);
      if (url.includes("v2/A_Product") && !url.includes("skiptoken")) return json({ d: { results: [{ Product: "M1", ProductDescription: "One", LastChangeDateTime: "/Date(1756684800000)/" }], __next: "https://sap.example/sap/opu/odata/sap/v2/A_Product?$skiptoken=1" } });
      if (url.includes("skiptoken")) return json({ d: { results: [{ Product: "M2", ProductDescription: "Two" }] } });
      if (url.includes("v4/A_Product")) return json({ value: [{ Product: "M3" }], "@odata.nextLink": "A_Product?$skip=1" });
      if (url.includes("$skip=1")) return json({ value: [] });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const v2 = new ODataClient({ baseUrl: "https://sap.example/sap/opu/odata/sap", version: "v2", auth: { mode: "basic", username: "u", password: "p" }, fetchImpl: f });
    const p1 = await v2.get("v2/A_Product", { $top: "1" }, "materials");
    expect(p1.records).toHaveLength(1); expect(p1.next).toMatch(/skiptoken/);
    const p2 = await v2.get(p1.next!, {}, "materials"); expect(p2.records[0]).toMatchObject({ Product: "M2" }); expect(p2.next).toBeNull();
    const v4 = new ODataClient({ baseUrl: "https://sap.example/sap/opu/odata4/sap", version: "v4", auth: { mode: "basic", username: "u", password: "p" }, fetchImpl: f });
    const q1 = await v4.get("v4/A_Product", {}, "materials"); expect(q1.records).toHaveLength(1); expect(q1.next).toMatch(/skip=1/);
    expect(applyMapping<Record<string, unknown>>(p1.records[0], SAP_DEFAULT_MAPPING.Material, MATERIAL_SPEC).record).toMatchObject({ sku: "M1", description: "One", sourceUpdatedAt: "2025-09-01T00:00:00.000Z" });
  });
  test("adapter pulls materials, costs (÷ price unit, plant → region), list-price conditions (filtered by type) and billing with cursors", async () => {
    const f = (async (u: string | URL) => {
      const url = decodeURIComponent(String(u));
      if (url.includes("A_Product?") || url.endsWith("A_Product")) return json({ d: { results: [{ Product: "P1", ProductDescription: "Stapler", ProductGroup: "ENDO", BaseUnit: "EA", IsMarkedForDeletion: false, LastChangeDateTime: "/Date(1756684800000)/" }, { Product: "P2", ProductDescription: "Reload", ProductGroup: "ENDO", BaseUnit: "EA", IsMarkedForDeletion: true }] } });
      if (url.includes("A_ProductValuation")) return json({ d: { results: [{ Product: "P1", ValuationArea: "1000", StandardPrice: "1462.50", PriceUnitQty: "10", Currency: "USD", ValidityStartDate: "/Date(1735689600000)/" }] } });
      if (url.includes("A_SlsPrcgConditionRecord")) return json({ d: { results: [{ ConditionRecord: "C1", ConditionType: "PR00", Material: "P1", ConditionRateValue: "412.00", ConditionCurrency: "USD", ConditionValidityStartDate: "/Date(1735689600000)/", ConditionValidityEndDate: null, SalesOrganization: "1000" }, { ConditionRecord: "C2", ConditionType: "K007", Material: "P1", ConditionRateValue: "5", ConditionCurrency: "USD", ConditionValidityStartDate: "/Date(1735689600000)/" }] } });
      if (url.includes("A_BillingDocumentItem")) return json({ d: { results: [{ BillingDocument: "90001", BillingDocumentItem: "10", SoldToParty: "0000123", Material: "P1", BillingQuantity: "4", NetAmount: "1600.00", TransactionCurrency: "USD", BillingDocumentDate: "/Date(1755129600000)/", ReferenceSDDocument: "" }] } });
      if (url.includes("$metadata") || url.includes("$top=1")) return json({ d: { results: [] } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const sap = new SapAdapter({ odata: { baseUrl: "https://sap.example/sap/opu/odata/sap", version: "v2", auth: { mode: "basic", username: "u", password: "p" }, fetchImpl: f }, services: { materials: { service: "API_PRODUCT_SRV", entitySet: "A_Product", changeDateField: "LastChangeDateTime" }, costs: { service: "API_PRODUCT_SRV", entitySet: "A_ProductValuation" }, prices: { service: "API_SLSPRICINGCONDITIONRECORD_SRV", entitySet: "A_SlsPrcgConditionRecord" }, billing: { service: "API_BILLING_DOCUMENT_SRV", entitySet: "A_BillingDocumentItem" } }, plantRegions: { "1000": "US" }, listConditionTypes: ["PR00"], mapping: {} });
    const m = await sap.fetchMaterials(); expect(m.records.map((r) => [r.sku, r.discontinued])).toEqual([["P1", false], ["P2", true]]);
    const c = await sap.fetchStandardCosts(); expect(c.records[0]).toMatchObject({ sku: "P1", plant: "1000", region: "US", currency: "USD", effectiveFrom: "2025-01-01" }); expect(Number(c.records[0].cost)).toBeCloseTo(146.25, 4);
    const p = await sap.fetchListPrices(); expect(p.records).toHaveLength(1); expect(p.records[0]).toMatchObject({ sku: "P1", conditionType: "PR00" }); expect(Number(p.records[0].price)).toBe(412);
    const b = await sap.fetchBillingDocuments(); expect(b.records[0]).toMatchObject({ externalId: "90001-10", accountNumber: "0000123", sku: "P1", quantity: "4", invoiceDate: "2025-08-14" }); expect(Number(b.records[0].netPrice)).toBeCloseTo(400, 4);
  });
  test("mock SAP scenarios: partial, duplicate, auth failure, unavailable", async () => {
    expect((await new MockSapAdapter("ok").fetchMaterials({ limit: 10 })).records).toHaveLength(3);
    expect((await new MockSapAdapter("duplicate").fetchStandardCosts({ limit: 10 })).records.length).toBeGreaterThan(3);
    await expect(new MockSapAdapter("auth-failure").fetchMaterials()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(new MockSapAdapter("unavailable").fetchBillingDocuments()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(new MockSapAdapter("timeout").testConnection()).rejects.toBeInstanceOf(TimeoutError);
  });
});

// ---- 2.3 GPO rosters -------------------------------------------------------------------------------------

describe("2.3 GPO rosters", () => {
  test("file adapter maps a Premier-shaped CSV through the profile mapping with company overrides", async () => {
    const csv = "Premier Entity Code,Facility Name,Supplier Customer Number,Tier,Effective Date,Expiration Date,State\nPE-1,Mercy Hospital,0009,Tier 2,1/1/2026,,OH\nPE-2,No Number Clinic,,Tier 1,2026-02-01,2026-12-31,MT\nPE-3,Broken,0010,Tier 1,not a date,,";
    const a = new FileRosterAdapter({ profile: GPO_PROFILES.premier, source: { kind: "upload", filename: "roster.csv", buffer: Buffer.from(csv) }, mapping: { region: { source: "State" } } });
    const p = await a.fetchMemberships();
    expect(p.records).toHaveLength(2);
    expect(p.rejected).toHaveLength(1); expect(p.rejected![0].message).toMatch(/row 4/); // the bad date is reported, not dropped, and does not stop the file
    expect(p.records[0]).toMatchObject({ gpoName: "Premier", externalMembershipId: "PE-1", memberName: "Mercy Hospital", accountNumber: "0009", tier: "Tier 2", effectiveFrom: "2026-01-01", address: { region: "OH" } });
    expect(p.records[0].provenance).toMatchObject({ provider: "file", sourceSystem: "premier", meta: { file: "roster.csv" } });
    expect(p.nextCursor).toBeNull();
    expect((await a.testConnection()).ok).toBe(true);
    expect(validateMapping(GPO_PROFILES.vizient.fileMapping, MEMBERSHIP_SPEC).filter((i) => i.level === "error")).toEqual([]);
  });
  test("API adapter pages with next links and page numbers, sends the incremental parameter, maps records", async () => {
    const seen: string[] = [];
    const f = (async (u: string | URL, init?: RequestInit) => { const url = String(u); seen.push(url); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer T"); if (url.includes("page=2")) return json({ data: { members: [{ id: "m2", name: "Two", start: "2026-01-01" }] }, links: {} }); return json({ data: { members: [{ id: "m1", name: "One", start: "2026-01-01", account: "0001" }] }, links: { next: "https://api.example/members?page=2" } }); }) as unknown as typeof fetch;
    const a = new ApiRosterAdapter({ profile: GPO_PROFILES.vizient, endpoint: "https://api.example/members", auth: { mode: "bearer", token: "T" }, recordsPath: "data.members", paging: { mode: "next-link", path: "links.next" }, sinceParam: "updated_since", mapping: { externalMembershipId: { source: "id" }, memberName: { source: "name" }, accountNumber: { source: "account" }, effectiveFrom: { source: "start", transform: "date" } }, fetchImpl: f });
    const p1 = await a.fetchMemberships({ since: new Date("2026-08-01T00:00:00Z") });
    expect(p1.records[0]).toMatchObject({ externalMembershipId: "m1", memberName: "One", accountNumber: "0001", gpoName: "Vizient" });
    expect(seen[0]).toMatch(/updated_since=2026-08-01/);
    const p2 = await a.fetchMemberships({ cursor: p1.nextCursor }); expect(p2.records[0].externalMembershipId).toBe("m2"); expect(p2.nextCursor).toBeNull();
  });
  test("mock roster scenarios", async () => {
    const m = new MockGpoRosterAdapter(GPO_PROFILES.healthtrust, "ok");
    expect((await m.fetchMemberships()).records.map((r) => r.memberName)).toContain("Pine Ridge Community Hospital");
    await expect(new MockGpoRosterAdapter(GPO_PROFILES.premier, "auth-failure").fetchMemberships()).rejects.toBeInstanceOf(AuthenticationError);
    expect((await new MockGpoRosterAdapter(GPO_PROFILES.premier, "empty").fetchMemberships()).records).toEqual([]);
  });
});

// ---- 2.4 Documents ------------------------------------------------------------------------------------

describe("2.4 Document extraction", () => {
  const response = { linesPath: "result.items", lineFields: { competitorSku: "sku", description: "desc", quantity: "qty", unitPrice: "price" }, lineConfidencePath: "conf", fieldConfidenceSuffix: "_c", headerFields: { vendorName: "result.vendor", documentNumber: "result.number" }, overallPath: "result.confidence", pagePath: "page" } as const;
  test("maps a vendor response into fields with per-field / per-line confidence and pages", () => {
    const out = mapExtractionResponse({ result: { vendor: "Covidien", number: "INV-1", confidence: 0.93, items: [{ sku: "1DLMC05", sku_c: 0.99, desc: "Mesh", qty: "12", price: "$412.50", conf: 0.9, page: 2 }, { sku: "", desc: "?", qty: "1", price: "x", conf: 0.3, page: 2 }] } }, response, "INVOICE", "http", "m1");
    expect(out.overallConfidence).toBeCloseTo(0.93);
    const sku = out.fields.find((f) => f.scope === "LINE" && f.lineNo === 1 && f.field === "competitorSku")!;
    expect(sku).toMatchObject({ normalizedValue: "1DLMC05", confidence: 0.99, page: 2 });
    expect(Number(out.fields.find((f) => f.lineNo === 1 && f.field === "unitPrice")!.normalizedValue)).toBe(412.5);
    expect(out.fields.find((f) => f.lineNo === 1 && f.field === "description")!.confidence).toBeCloseTo(0.9);
    expect(out.fields.find((f) => f.scope === "HEADER" && f.field === "vendorName")!.normalizedValue).toBe("Covidien");
    expect(out.fields.filter((f) => f.lineNo === 2 && f.field === "competitorSku")).toHaveLength(0); // empty values are not fields
  });
  test("malformed responses are validation errors; the manual provider reads a grid; the mock covers scenarios", async () => {
    expect(() => mapExtractionResponse({ result: { items: "nope" } }, response, "INVOICE", "http", null)).toThrow(ValidationError);
    expect(() => mapExtractionResponse("<html>", response, "INVOICE", "http", null)).toThrow(ValidationError);
    const manual = new ManualExtractionProvider();
    const out = await manual.extract({ documentId: "d", documentType: "INVOICE", filename: "x.csv", mimeType: "text/csv", bytes: null, grid: [["Catalog Number", "Description", "Qty", "Unit Price"], ["SPMII", "Proceed mesh", "6", "1,085.00"]] });
    expect(out.provider).toBe("manual"); expect(out.overallConfidence).toBe(1);
    expect(out.fields.find((f) => f.field === "competitorSku")!.normalizedValue).toBe("SPMII");
    expect(Number(out.fields.find((f) => f.field === "unitPrice")!.normalizedValue)).toBe(1085);
    const low = await new MockDocumentExtractionProvider("ok", true).extract({ documentId: "d", documentType: "INVOICE", filename: "a.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") });
    expect(low.fields.every((f) => (f.confidence ?? 0) < 0.85)).toBe(true);
    await expect(new MockDocumentExtractionProvider("malformed").extract({ documentId: "d", documentType: "INVOICE", filename: "a.pdf", mimeType: null, bytes: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(new MockDocumentExtractionProvider("unavailable").extract({ documentId: "d", documentType: "INVOICE", filename: "a.pdf", mimeType: null, bytes: null })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

// ---- 2.5 FX ---------------------------------------------------------------------------------------------

describe("2.5 FX providers", () => {
  test("currency codes are validated; the mock has no weekend rates; the HTTP provider refuses a rate for another date", async () => {
    expect(assertCurrency("usd")).toBe("USD");
    expect(() => assertCurrency("US$")).toThrow(ValidationError);
    const m = new MockFxProvider();
    expect((await m.getRate("USD", "EUR", "2026-09-22"))!.rate).toBe("0.92150000"); // Tuesday
    expect(await m.getRate("USD", "EUR", "2026-09-20")).toBeNull(); // Sunday
    expect((await m.getRate("EUR", "GBP", "2026-09-22"))).toBeNull(); // no cross in the table
    const f = (async (u: string | URL) => json({ date: String(u).includes("2026-09-22") ? "2026-09-22" : "2026-09-19", rates: { EUR: 0.9 } })) as unknown as typeof fetch;
    const h = new HttpFxProvider({ endpoint: "https://fx.example/{date}?base={base}", ratePath: "rates.{quote}", datePath: "date", auth: { mode: "none" }, fetchImpl: f });
    expect((await h.getRate("USD", "EUR", "2026-09-22"))!.rate).toBe("0.9");
    expect(await h.getRate("USD", "EUR", "2026-09-21")).toBeNull(); // the service answered with Friday's rate
    await expect(new MockFxProvider("auth-failure").getRate("USD", "EUR", "2026-09-22")).rejects.toBeInstanceOf(AuthenticationError);
  });
  test("ECB provider parses the SDMX CSV and derives crosses through EUR, labelled as such", async () => {
    const csv = (cur: string, v: string) => `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.${cur}.EUR.SP00.A,D,${cur},EUR,SP00,A,2026-09-22,${v}`;
    const f = (async (u: string | URL) => { const url = String(u); const cur = url.includes("D.USD") ? "USD" : url.includes("D.GBP") ? "GBP" : null; return cur ? new Response(csv(cur, cur === "USD" ? "1.0852" : "0.8440"), { status: 200, headers: { "content-type": "text/csv" } }) : new Response("", { status: 404 }); }) as unknown as typeof fetch;
    const ecb = new EcbFxProvider({ fetchImpl: f });
    expect((await ecb.getRate("EUR", "USD", "2026-09-22"))!.rate).toBe("1.0852");
    const cross = (await ecb.getRate("USD", "GBP", "2026-09-22"))!;
    expect(cross.provider).toBe("ecb-cross"); expect(Number(cross.rate)).toBeCloseTo(0.8440 / 1.0852, 6);
    expect(await ecb.getRate("EUR", "JPY", "2026-09-22")).toBeNull();
  });
});

// ---- 2.6 Competitor contract prices ---------------------------------------------------------------------

describe("2.6 Competitor contract prices", () => {
  test("UOM normalisation, dates, file adapter mapping", async () => {
    expect(normalizeUom("Each")).toEqual({ uom: "EA", ambiguous: false });
    expect(normalizeUom("bx.")).toEqual({ uom: "BX", ambiguous: false });
    expect(normalizeUom("bundle")).toEqual({ uom: null, ambiguous: true });
    expect(normalizeUom("bundle", { bundle: "BX" })).toEqual({ uom: "BX", ambiguous: false });
    expect(normalizeUom("")).toEqual({ uom: "EA", ambiguous: false });
    expect(parseDate("2026-01-05")).toEqual(new Date("2026-01-05T00:00:00Z")); expect(parseDate("Jan 5")).toBeNull(); expect(parseDate(null)).toBeNull();
    expect(validateMapping(CONTRACT_PRICE_DEFAULT_MAPPING, CONTRACT_PRICE_SPEC).filter((i) => i.level === "error")).toEqual([]);
    const csv = "GPO,Manufacturer,Catalog Number,Description,Contract Price,UOM,Tier,Effective Date,Expiration Date,Contract Number\nVizient,Covidien,1DLMC05,Mesh,\"$398.00\",EA,Tier 2,1/1/2026,12/31/2026,VZ-1\n,Ethicon,SPMII,Mesh,1085,ea,,2026-01-01,,";
    const a = new FileContractPriceAdapter({ source: { kind: "upload", filename: "prices.csv", buffer: Buffer.from(csv) }, sourceOwner: "Contracting", defaultGpo: "Premier" });
    const p = await a.fetchContractPrices();
    expect(Number(p.records[0].price)).toBe(398);
    expect(p.records[0]).toMatchObject({ gpoName: "Vizient", competitorName: "Covidien", competitorSku: "1DLMC05", uom: "EA", tier: "Tier 2", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", contractRef: "VZ-1", sourceOwner: "Contracting" });
    expect(p.records[1].gpoName).toBe("Premier");
    expect(p.records[1].provenance).toMatchObject({ provider: "file", sourceSystem: "prices.csv" });
    const grid = gridFromCsv("a,b\n1,\"x,y\"\n"); expect(rowsFromGrid(grid).rows[0]).toMatchObject({ a: "1", b: "x,y" });
    expect(globToRegex("roster-*.csv").test("ROSTER-2026.csv")).toBe(true);
  });
  test("mock scenarios: partial adds a row with no price and an unknown unit; duplicate repeats a row", async () => {
    expect((await new MockCompetitorContractAdapter("ok").fetchContractPrices()).records).toHaveLength(3);
    const partial = (await new MockCompetitorContractAdapter("partial").fetchContractPrices()).records;
    expect(partial.at(-1)).toMatchObject({ price: "", uom: "bundle" });
    expect((await new MockCompetitorContractAdapter("duplicate").fetchContractPrices()).records).toHaveLength(4);
    await expect(new MockCompetitorContractAdapter("rate-limit").fetchContractPrices()).rejects.toBeInstanceOf(RateLimitError);
  });
});

// keep NODE_ENV sane even if a test above fails mid-way
let envBefore: string | undefined;
beforeAll(() => { envBefore = process.env.NODE_ENV; });
afterAll(() => { (process.env as Record<string, string | undefined>).NODE_ENV = envBefore; });

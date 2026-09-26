/**
 * WS5 — Salesforce quote write-back at the adapter level with an injected fetch: chunked line
 * upserts (200 per composite call, allOrNone:false), a partial failure inside a chunk is a
 * non-retryable validation error that names the count, and a retry re-upserts by the same
 * idempotency keys (nothing is duplicated). No network.
 */
import { describe, test, expect } from "vitest";
import { SalesforceAdapter } from "@/lib/integrations/salesforce/adapter";
import { clearSalesforceTokenCache } from "@/lib/integrations/salesforce/auth";
import { SALESFORCE_DEFAULT_MAPPING } from "@/lib/integrations/salesforce/mapping";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(failIndex: number | null) {
  const calls: { url: string; body: unknown }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/services/oauth2/token")) return json({ access_token: "tok", instance_url: "https://inst.example" });
    if (url.includes("/sobjects/Crosswalk_Quote__c/")) return json({ id: "0Q0QUOTE", success: true, created: true });
    if (url.includes("/composite/sobjects")) {
      const recs = (body as { records: { Crosswalk_Line_Id__c: string }[] }).records;
      return json(recs.map((r, i) => (failIndex !== null && r.Crosswalk_Line_Id__c === `P1-${failIndex}` ? { id: null, success: false, errors: [{ statusCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: `line ${i} refused` }] } : { id: `a0R${r.Crosswalk_Line_Id__c}`, success: true, created: true })));
    }
    return json({ message: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  const sf = new SalesforceAdapter({ auth: { flow: "client-credentials", loginUrl: "https://login.example", clientId: "id", clientSecret: "sec" }, apiVersion: "v60.0", mapping: SALESFORCE_DEFAULT_MAPPING, quoteObject: "Crosswalk_Quote__c", quoteLineObject: "Crosswalk_Quote_Line__c", fetchImpl: f });
  return { sf, calls };
}

const quote = (n: number) => ({ idempotencyKey: "P1", proposalId: "P1", reference: "PRP-1", accountExternalId: "001000000000001AAA", opportunityExternalId: null, status: "APPROVED", proposalStatus: "APPROVED", approvalStatus: "APPROVED", currency: "USD", totalValue: "10", contractValue: "10", customerSavings: null, blendedMarginPct: null, validThrough: null, createdAt: "2026-09-01T00:00:00Z", approvedAt: null, lines: Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, description: null, competitorCode: `C${i}`, quantity: "1", unitPrice: "10", matchType: null, equivalenceLevel: null, approvalState: "APPROVED" })) });

describe("Salesforce quote write-back (adapter)", () => {
  test("450 lines go out in 3 composite calls of ≤ 200 with allOrNone:false and stable line keys <proposal>-<n>", async () => {
    clearSalesforceTokenCache();
    const { sf, calls } = harness(null);
    const r = await sf.createOrUpdateQuote(quote(450));
    expect(r.externalId).toBe("0Q0QUOTE"); expect(r.lineExternalIds?.length).toBe(450);
    const chunks = calls.filter((c) => c.url.includes("/composite/sobjects"));
    expect(chunks.map((c) => (c.body as { records: unknown[] }).records.length)).toEqual([200, 200, 50]);
    expect(chunks.every((c) => (c.body as { allOrNone: boolean }).allOrNone === false)).toBe(true);
    const keys = chunks.flatMap((c) => (c.body as { records: { Crosswalk_Line_Id__c: string }[] }).records.map((x) => x.Crosswalk_Line_Id__c));
    expect(keys[0]).toBe("P1-1"); expect(keys[449]).toBe("P1-450"); expect(new Set(keys).size).toBe(450);
  });

  test("one refused line in the middle chunk fails the write-back with a VALIDATION error naming the count; a retry re-sends the same keys (idempotent)", async () => {
    clearSalesforceTokenCache();
    const { sf, calls } = harness(250);
    await expect(sf.createOrUpdateQuote(quote(300))).rejects.toMatchObject({ category: "VALIDATION", retryable: false, message: expect.stringMatching(/1 of 300 lines were refused: FIELD_CUSTOM_VALIDATION_EXCEPTION/) });
    const before = calls.filter((c) => c.url.includes("/composite/sobjects")).length;
    expect(before).toBe(2); // both chunks were sent (allOrNone:false — the good lines landed)
    const ok = harness(null);
    await ok.sf.createOrUpdateQuote(quote(300));
    const keys = ok.calls.filter((c) => c.url.includes("/composite/sobjects")).flatMap((c) => (c.body as { records: { Crosswalk_Line_Id__c: string }[] }).records.map((x) => x.Crosswalk_Line_Id__c));
    expect(keys).toContain("P1-250"); expect(new Set(keys).size).toBe(300); // the same external ids → an upsert, never a duplicate line
  });
});

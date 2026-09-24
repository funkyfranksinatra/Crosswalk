/**
 * WS1 GUDID / openFDA client and library (docs/BUILD_NOTES.md §9.3, §11.2). Fetch is injected
 * (`setFetchForTests`) with recorded fixtures and synthetic responses; nothing touches the network.
 * Database-backed for the library, import runner and adoption; the HTTP cases need no rows.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { setFetchForTests, openFdaGet, bucketState, OpenFdaError, timeoutMs } from "@/lib/gudid/http";
import { searchByCfn, lookupByDi, clearOpenFdaMemo, setOpenFdaMemoMsForTests, type OpenFdaRecord } from "@/lib/gudid/openfda";
import { gatherHits, resolveCfn } from "@/lib/pipeline/resolve";
import { planSearches, startImport, runImport, cancelImport, adoptIntoOwnCatalog, pruneAdopted, toDeviceRow, localHits } from "@/lib/gudid/library";
import { getCompany } from "@/lib/settings";
import { getBoss, stopBoss } from "@/lib/jobs/boss";

const hasDb = Boolean(process.env.DATABASE_URL);
const DIR = path.resolve(__dirname, "../recorded/openfda");
const TAG = "WS1GUD";
const strip = (url: string) => url.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const record = (over: Partial<OpenFdaRecord>): OpenFdaRecord => ({ public_device_record_key: `${TAG}-${over.catalog_number ?? Math.random().toString(36).slice(2)}`, brand_name: "WS1 Brand", company_name: "Ethicon Endo-Surgery, LLC", catalog_number: `${TAG}-X`, version_or_model_number: `${TAG}-X`, device_description: "WS1 fixture Bladeless Trocar 12 mm x 100 mm", commercial_distribution_status: "In Commercial Distribution", gmdn_terms: [{ code: "1", name: "Laparoscopic access cannula, single-use" }], product_codes: [{ code: "GCJ", name: "Trocar" }], identifiers: [{ id: `di-${over.catalog_number ?? "x"}`, type: "Primary" }], public_version_date: "2026-01-01", ...over });

/** Recorded fixture responder: unrecorded URLs fail loudly. */
function recorded(extra: (url: string) => Response | null = () => null) {
  const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) as Record<string, string>;
  return async (url: string) => {
    const e = extra(url); if (e) return e;
    const key = strip(url);
    const file = index[key];
    if (!file) throw new Error(`unrecorded openFDA URL: ${key}`);
    const rec = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { status: number; body: string };
    return new Response(rec.body, { status: rec.status, headers: { "content-type": "application/json" } });
  };
}

describe("WS1 openFDA client (no database)", () => {
  const env = { base: process.env.OPENFDA_RETRY_BASE_MS, attempts: process.env.OPENFDA_MAX_ATTEMPTS };
  beforeAll(() => { process.env.OPENFDA_RETRY_BASE_MS = "20"; });
  afterAll(() => { setFetchForTests(null); process.env.OPENFDA_RETRY_BASE_MS = env.base ?? ""; if (!env.base) delete process.env.OPENFDA_RETRY_BASE_MS; });
  afterEach(() => { setFetchForTests(null); clearOpenFdaMemo(); setOpenFdaMemoMsForTests(null); });

  test("429 with Retry-After pauses every caller in the process for that window, then the retry succeeds", async () => {
    let calls = 0;
    setFetchForTests(async () => { calls++; return calls === 1 ? json({ error: "rate" }, 429, { "retry-after": "1" }) : json({ meta: { results: { total: 0 } }, results: [] }); });
    const t0 = Date.now();
    const p1 = openFdaGet("https://api.fda.gov/device/udi.json?search=a&limit=1");
    await new Promise((r) => setTimeout(r, 50));
    const state = bucketState();
    expect(state.pausedForMs).toBeGreaterThan(500); // the shared pause is in force
    const p2 = openFdaGet("https://api.fda.gov/device/udi.json?search=b&limit=1"); // a second caller must wait too
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(r1.attempts).toBe(2); expect(r2.attempts).toBe(1);
    expect(calls).toBe(3);
    expect(bucketState().pausedForMs).toBe(0);
  }, 15_000);

  test("a non-JSON 200 is retried and then succeeds; after OPENFDA_MAX_ATTEMPTS it is an OpenFdaError, never a JSON parse leak", async () => {
    let calls = 0;
    setFetchForTests(async () => { calls++; return calls < 3 ? new Response("<html>proxy error</html>", { status: 200, headers: { "content-type": "text/html" } }) : json({ meta: { results: { total: 1 } }, results: [record({ catalog_number: "OK1" })] }); });
    const r = await openFdaGet("https://api.fda.gov/device/udi.json?search=x&limit=1");
    expect(r.attempts).toBe(3); expect((r.json as { results: unknown[] }).results).toHaveLength(1);
    setFetchForTests(async () => new Response("not json", { status: 200 }));
    await expect(openFdaGet("https://api.fda.gov/device/udi.json?search=y&limit=1", { maxAttempts: 2 })).rejects.toMatchObject({ name: "OpenFdaError", attempts: 2 });
    await expect(openFdaGet("https://api.fda.gov/device/udi.json?search=y&limit=1", { maxAttempts: 2 })).rejects.toThrow(/non-JSON body/);
  }, 15_000);

  test("a hung request times out (OPENFDA_TIMEOUT_MS), is retried, and fails as unreachable on the last attempt", async () => {
    expect(timeoutMs()).toBe(20_000);
    let calls = 0;
    setFetchForTests((_url, init) => new Promise((resolve, reject) => { calls++; const s = init?.signal as AbortSignal; if (calls >= 3) return resolve(json({ meta: { results: { total: 0 } }, results: [] })); s.addEventListener("abort", () => reject(s.reason)); }));
    const r = await openFdaGet("https://api.fda.gov/device/udi.json?search=slow&limit=1", { timeoutMs: 60 });
    expect(r.attempts).toBe(3); expect(calls).toBe(3);
    calls = 0;
    setFetchForTests((_url, init) => new Promise((_, reject) => { calls++; (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted"))); }));
    await expect(openFdaGet("https://api.fda.gov/device/udi.json?search=slow2&limit=1", { timeoutMs: 30, maxAttempts: 2 })).rejects.toThrow(/timed out after 30 ms/);
    expect(calls).toBe(2);
  }, 15_000);

  test("404 is an empty result, not an error; other 4xx are errors without retry", async () => {
    let calls = 0;
    setFetchForTests(async () => { calls++; return json({ error: { code: "NOT_FOUND" } }, 404); });
    const r = await openFdaGet("https://api.fda.gov/device/udi.json?search=none&limit=1");
    expect(r).toEqual({ status: 404, json: null, attempts: 1 });
    expect(await searchByCfn("NOPE-1")).toEqual({ total: 0, results: [] });
    setFetchForTests(async () => { calls++; return json({ error: "bad" }, 400); });
    calls = 0;
    await expect(openFdaGet("https://api.fda.gov/device/udi.json?search=bad&limit=1")).rejects.toBeInstanceOf(OpenFdaError);
    expect(calls).toBe(1);
  });

  test("memo: identical searches are fetched once (in-flight and cached), expire after OPENFDA_MEMO_SECONDS, and the refresh path bypasses the memo", async () => {
    let calls = 0;
    setFetchForTests(async () => { calls++; return json({ meta: { results: { total: 1 } }, results: [record({ catalog_number: "MEMO1" })] }); });
    const [a, b] = await Promise.all([searchByCfn("MEMO1"), searchByCfn("MEMO1")]); // in-flight dedupe
    expect(calls).toBe(1); expect(a.total).toBe(1); expect(b).toEqual(a);
    await searchByCfn("MEMO1"); // memo hit
    expect(calls).toBe(1);
    await searchByCfn("MEMO2"); // a different query is a different key
    expect(calls).toBe(2);
    // Expiry: past the memo window the same query is fetched live again.
    setOpenFdaMemoMsForTests(30);
    await new Promise((r) => setTimeout(r, 40));
    try { await searchByCfn("MEMO1"); } finally { setOpenFdaMemoMsForTests(null); }
    expect(calls).toBe(3);
    // refresh bypass: lookupByDi with fresh:true always asks openFDA, and a plain lookup right after is served from the memo it filled
    await lookupByDi("di-MEMO1", { fresh: true }); await lookupByDi("di-MEMO1", { fresh: true });
    expect(calls).toBe(5);
    await lookupByDi("di-MEMO1");
    expect(calls).toBe(6); // the fresh path does not populate the memo (bypass in both directions)
    await lookupByDi("di-MEMO1");
    expect(calls).toBe(6);
    // errors are never memoised
    setFetchForTests(async () => { calls++; return json({ error: "x" }, 500); });
    await expect(searchByCfn("ERR1", 10)).rejects.toBeInstanceOf(OpenFdaError);
    const before = calls;
    await expect(searchByCfn("ERR1", 10)).rejects.toBeInstanceOf(OpenFdaError);
    expect(calls).toBeGreaterThan(before);
  }, 30_000);
});

describe.skipIf(!hasDb)("WS1 GUDID library and import (database)", () => {
  let companyId: string;
  async function cleanup() {
    // Jobs this suite enqueued (no worker runs here) must not be left for another suite's worker to pick up.
    const imports = await prisma.gudidImport.findMany({ where: { query: { startsWith: TAG } }, select: { jobId: true } });
    if (imports.some((i) => i.jobId)) { const boss = await getBoss(); for (const i of imports) if (i.jobId) await boss.cancel("gudid.import", i.jobId).catch(() => undefined); }
    await prisma.matchCandidate.deleteMany({ where: { ownProduct: { sku: { startsWith: TAG } } } });
    await prisma.ownProduct.deleteMany({ where: { sku: { startsWith: TAG } } });
    await prisma.competitorProduct.deleteMany({ where: { cfnNorm: { startsWith: TAG } } });
    await prisma.gudidDevice.deleteMany({ where: { recordKey: { startsWith: TAG } } });
    await prisma.gudidImport.deleteMany({ where: { query: { startsWith: TAG } } });
  }
  beforeAll(async () => { await cleanup(); companyId = (await getCompany()).id; process.env.OPENFDA_RETRY_BASE_MS = "20"; }, 60_000);
  afterAll(async () => { await cleanup(); setFetchForTests(null); await stopBoss().catch(() => undefined); });
  afterEach(() => { setFetchForTests(null); clearOpenFdaMemo(); });

  test("library-first resolution: a code in the GUDID library resolves without a single openFDA call; a code that is not there goes live", async () => {
    let live = 0;
    setFetchForTests(recorded((url) => { live++; return url.includes(`${TAG}-LIB1`) ? json({ error: "should not be called" }, 500) : null; }));
    const rec = record({ catalog_number: `${TAG}-LIB1`, version_or_model_number: `${TAG}-LIB1`, public_device_record_key: `${TAG}-lib-1` });
    await prisma.gudidDevice.create({ data: { ...toDeviceRow(rec), importId: null } });
    expect((await localHits(`${TAG}-LIB1`, false)).map((r) => r.public_device_record_key)).toEqual([`${TAG}-lib-1`]);
    const hits = await gatherHits(`${TAG}-LIB1`, undefined, true);
    expect(hits[0]?.fromLibrary).toBe(true);
    expect(live).toBe(0);
    const cp = await resolveCfn(`${TAG}-LIB1`, { useLlm: false, strict: true });
    expect(cp?.resolutionNote).toMatch(/GUDID library exact hit/);
    expect(live).toBe(0);
    // Not in the library → the recorded live answer for 1DLMC05 (Gore) is used.
    await prisma.competitorProduct.deleteMany({ where: { cfnNorm: "1DLMC05" } });
    const gore = await resolveCfn("1DLMC05", { useLlm: false, strict: true });
    expect(gore?.manufacturer).toBe("W.L. Gore");
    expect(live).toBeGreaterThan(0);
  }, 60_000);

  test("import planning beyond the 26,000 window splits by product code, then brand, and appends a _missing_ leaf", async () => {
    const counts: Record<string, number> = { base: 60_000, "product_codes.code:\"GCJ\"": 30_000, "product_codes.code:\"GEI\"": 5_000, "product_codes.code:\"GCJ\"+AND+brand_name:\"A\"": 20_000, "product_codes.code:\"GCJ\"+AND+brand_name:\"B\"": 10_000 };
    const seen: string[] = [];
    setFetchForTests(async (url) => {
      const u = decodeURIComponent(strip(url)); seen.push(u);
      const search = new URL(u).searchParams.get("search") ?? "";
      if (u.includes("count=product_codes.code.exact")) return json({ results: [{ term: "GCJ", count: 30_000 }, { term: "GEI", count: 5_000 }] });
      if (u.includes("count=brand_name.exact")) return json({ results: [{ term: "A", count: 20_000 }, { term: "B", count: 10_000 }] });
      const key = Object.keys(counts).find((k) => k !== "base" && search.endsWith(k));
      return json({ meta: { results: { total: key ? counts[key] : counts.base } }, results: [] });
    });
    const leaves = await planSearches("company_name:\"WS1\"", 60_000);
    // GCJ (30k) is over the cap → split by brand (A 20k, B 10k); GEI (5k) stays; each level adds a _missing_ leaf.
    expect(leaves.map((l) => [l.search.replace(/^company_name:"WS1"\+AND\+/, ""), l.count])).toEqual([
      ['product_codes.code:"GCJ"+AND+brand_name:"A"', 20_000], ['product_codes.code:"GCJ"+AND+brand_name:"B"', 10_000], ['product_codes.code:"GCJ"+AND+_missing_:brand_name', 0],
      ['product_codes.code:"GEI"', 5_000], ["_missing_:product_codes.code", 0],
    ]);
    expect(leaves.every((l) => l.count <= 26_000)).toBe(true);
    expect(await planSearches("company_name:\"Small\"", 100)).toEqual([{ search: "company_name:\"Small\"", count: 100 }]);
  }, 30_000);

  test("one active import at a time; cursor resume after a simulated crash re-fetches nothing already stored; cancel stops at the next page", async () => {
    const pages = 3;
    const PAGE = 1000;
    const fetched: string[] = [];
    let crashOnPage: number | null = 2;
    const respond = async (url: string) => {
      const u = decodeURIComponent(strip(url));
      fetched.push(u);
      if (u.includes("count=")) return json({ results: [] });
      const params = new URL(u).searchParams;
      if (params.get("limit") === "1") return json({ meta: { results: { total: pages * PAGE } }, results: [] });
      const skip = Number(params.get("skip") ?? 0);
      const page = skip / PAGE;
      if (crashOnPage !== null && page === crashOnPage) throw new Error(`simulated crash on page ${page}`);
      if (page >= pages) return json({ error: "NOT_FOUND" }, 404);
      return json({ meta: { results: { total: pages * PAGE } }, results: Array.from({ length: PAGE }, (_, i) => record({ catalog_number: `${TAG}-P${page}-${i}`, version_or_model_number: `${TAG}-P${page}-${i}`, public_device_record_key: `${TAG}-p${page}-${i}` })) });
    };
    setFetchForTests(respond);
    const job = await startImport({ query: `${TAG} Labeler`, kind: "COMPETITOR" });
    await expect(startImport({ query: `${TAG} Second`, kind: "COMPETITOR" })).rejects.toThrow(/already queued/);
    // Attempt 1 crashes on page 3 (skip 2000): the row stays RUNNING with a cursor and the error is thrown to the queue.
    await expect(runImport(job.id, { attempt: 1, finalAttempt: false })).rejects.toThrow(/simulated crash/);
    let row = await prisma.gudidImport.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("RUNNING");
    expect(JSON.parse(row.cursorJson!)).toMatchObject({ leaf: 0, skip: 2000 });
    expect(row.fetched).toBe(2000);
    expect(await prisma.gudidDevice.count({ where: { recordKey: { startsWith: `${TAG}-p` } } })).toBe(2000);
    expect(row.log).toMatch(/Attempt 1 failed, will retry/);
    await expect(startImport({ query: `${TAG} Third`, kind: "COMPETITOR" })).rejects.toThrow(/already running/);
    // Attempt 2 resumes at page 3: pages 1–2 are not fetched again.
    crashOnPage = null;
    const before = fetched.length;
    await runImport(job.id, { attempt: 2 });
    const after = fetched.slice(before).filter((u) => !u.includes("count="));
    expect(after.some((u) => /skip=0\b/.test(u) || /skip=1000\b/.test(u))).toBe(false);
    expect(after.some((u) => /skip=2000\b/.test(u))).toBe(true);
    row = await prisma.gudidImport.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "DONE", fetched: 3000, created: 3000, attempt: 2, cursorJson: null });
    expect(row.log).toMatch(/Resumed \(attempt 2\) at query 1, page 3/);
    expect(await prisma.gudidDevice.count({ where: { recordKey: { startsWith: `${TAG}-p` } } })).toBe(3000);
    // A redelivered job for finished work is a no-op.
    const n = fetched.length; await runImport(job.id, { attempt: 3 }); expect(fetched.length).toBe(n);
    // Cancel: a cancel that lands while page 1 is being processed stops the import before page 2.
    await prisma.gudidDevice.deleteMany({ where: { recordKey: { startsWith: `${TAG}-p` } } });
    const job2 = await startImport({ query: `${TAG} Cancelled`, kind: "COMPETITOR" });
    setFetchForTests(async (url) => { const u = decodeURIComponent(strip(url)); if (/skip=0\b/.test(u) && !u.includes("count=") && !/limit=1&/.test(u + "&")) await cancelImport(job2.id); return respond(url); });
    await runImport(job2.id, { attempt: 1 });
    const c = await prisma.gudidImport.findUniqueOrThrow({ where: { id: job2.id } });
    expect(c.status).toBe("CANCELLED"); expect(c.cancelRequested).toBe(false);
    expect(c.fetched).toBeLessThanOrEqual(1000);
    expect(c.log).toMatch(/Cancelled/);
    // Cancelling a QUEUED import marks it cancelled outright, and the runner then does nothing.
    const job3 = await startImport({ query: `${TAG} Queued`, kind: "COMPETITOR" });
    await cancelImport(job3.id);
    expect((await prisma.gudidImport.findUniqueOrThrow({ where: { id: job3.id } })).status).toBe("CANCELLED");
    const n3 = fetched.length; await runImport(job3.id); expect(fetched.length).toBe(n3);
  }, 120_000);

  test("adoption: 'Other' family and placeholder SKUs are never adopted; a real surgical record is, once; prune dry-run equals the applied result", async () => {
    const rows = [
      toDeviceRow(record({ catalog_number: `${TAG}-ADOPT1`, version_or_model_number: `${TAG}-ADOPT1`, public_device_record_key: `${TAG}-adopt-1`, device_description: "WS1 Bladeless Trocar 12 mm x 100 mm", company_name: "Covidien LP" })),
      toDeviceRow(record({ catalog_number: "NO MATCH", version_or_model_number: "NO MATCH", public_device_record_key: `${TAG}-adopt-ph`, device_description: "WS1 Bladeless Trocar 5 mm x 100 mm" })),
      toDeviceRow(record({ catalog_number: `${TAG}-OTHER1`, version_or_model_number: `${TAG}-OTHER1`, public_device_record_key: `${TAG}-adopt-other`, brand_name: "Pyramesh", device_description: "Titanium spinal cage", gmdn_terms: [{ code: "2", name: "Spinal cage" }], product_codes: [{ code: "MAX", name: "Spinal", openfda: { medical_specialty_description: "Orthopedic" } }] })),
    ];
    expect(rows.map((r) => r.family)).toEqual(["Trocar Products", "Trocar Products", "Other"]);
    expect(await adoptIntoOwnCatalog(rows, null)).toBe(1);
    expect(await adoptIntoOwnCatalog(rows, null)).toBe(0); // already there: nothing twice
    const adopted = await prisma.ownProduct.findMany({ where: { sku: { startsWith: TAG } } });
    expect(adopted.map((p) => p.sku)).toEqual([`${TAG}-ADOPT1`]);
    expect(adopted[0]).toMatchObject({ source: "gudid-import", category: "Trocar Products", companyId });
    expect(await prisma.ownProduct.count({ where: { sku: { in: ["NOMATCH", "NO MATCH", `${TAG}-OTHER1`] } } })).toBe(0);
    // family filter: a trocar is not adopted into a mesh-only import
    await prisma.ownProduct.deleteMany({ where: { sku: `${TAG}-ADOPT1` } });
    expect(await adoptIntoOwnCatalog(rows, ["Hernia Mesh"])).toBe(0);
    expect(await adoptIntoOwnCatalog(rows, ["Trocar Products"])).toBe(1);
    // Prune: an adopted row that re-bins to Other is deleted, a referenced one deactivated, a good one kept; dry-run predicts exactly the applied counts.
    const goodOther = await prisma.ownProduct.create({ data: { companyId, sku: `${TAG}-PRUNE-OTHER`, description: "Titanium spinal cage", category: "Trocar Products", source: "gudid-import", gudidJson: JSON.stringify(record({ catalog_number: `${TAG}-PRUNE-OTHER`, brand_name: "Pyramesh", device_description: "Titanium spinal cage", product_codes: [{ code: "MAX", name: "Spinal", openfda: { medical_specialty_description: "Orthopedic" } }] })) } });
    const referenced = await prisma.ownProduct.create({ data: { companyId, sku: `${TAG}-PRUNE-REF`, description: "Titanium spinal cage", category: "Trocar Products", source: "gudid-import", listPrice: "1" } });
    await prisma.standardCost.create({ data: { productId: referenced.id, currency: "USD", cost: "1", effectiveFrom: new Date("2026-01-01"), source: "ws1" } });
    const dry = await pruneAdopted({ dryRun: true });
    const applied = await pruneAdopted({});
    expect(applied).toEqual({ ...dry, rebinned: applied.rebinned }); // kept / deleted / deactivated identical; rebinned only happens when applying
    expect(dry.rebinned).toBe(0);
    expect(await prisma.ownProduct.findUnique({ where: { id: goodOther.id } })).toBeNull();
    expect((await prisma.ownProduct.findUniqueOrThrow({ where: { id: referenced.id } })).isActive).toBe(false);
    expect((await prisma.ownProduct.findFirstOrThrow({ where: { sku: `${TAG}-ADOPT1` } })).isActive).toBe(true);
    expect(await pruneAdopted({ dryRun: true })).toMatchObject({ deleted: 0, deactivated: 0 }); // idempotent
    await prisma.standardCost.deleteMany({ where: { productId: referenced.id } });
  }, 60_000);
});

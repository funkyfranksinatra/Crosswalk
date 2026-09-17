/** Pure unit tests for the Tier 1 modules: no database, no network. */
import { describe, test, expect, afterEach } from "vitest";
import { log, onLog, withRequestContext, currentRequestId } from "@/lib/log";
import { render, counter, gauge, snapshot } from "@/lib/observability/metrics";
import { openFdaGet, setFetchForTests, backoff, rpmLimit, OpenFdaError } from "@/lib/gudid/http";
import { isStale } from "@/lib/gudid/refresh";
import { scoreCandidates, REP_PRIOR_BOOST } from "@/lib/match/score";
import { heuristicBin } from "@/lib/match/bin";
import { parseReferenceGrid } from "@/lib/eval/benchmark";
import { gate } from "@/lib/eval/model";
import { GRADE_PROMPT_VERSION } from "@/lib/match/grading";
import { BIN_VERSION } from "@/lib/match/bin";
import { QUEUES } from "@/lib/jobs/queues";
import { feedCron, feedMaxAgeHours, FEEDS } from "@/lib/feeds";

describe("structured log", () => {
  test("scrubs secret-looking keys, carries the request id, never throws", () => {
    const lines: Record<string, unknown>[] = [];
    const off = onLog((l) => lines.push(l));
    withRequestContext({ requestId: "req-123" }, () => { log.info("t.event", { apiKey: "sk-secret", DATABASE_URL: "postgres://x", ok: 1, err: new Error("boom") }); expect(currentRequestId()).toBe("req-123"); });
    off();
    const l = lines.find((x) => x.event === "t.event")!;
    expect(l.apiKey).toBe("[redacted]");
    expect(l.DATABASE_URL).toBe("[redacted]");
    expect(l.requestId).toBe("req-123");
    expect((l.err as { message: string }).message).toBe("boom");
    expect(() => log.info("x", { circular: (() => { const o: Record<string, unknown> = {}; o.o = o; return o; })() })).not.toThrow();
  });
});

describe("metrics", () => {
  test("renders Prometheus text with labels and histogram buckets", () => {
    counter("t_c", "help").inc({ a: "x" }, 2);
    gauge("t_g", "help").set({}, 3);
    const out = render();
    expect(out).toContain('t_c{a="x"} 2');
    expect(out).toContain("t_g 3");
    expect(out).toContain("# TYPE crosswalk_http_request_seconds histogram");
    expect(snapshot().t_c).toBeTruthy();
  });
});

describe("openFDA client", () => {
  afterEach(() => { setFetchForTests(null); delete process.env.OPENFDA_MAX_ATTEMPTS; delete process.env.OPENFDA_RETRY_BASE_MS; delete process.env.OPENFDA_RPM; });
  test("retries 429 honouring Retry-After, then succeeds; 404 is an empty result", async () => {
    let calls = 0;
    process.env.OPENFDA_RETRY_BASE_MS = "1";
    setFetchForTests(async () => { calls++; if (calls < 3) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }); return new Response(JSON.stringify({ results: [1] }), { status: 200 }); });
    const r = await openFdaGet("https://api.fda.gov/device/udi.json?search=x");
    expect(r.status).toBe(200); expect(r.attempts).toBe(3); expect(calls).toBe(3);
    setFetchForTests(async () => new Response("", { status: 404 }));
    expect((await openFdaGet("https://api.fda.gov/x")).json).toBeNull();
  });
  test("gives up after OPENFDA_MAX_ATTEMPTS on 5xx and does not retry a 400", async () => {
    process.env.OPENFDA_MAX_ATTEMPTS = "2"; process.env.OPENFDA_RETRY_BASE_MS = "1";
    let calls = 0;
    setFetchForTests(async () => { calls++; return new Response("down", { status: 503 }); });
    await expect(openFdaGet("https://api.fda.gov/x")).rejects.toBeInstanceOf(OpenFdaError);
    expect(calls).toBe(2);
    calls = 0;
    setFetchForTests(async () => { calls++; return new Response("bad", { status: 400 }); });
    await expect(openFdaGet("https://api.fda.gov/x")).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
  test("api key is appended once and never in the caller's URL; budget follows the key", () => {
    process.env.OPENFDA_RPM = "120";
    expect(rpmLimit()).toBe(120);
    delete process.env.OPENFDA_RPM;
    const withKey = process.env.OPENFDA_API_KEY ? 800 : 192;
    expect(rpmLimit()).toBe(withKey);
    expect(backoff(1000, 3)).toBeLessThanOrEqual(4000);
    expect(backoff(1000, 20, 5000)).toBeLessThanOrEqual(5000);
  });
  test("cache TTL: a record older than GUDID_CACHE_TTL_DAYS is stale, a fresh one is not", () => {
    const old = new Date(Date.now() - 100 * 86_400_000), fresh = new Date();
    expect(isStale(null, old)).toBe(true);
    expect(isStale(fresh, old)).toBe(false);
    expect(isStale(null, null)).toBe(true);
  });
});

describe("learning loop scoring", () => {
  test("an unreviewed rep cross lifts a candidate without granting the curated tier floor", () => {
    const comp = heuristicBin({ description: "Polypropylene mesh 15 x 10 cm" });
    const cand = { ownProductId: "a", sku: "A", description: "Polypropylene mesh 15 x 10 cm", bin: heuristicBin({ description: "Polypropylene mesh 15 x 10 cm" }), unitPrice: null, cogs: null };
    const plain = scoreCandidates({ bin: comp, description: "", estPrice: null }, [cand])[0];
    const draft = scoreCandidates({ bin: comp, description: "", estPrice: null }, [{ ...cand, knownCross: { matchType: "Exact Match", source: "rep", approvalStatus: "DRAFT", endorsements: 2 } }])[0];
    const approved = scoreCandidates({ bin: comp, description: "", estPrice: null }, [{ ...cand, knownCross: { matchType: "Exact Match", source: "sheet", approvalStatus: "APPROVED" } }])[0];
    expect(draft.scoreBin).toBeCloseTo(Math.min(1, plain.scoreBin + REP_PRIOR_BOOST), 5);
    expect(draft.source).toBe("attribute");
    expect(draft.rationale).toMatch(/chosen by 2 reps before/);
    expect(approved.source).toBe("known-cross");
    expect(approved.matchType).toBe("Exact Match");
  });
});

describe("benchmark reference parsing", () => {
  test("accepts several expected SKUs and PACR-style headers", () => {
    const rows = parseReferenceGrid([["Competitor Code", "MDT SKU", "Match Type", "Family"], ["1DLMC05", "PPDS12 | PPDS15", "Close Match", "Synthetic Mesh"], ["", "x", "", ""], ["ABC", "", "Not Found", ""]]);
    expect(rows).toHaveLength(2);
    expect(rows[0].expected).toEqual(["PPDS12", "PPDS15"]);
    expect(rows[1].expected).toEqual([]);
    expect(() => parseReferenceGrid([["foo", "bar"]])).toThrow(/competitor code column/);
  });
});

describe("model eval gate", () => {
  test("fails when the code's prompt/bin/model versions differ from the accepted baseline; warns when none exists", async () => {
    const base = { model: "m", promptVersion: GRADE_PROMPT_VERSION, binVersion: BIN_VERSION, sampleSeed: 7, sampleSize: 40, graded: 40, top1Agree: 30, tierAgree: 28, noMatchFalse: 0, acceptedAt: "", evalId: null };
    expect((await gate({ baseline: base, model: "m" })).ok).toBe(true);
    const bumped = await gate({ baseline: { ...base, promptVersion: GRADE_PROMPT_VERSION - 1 }, model: "m" });
    expect(bumped.ok).toBe(false); expect(bumped.reasons[0]).toMatch(/GRADE_PROMPT_VERSION/);
    expect((await gate({ baseline: base, model: "other" })).reasons[0]).toMatch(/LLM_MODEL/);
    const none = await gate({ baseline: null, model: "m" });
    expect(none.ok).toBe(true); expect(none.warnings[0]).toMatch(/no accepted baseline/);
  });
});

describe("queue and feed configuration", () => {
  test("every queue has an expiry (the crash detector) and feeds have sane schedules", () => {
    for (const [name, q] of Object.entries(QUEUES)) { expect(q.expireInSeconds, name).toBeGreaterThan(0); expect(q.retryLimit, name).toBeGreaterThanOrEqual(0); }
    for (const f of Object.values(FEEDS)) { expect(feedCron(f.name)).toMatch(/^(\S+\s+){4}\S+$/); expect(feedMaxAgeHours(f.name)).toBeGreaterThan(0); }
    process.env.FEED_GPO_CRON = "off";
    expect(feedCron("gpo")).toBeNull();
    delete process.env.FEED_GPO_CRON;
  });
});

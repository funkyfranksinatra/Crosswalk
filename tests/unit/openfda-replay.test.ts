/**
 * The resolver against recorded openFDA responses — no network. Any URL the resolver asks
 * for that was not recorded fails the test, which is the point: a change in the variant
 * strategy shows up here as "unrecorded URL", not as a silent behaviour change in CI.
 * Needs DATABASE_URL (CompetitorProduct rows are written); skipped without one.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { setFetchForTests } from "@/lib/gudid/http";
import { runScenario, CODES } from "../recorded/openfda-scenario";

const DIR = path.resolve(__dirname, "../recorded/openfda");
const strip = (url: string) => url.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "");
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("resolver with recorded openFDA responses", () => {
  const unrecorded: string[] = [];
  beforeAll(() => {
    const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) as Record<string, string>;
    setFetchForTests(async (url) => {
      const key = strip(url);
      const file = index[key];
      if (!file) { unrecorded.push(key); throw new Error(`unrecorded openFDA URL: ${key}`); }
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { status: number; body: string };
      return new Response(rec.body, { status: rec.status, headers: { "content-type": "application/json" } });
    });
  });
  afterAll(() => setFetchForTests(null));

  test("every code resolves exactly as it did when recorded", async () => {
    const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
    const got = await runScenario();
    expect(unrecorded).toEqual([]);
    for (const code of CODES) expect(got[code], code).toEqual(expected[code]);
  });
});

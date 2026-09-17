import { describe, test, expect } from "vitest";
import { isPlaceholderSku } from "@/lib/cfn";
import { isTestFixture } from "@/lib/eval/model";

describe("isPlaceholderSku", () => {
  test("spreadsheet placeholders are not catalog numbers", () => {
    for (const v of ["No Match", "NOMATCH", "no match found", "N/A", "n/a", "NA", "NONE", "TBD", "TOTAL", "Sub total", "Disc", "Discontinued", "-", "?", "", null, undefined, "See notes", "Not applicable"]) {
      expect(isPlaceholderSku(v), String(v)).toBe(true);
    }
  });
  test("real catalog numbers pass, including short and letter-only ones with three letters", () => {
    for (const v of ["ONB5STF", "24055-", "SIG45AMT", "174006", 174006, "EGIA60AVM", "PPM1106X3", "GORE", "X1", "AB1", "NX-12", "NAV3"]) {
      expect(isPlaceholderSku(v), String(v)).toBe(false);
    }
  });
});

describe("isTestFixture", () => {
  test("only the suites' prefixes", () => {
    expect(isTestFixture("E2E-TEST-CODE")).toBe(true);
    expect(isTestFixture("e2e-lib-9001")).toBe(true);
    expect(isTestFixture("TEST-1")).toBe(true);
    expect(isTestFixture("E2E60AVM")).toBe(false);
    expect(isTestFixture("TESTA12")).toBe(false);
    expect(isTestFixture("ONB5STF")).toBe(false);
  });
});

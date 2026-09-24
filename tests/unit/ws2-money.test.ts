/**
 * WS2 — money oracle. Every expectation is written out as a literal; nothing here calls the
 * function under test to compute what it should return.
 *
 * Facts pinned: decimal.js precision 28, rounding ROUND_HALF_EVEN (banker's, mode 6) both for
 * `round()` and for `toFixed` in `toDb` / `toDbPct`; Decimal(18,4) amounts are written with 4 dp
 * and never clamped; Decimal(12,6) percent columns are clamped to ±999,999; non-finite input
 * (NaN / ±Infinity, number or string) is "no value".
 */
import { describe, test, expect } from "vitest";
import { Decimal, D, money, round, toDb, toDbPct, toJson, num, times, sum, ratio, marginPct, marginAmount, discountPct, priceForMargin, applyPct, clamp, max, min, fmt, fmtPct, minorUnits, ZERO } from "@/lib/money";

describe("WS2 money oracle", () => {
  test("global configuration: precision 28, ROUND_HALF_EVEN", () => {
    expect(Decimal.precision).toBe(28);
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_EVEN);
    expect(Decimal.ROUND_HALF_EVEN).toBe(6);
    // 28 significant digits: the 29th is rounded (half-even) away.
    expect(D("123456789012345678901234567890").plus(1).toString()).toBe("1.234567890123456789012345679e+29");
    expect(D(1).div(3).times(3).toString()).toBe("0.9999999999999999999999999999");
  });

  test("round(): banker's rounding to the currency's minor unit, half-way cases both ways", () => {
    expect(round(D("2.345")).toString()).toBe("2.34"); // 4 is even → down
    expect(round(D("2.355")).toString()).toBe("2.36"); // 5 is odd → up to even 6
    expect(round(D("2.365")).toString()).toBe("2.36"); // 6 even → down
    expect(round(D("-2.345")).toString()).toBe("-2.34");
    expect(round(D("-2.355")).toString()).toBe("-2.36");
    expect(round(D("0.005")).toString()).toBe("0");
    expect(round(D("0.015")).toString()).toBe("0.02");
    expect(round(D("2.3450001")).toString()).toBe("2.35"); // not a tie → nearest
    expect(round(D("1.5"), "JPY").toString()).toBe("2");
    expect(round(D("2.5"), "JPY").toString()).toBe("2");
    expect(round(D("1.0005"), "KWD").toString()).toBe("1");
    expect(round(D("1.0015"), "KWD").toString()).toBe("1.002");
    expect(round(D("1.005"), "EUR").toString()).toBe("1"); // 0 is even
    expect(minorUnits("eur")).toBe(2);
    expect(minorUnits("jpy")).toBe(0);
    expect(minorUnits("BHD")).toBe(3);
    expect(minorUnits("XYZ")).toBe(2);
  });

  test("toDb(): Decimal(18,4) serialisation, half-even at the 5th decimal, amounts never clamped", () => {
    expect(toDb("1.00005")).toBe("1.0000");
    expect(toDb("1.00015")).toBe("1.0002");
    expect(toDb("1.00025")).toBe("1.0002");
    expect(toDb("12.5")).toBe("12.5000");
    expect(toDb(0.1 + 0.2)).toBe("0.3000"); // a JS float is normalised through its shortest decimal form
    expect(toDb("-0")).toBe("0.0000");
    expect(toDb("1e15")).toBe("1000000000000000.0000"); // 16 integer digits: exceeds Decimal(18,4) — the DB refuses it, toDb does not clamp
    expect(toDb(times("1000000000", "1000000"))).toBe("1000000000000000.0000");
    expect(toDb("99999999999999.9999")).toBe("99999999999999.9999"); // the largest Decimal(18,4)
    expect(toDb(null)).toBeNull();
    expect(toDb(undefined)).toBeNull();
    expect(toDb("")).toBeNull();
    expect(toDb("abc")).toBeNull();
  });

  test("toDbPct(): Decimal(12,6) percent columns are clamped to ±999999 and rounded half-even at 6 dp", () => {
    expect(toDbPct("1000000")).toBe("999999.000000");
    expect(toDbPct("-1000000")).toBe("-999999.000000");
    expect(toDbPct("999999")).toBe("999999.000000");
    expect(toDbPct("999999.0000005")).toBe("999999.000000"); // clamped after comparison (> lim) — the tie rounds to even
    expect(toDbPct("0.0000005")).toBe("0.000000");
    expect(toDbPct("0.0000015")).toBe("0.000002");
    expect(toDbPct("0.0000025")).toBe("0.000002");
    expect(toDbPct("-2999900")).toBe("-999999.000000"); // the documented $0.01 vs $300 cost case
    expect(toDbPct(null)).toBeNull();
  });

  test("money(): null vs zero, NaN, ±Infinity (number and string), overflow strings, Prisma-like objects", () => {
    expect(money(null)).toBeNull();
    expect(money(undefined)).toBeNull();
    expect(money("")).toBeNull();
    expect(money("  ")).toBeNull();
    expect(money(0)!.isZero()).toBe(true); // zero is a value, not "missing"
    expect(money("0")!.toString()).toBe("0");
    expect(money(NaN)).toBeNull();
    expect(money(Infinity)).toBeNull();
    expect(money(-Infinity)).toBeNull();
    // Strings that decimal.js would happily parse as non-finite must be "no value" too — a
    // scenario price or freight typed as "NaN"/"Infinity" would otherwise reach the DB as numeric NaN.
    expect(money("NaN")).toBeNull();
    expect(money("Infinity")).toBeNull();
    expect(money("-Infinity")).toBeNull();
    expect(money("1e400")!.toString()).toBe("1e+400"); // finite for decimal.js (max exponent 9e15); the DB refuses it (numeric field overflow) — route validators bound prices at 1e9 first
    expect(money("1e21")!.toString()).toBe("1e+21");
    expect(money({ toString: () => "12.3400" })!.toString()).toBe("12.34");
    expect(money("0x10")).toBeNull(); // decimal.js would read hex/binary/octal/hex-float literals; a price typed that way is refused (review REV-04: it reached a contract entry as $16)
    expect(money("0b101")).toBeNull(); expect(money("0o17")).toBeNull(); expect(money("0x1p3")).toBeNull();
    expect(money("1e3")!.toString()).toBe("1000"); expect(money("-.5")!.toString()).toBe("-0.5"); expect(money("+2.")!.toString()).toBe("2");
    expect(money("1,000")).toBeNull(); // thousands separators are not numbers
    expect(money("$5")).toBeNull();
    expect(() => D(null)).toThrow(/money required/);
    expect(() => D("NaN")).toThrow(/money required/);
  });

  test("arithmetic helpers: null propagation, zero denominators, exact decimal results", () => {
    expect(sum(["0.1", "0.2"]).toString()).toBe("0.3");
    expect(sum([null, "1", 2, undefined, ""]).toString()).toBe("3"); // missing values add nothing
    expect(times("63.61", 6)!.toString()).toBe("381.66");
    expect(times(null, 2)).toBeNull();
    expect(times("1", null)).toBeNull();
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(0, 5)!.toString()).toBe("0");
    expect(ratio("1", "3")!.toString()).toBe("0.3333333333333333333333333333");
    expect(marginPct(0, 5)).toBeNull(); // price 0: margin undefined, never −∞
    expect(marginPct(100, 0)!.toString()).toBe("1");
    expect(marginPct("100", "55")!.toString()).toBe("0.45");
    expect(marginPct("0.01", "300")!.toString()).toBe("-29999");
    expect(marginAmount("100", "55")!.toString()).toBe("45");
    expect(marginAmount(null, "55")).toBeNull();
    expect(discountPct(50, 0)).toBeNull();
    expect(discountPct("760", "1000")!.toString()).toBe("0.24");
    expect(discountPct("1100", "1000")!.toString()).toBe("-0.1"); // above reference: negative discount
    expect(priceForMargin("55", "0.45")!.toFixed(2)).toBe("100.00");
    expect(priceForMargin("55", "0.45")!.toString()).toBe("100");
    expect(priceForMargin(55, 1)).toBeNull(); // 100 % margin: division by zero → no price
    expect(priceForMargin(55, 1.5)).toBeNull();
    expect(priceForMargin(55, 0)!.toString()).toBe("55");
    expect(priceForMargin(55, -1)!.toString()).toBe("27.5"); // negative margins are arithmetic, not policy
    expect(applyPct("100", "0.05")!.toString()).toBe("105");
    expect(applyPct("100", "-0.05")!.toString()).toBe("95");
    expect(clamp(D(5), 10, 3).toString()).toBe("3"); // lo > hi: the upper bound is applied last
    expect(clamp(D(5), null, null).toString()).toBe("5");
    expect(clamp(D(-1), 0, null).toString()).toBe("0");
    expect(max(null, undefined)).toBeNull();
    expect(max("1", "2.5", null)!.toString()).toBe("2.5");
    expect(min("1", "2.5", null)!.toString()).toBe("1");
    expect(ZERO.isZero()).toBe(true);
  });

  test("serialisation: toJson keeps full precision as a string, num() is display-only", () => {
    expect(toJson(D(1).div(3))).toBe("0.3333333333333333333333333333");
    expect(toJson("12.3400")).toBe("12.34");
    expect(toJson(null)).toBeNull();
    expect(toJson("1e21")).toBe("1e+21"); // exponent form beyond 1e21 — JSON consumers must parse, not eyeball
    expect(toJson("1e-7")).toBe("1e-7");
    expect(num("1e21")).toBe(1e21);
    expect(num(null)).toBeNull();
    expect(num("12.34")).toBe(12.34);
  });

  test("formatting is display-only and never throws on unknown currencies", () => {
    expect(fmt("1234.5")).toBe("$1,234.50");
    expect(fmt("1234.5", "JPY")).toBe("¥1,235"); // Intl rounds half-up here — display only
    expect(fmt(null)).toBe("—");
    expect(fmt("1", "XXX")).toBe("¤1.00");
    expect(fmtPct("0.12345")).toBe("12.3%");
    expect(fmtPct("0.125")).toBe("12.5%");
    expect(fmtPct("0.1245", 1)).toBe("12.4%"); // 12.45 → half-even → 12.4
    expect(fmtPct(null)).toBe("—");
  });
});

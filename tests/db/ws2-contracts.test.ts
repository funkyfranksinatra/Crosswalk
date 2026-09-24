/**
 * WS2 — contract price-entry writes (KN-18). The route `POST /api/contracts/{id}/entries` must
 * delegate to `addContractEntries` (src/lib/contracts/entries.ts): one transaction for supersede +
 * create + audit, serialised per contract, refused on an adapter without transactions.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { addContractEntries, validateEntryRows, entriesAdapterSupported } from "@/lib/contracts/entries";
import { RUN, mkUser, mkProduct, mkAccount, mkContract, cleanupRun, day } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("WS2 contracts — transactional price entries", () => {
  let mgr: Awaited<ReturnType<typeof mkUser>>;
  let rep: Awaited<ReturnType<typeof mkUser>>;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let A: Awaited<ReturnType<typeof mkProduct>>, B: Awaited<ReturnType<typeof mkProduct>>, C: Awaited<ReturnType<typeof mkProduct>>;

  beforeAll(async () => {
    await cleanupRun();
    mgr = await mkUser("cmgr", ["CONTRACTING_MANAGER"]);
    rep = await mkUser("rep", ["SALES_REP"]);
    acct = await mkAccount({ name: "entries acct" });
    A = await mkProduct({ sku: "A", listPrice: "100" });
    B = await mkProduct({ sku: "B", listPrice: "100" });
    C = await mkProduct({ sku: "C", listPrice: "100" });
  });
  afterAll(async () => { await cleanupRun(); });

  const active = async (contractId: string) => (await prisma.priceEntry.findMany({ where: { contractId, status: "ACTIVE" }, orderBy: [{ productId: "asc" }] })).map((e) => `${e.productId === A.id ? "A" : e.productId === B.id ? "B" : "C"}:${e.price.toString()}`).sort();

  test("KN-18: a failure on the 2nd row of 3 leaves nothing written — no supersession, no creation, no audit event", async () => {
    const c = await mkContract({ number: "KN18", type: "LOCAL", accountId: acct.id, entries: [A, B, C].map((p) => ({ productId: p.id, price: "90" })) });
    expect(await active(c.id)).toEqual(["A:90", "B:90", "C:90"]);
    const audits0 = await prisma.auditEvent.count({ where: { entityType: "Contract", entityId: c.id } });
    // Failure injection at the Prisma layer (a DB error mid-batch behaves the same way): the
    // interactive-transaction client is handed to the service through a proxy whose 2nd
    // `priceEntry.create` throws.
    const orig = prisma.$transaction.bind(prisma);
    let calls = 0;
    (prisma as unknown as { $transaction: unknown }).$transaction = (fn: unknown, opts: unknown) => orig(async (tx) => {
      const wrapped = new Proxy(tx as object, {
        get(t, prop) {
          if (prop === "priceEntry") {
            const model = Reflect.get(t, prop) as object;
            return new Proxy(model, { get(m, p2) { if (p2 === "create") return (a: unknown) => { calls++; if (calls === 2) throw new Error("injected failure on entry 2"); return (Reflect.get(m, "create") as (a: unknown) => Promise<unknown>).call(m, a); }; const v = Reflect.get(m, p2); return typeof v === "function" ? v.bind(m) : v; } });
          }
          const v = Reflect.get(t, prop);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      return (fn as (t: unknown) => Promise<unknown>)(wrapped);
    }, opts as never);
    try {
      await expect(addContractEntries(mgr.actor, c.id, [A, B, C].map((p) => ({ sku: p.sku, price: "80" })))).rejects.toThrow(/injected failure on entry 2/);
    } finally {
      (prisma as unknown as { $transaction: unknown }).$transaction = orig;
    }
    expect(calls).toBe(2);
    // Nothing moved: the old ACTIVE 90s are still the only active rows, no SUPERSEDED rows, no new rows, no audit.
    expect(await active(c.id)).toEqual(["A:90", "B:90", "C:90"]);
    expect(await prisma.priceEntry.count({ where: { contractId: c.id } })).toBe(3);
    expect(await prisma.priceEntry.count({ where: { contractId: c.id, status: "SUPERSEDED" } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { entityType: "Contract", entityId: c.id } })).toBe(audits0);
  });

  test("a clean batch supersedes the prior band, creates the new entries, and audits the real counts (unknown SKUs reported, not written)", async () => {
    const c = await mkContract({ number: "KN18b", type: "LOCAL", accountId: acct.id, entries: [A, B].map((p) => ({ productId: p.id, price: "90" })) });
    const r = await addContractEntries(mgr.actor, c.id, [{ sku: A.sku, price: "80" }, { sku: B.sku, price: "70", minQty: "100" }, { sku: `${RUN}-NOPE`, price: "1" }, { sku: C.sku, price: 60 }]);
    expect(r).toEqual({ created: 3, superseded: 1, unknown: [`${RUN}-NOPE`.toUpperCase()] });
    // A's band (no band) was superseded; B's new row is a different band (minQty 100) so B keeps its unbanded 90 too.
    expect(await active(c.id)).toEqual(["A:80", "B:70", "B:90", "C:60"]);
    const old = await prisma.priceEntry.findFirst({ where: { contractId: c.id, productId: A.id, status: "SUPERSEDED" } });
    expect(old).not.toBeNull();
    expect(old!.effectiveTo).not.toBeNull(); // an entry that started earlier ends when the new one starts
    const ev = await prisma.auditEvent.findFirst({ where: { entityType: "Contract", entityId: c.id, action: "ENTRIES_CHANGED" }, orderBy: { at: "desc" } });
    const after = JSON.parse(ev!.afterJson!);
    expect(after.created).toBe(3);
    expect(after.superseded).toBe(1);
    expect(after.unknown).toEqual([`${RUN}-NOPE`.toUpperCase()]);
    expect(after.entries.map((e: { sku: string }) => e.sku)).toEqual([A.sku, B.sku, C.sku]);
  });

  test("two simultaneous batches for the same band never leave two ACTIVE entries; the later commit wins and supersedes the earlier", async () => {
    const c = await mkContract({ number: "KN18c", type: "LOCAL", accountId: acct.id, entries: [{ productId: A.id, price: "90" }] });
    const results = await Promise.allSettled([
      addContractEntries(mgr.actor, c.id, [{ sku: A.sku, price: "81" }, { sku: B.sku, price: "51" }]),
      addContractEntries(mgr.actor, c.id, [{ sku: A.sku, price: "82" }, { sku: B.sku, price: "52" }]),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const rows = await prisma.priceEntry.findMany({ where: { contractId: c.id, productId: A.id } });
    expect(rows.filter((e) => e.status === "ACTIVE").length).toBe(1);
    expect(rows.length).toBe(3); // original + two batches, two of them superseded
    const rowsB = await prisma.priceEntry.findMany({ where: { contractId: c.id, productId: B.id } });
    expect(rowsB.filter((e) => e.status === "ACTIVE").length).toBe(1);
    // The first batch to commit superseded the original A (1); the second, having waited on the row
    // lock, saw the first batch's A and B as prior ACTIVE and superseded both (2).
    const counts = (results as PromiseFulfilledResult<{ superseded: number }>[]).map((r) => r.value.superseded).sort();
    expect(counts).toEqual([1, 2]);
  });

  test("validation is complete before any write: bad rows, wrong currency, band inversion, dates, duplicates, terminated contracts, permission", async () => {
    const c = await mkContract({ number: "KN18d", type: "LOCAL", accountId: acct.id, entries: [{ productId: A.id, price: "90" }] });
    const bad: [unknown, RegExp][] = [
      [[{ sku: A.sku, price: "80" }, { sku: "", price: "1" }], /every entry needs a sku/],
      [[{ sku: A.sku, price: "abc" }], /must be a number/],
      [[{ sku: A.sku, price: "NaN" }], /must be a number/],
      [[{ sku: A.sku, price: "0" }], /must be positive/],
      [[{ sku: A.sku, price: "-5" }], /must be positive/],
      [[{ sku: A.sku, price: "1000000001" }], /exceeds the supported range/],
      [[{ sku: A.sku, price: "80", currency: "EUR" }], /is in EUR but the contract is in USD/],
      [[{ sku: A.sku, price: "80", currency: "dollars" }], /not a 3-letter code/],
      [[{ sku: A.sku, price: "80", minQty: "10", maxQty: "5" }], /maxQty below minQty/],
      [[{ sku: A.sku, price: "80", minQty: "-1" }], /cannot be negative/],
      [[{ sku: A.sku, price: "80", effectiveFrom: "2026-02-01", effectiveTo: "2026-01-01" }], /effectiveTo before effectiveFrom/],
      [[{ sku: A.sku, price: "80", effectiveFrom: "not a date" }], /not a date/],
      [[{ sku: A.sku, price: "80" }, { sku: A.sku.toLowerCase(), price: "81" }], /duplicate entry/],
      [[], /empty/],
      ["nope", /must be a list/],
      [Array.from({ length: 5001 }, () => ({ sku: A.sku, price: "1" })), /at most 5,000/],
    ];
    for (const [rows, re] of bad) await expect(addContractEntries(mgr.actor, c.id, rows)).rejects.toThrow(re);
    expect((await prisma.priceEntry.findMany({ where: { contractId: c.id } })).map((e) => `${e.status}:${e.price}`)).toEqual(["ACTIVE:90"]);
    await expect(addContractEntries(rep.actor, c.id, [{ sku: A.sku, price: "80" }])).rejects.toThrow(/edit_contract_pricing/);
    await prisma.contract.update({ where: { id: c.id }, data: { status: "TERMINATED" } });
    await expect(addContractEntries(mgr.actor, c.id, [{ sku: A.sku, price: "80" }])).rejects.toThrow(/terminated contract/);
    await expect(addContractEntries(mgr.actor, "nope", [{ sku: A.sku, price: "80" }])).rejects.toThrow(/contract not found/);
    // Pure validation defaults: tier and effectiveTo fall back to the contract's.
    const v = validateEntryRows([{ sku: " a ", price: 5 }], { currency: "USD", tier: "Tier 2", effectiveTo: day("2030-01-01") }, day("2026-01-01"));
    expect(v[0]).toMatchObject({ sku: "A", tier: "Tier 2", currency: "USD" });
    expect(v[0].to?.toISOString()).toBe(day("2030-01-01").toISOString());
    expect(v[0].from.toISOString()).toBe(day("2026-01-01").toISOString());
  });

  test("neon-http (no transactions) is refused up front rather than half-written", async () => {
    const prev = process.env.DATABASE_ADAPTER;
    process.env.DATABASE_ADAPTER = "neon-http";
    try {
      expect(entriesAdapterSupported().ok).toBe(false);
      const c = await mkContract({ number: "KN18e", type: "LOCAL", accountId: acct.id });
      await expect(addContractEntries(mgr.actor, c.id, [{ sku: A.sku, price: "80" }])).rejects.toThrow(/cannot open transactions/);
      expect(await prisma.priceEntry.count({ where: { contractId: c.id } })).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_ADAPTER; else process.env.DATABASE_ADAPTER = prev;
    }
    expect(entriesAdapterSupported().ok).toBe(true);
  });
});

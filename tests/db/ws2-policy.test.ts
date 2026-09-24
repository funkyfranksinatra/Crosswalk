/**
 * WS2 — pricing policy repository: versioning, invalid drafts rejected, and the activation race
 * (two drafts for one family activated at the same moment → exactly one ACTIVE).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { draftPolicy, activatePolicy, activePolicies, policyFor } from "@/lib/pricing/policy";
import { RUN, mkUser, cleanupRun } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("WS2 policy — repository", () => {
  let admin: Awaited<ReturnType<typeof mkUser>>;
  const FAM = `${RUN} race family`;
  beforeAll(async () => { await cleanupRun(); admin = await mkUser("admin", ["ADMIN"]); });
  afterAll(async () => { await cleanupRun(); });

  test("drafts are versioned per family and merged over the last version; invalid definitions are rejected before any write", async () => {
    const v1 = await draftPolicy(admin.row.id, { productFamily: FAM, targetMarginPct: 0.5, minMarginPct: 0.3 });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe("DRAFT");
    const v2 = await draftPolicy(admin.row.id, { productFamily: FAM, minMarginPct: 0.35 });
    expect(v2.version).toBe(2);
    expect(v2.targetMarginPct.toString()).toBe("0.5"); // carried from v1
    expect(v2.minMarginPct.toString()).toBe("0.35");
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, minMarginPct: 0.6 })).rejects.toThrow(/minimum margin 0.6 is above target margin 0.5/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, floorMethod: "PCT_OF_LIST" })).rejects.toThrow(/PCT_OF_LIST floor needs floorParams.pctOfList/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, floorMethod: "FIXED", floorParams: {} })).rejects.toThrow(/FIXED floor needs floorParams.fixed/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, authority: { SALES_REP: 0.2, REGIONAL_MANAGER: 0.1, CONTRACTING_MANAGER: 0.3, PRICING_DIRECTOR: 0.4, PRICING_COMMITTEE: 1 } })).rejects.toThrow(/must not shrink up the chain/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, authority: { CFO: 0.5 } })).rejects.toThrow(/unknown role CFO/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, approvalRules: [{ when: { belowFloor: true }, require: "CFO" }] })).rejects.toThrow(/unknown role CFO/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, approvalRules: [] })).rejects.toThrow(/no approval rule covers pricing below floor/);
    await expect(draftPolicy(admin.row.id, { productFamily: FAM, targetMarginPct: 1.2 } as never)).rejects.toThrow(/Invalid policy: targetMarginPct/);
    await expect(draftPolicy(admin.row.id, { productFamily: "" } as never)).rejects.toThrow(/Invalid policy: productFamily/);
    expect(await prisma.pricingPolicy.count({ where: { productFamily: FAM } })).toBe(2);
  });

  test("activation supersedes the previous ACTIVE version in one step and pins the family; only a DRAFT can be activated", async () => {
    const rows = await prisma.pricingPolicy.findMany({ where: { productFamily: FAM }, orderBy: { version: "asc" } });
    await activatePolicy(admin.row.id, rows[0].id);
    expect((await prisma.pricingPolicy.findUniqueOrThrow({ where: { id: rows[0].id } })).status).toBe("ACTIVE");
    await activatePolicy(admin.row.id, rows[1].id);
    const after = await prisma.pricingPolicy.findMany({ where: { productFamily: FAM }, orderBy: { version: "asc" } });
    expect(after.map((r) => r.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    expect(after[0].supersededAt).not.toBeNull();
    expect(policyFor(await activePolicies(), FAM).id).toBe(rows[1].id);
    expect(policyFor(await activePolicies(), FAM.toUpperCase()).id).toBe(rows[1].id); // family lookup is case-insensitive
    // A superseded version cannot be re-activated (a rollback is a new draft), nor the active one again.
    await expect(activatePolicy(admin.row.id, rows[0].id)).rejects.toThrow(/only a DRAFT policy can be activated/);
    await expect(activatePolicy(admin.row.id, rows[1].id)).rejects.toThrow(/only a DRAFT policy can be activated/);
    await expect(activatePolicy(admin.row.id, "no-such-policy")).rejects.toThrow(/policy not found/);
    expect(await prisma.pricingPolicy.count({ where: { productFamily: FAM, status: "ACTIVE" } })).toBe(1);
  });

  test("activation race: two drafts for the same family activated concurrently → exactly one ACTIVE, every time", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await draftPolicy(admin.row.id, { productFamily: FAM, name: `A${round}` });
      const b = await draftPolicy(admin.row.id, { productFamily: FAM, name: `B${round}` });
      const results = await Promise.allSettled([activatePolicy(admin.row.id, a.id), activatePolicy(admin.row.id, b.id)]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const active = await prisma.pricingPolicy.findMany({ where: { productFamily: FAM, status: "ACTIVE" } });
      expect(active.length, `round ${round}: ${active.map((p) => p.name).join(",")}`).toBe(1);
      expect([a.id, b.id]).toContain(active[0].id);
      // Whichever lost is SUPERSEDED (activated then superseded) or still DRAFT (refused) — never a second ACTIVE.
      const loser = await prisma.pricingPolicy.findUniqueOrThrow({ where: { id: active[0].id === a.id ? b.id : a.id } });
      expect(["SUPERSEDED", "DRAFT"]).toContain(loser.status);
    }
  });
});

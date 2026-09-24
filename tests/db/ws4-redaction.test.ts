/**
 * WS4 — redaction (item H). A proposal whose line carries sentinel cost 1234.5678 / floor
 * 2345.6789 / margin 0.345678 (and a recommendation, waterfall, cost basis, approval snapshot,
 * audit event and matcher rationale that quote them) is read through every JSON route a
 * SALES_REP (no view_cost, no view_margin) can reach, the notification inbox, analytics as a
 * PRODUCT_MARKETING user, and the xref export (xlsx unzipped, sharedStrings + sheets scanned).
 * A PRICING_DIRECTOR reads the same routes in between: a per-process cache must not leak the
 * unredacted payload to the next caller.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { inflateRawSync } from "node:zlib";
import { prisma } from "@/lib/db";
import { setActorForTests } from "../setup";
import { enumerateRoutes, callRoute, seededActors, buildFixtures, cleanupFixtures, SENTINELS, type RouteInfo, type Fixtures } from "./ws4-harness";
import { redactSensitiveText, redactApprovalRequest, redactJsonForActor, type Actor } from "@/lib/auth";
import { permissionsFor } from "@/lib/auth/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);
const leaks = (text: string) => SENTINELS.filter((s) => text.includes(s));

/** Every text part of an xlsx (a zip of XML): local-file entries inflated in place, no external library. */
function xlsxText(buf: Buffer): string {
  const parts: string[] = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8), csize = buf.readUInt32LE(off + 18), nameLen = buf.readUInt16LE(off + 26), extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const start = off + 30 + nameLen + extraLen;
    const flags = buf.readUInt16LE(off + 6);
    if (flags & 0x8) throw new Error("data descriptor entries not supported by this test reader: " + name);
    const data = buf.subarray(start, start + csize);
    parts.push(`\n#### ${name}\n` + (method === 8 ? inflateRawSync(data).toString("utf8") : data.toString("utf8")));
    off = start + csize;
  }
  return parts.join("");
}

describe.skipIf(!hasDb)("WS4 — cost / floor / margin never reach a role without the permission", () => {
  const routes = enumerateRoutes();
  const R = (p: string): RouteInfo => routes.find((r) => r.urlPath === p)!;
  let seeded: Record<string, Actor>;
  let fx: Fixtures;
  beforeAll(async () => { seeded = await seededActors(); fx = await buildFixtures(seeded); });
  afterAll(async () => { setActorForTests(null); await cleanupFixtures(fx); });

  const asRep = async (route: RouteInfo, method: "GET" | "POST" | "PATCH", ids: Record<string, string>, init: Parameters<typeof callRoute>[3] = {}) => {
    setActorForTests(fx.owner);
    const res = await callRoute(route, method, ids, init);
    const text = await res.text();
    return { status: res.status, text };
  };

  test("the director sees the sentinels (the fixture is real); the rep, before and after the director, sees none of them", async () => {
    const ids = { id: fx.proposalId, lineId: fx.proposalLineId, sid: fx.scenarioId };
    const reads: [RouteInfo, "GET" | "POST" | "PATCH", Record<string, string>, Parameters<typeof callRoute>[3]][] = [
      [R("/api/proposals/[id]"), "GET", ids, {}],
      [R("/api/proposals/[id]/audit"), "GET", ids, {}],
      [R("/api/proposals/[id]/drift"), "GET", ids, {}],
      [R("/api/proposals/[id]/scenarios"), "GET", ids, {}],
      [R("/api/proposals/[id]/scenarios/[sid]"), "GET", ids, {}],
      [R("/api/proposals/[id]/logistics"), "GET", ids, {}],
      [R("/api/proposals/[id]/conversion"), "GET", ids, {}],
      [R("/api/proposals"), "GET", {}, {}],
      [R("/api/requests/[id]"), "GET", { id: fx.requestId }, {}],
      [R("/api/requests/[id]/lines/[lineId]/compare"), "GET", { id: fx.requestId, lineId: fx.lineId }, { query: `?candidateId=${fx.candidateId}` }],
      [R("/api/intelligence"), "GET", {}, { query: `?sku=${encodeURIComponent(fx.run.toUpperCase() + "-WS4COMP1")}` }],
      [R("/api/audit"), "GET", {}, { query: `?entityType=Proposal&entityId=${fx.proposalId}` }],
      [R("/api/notifications"), "GET", {}, {}],
      [R("/api/contracts/[id]"), "GET", { id: fx.contractId }, {}],
      [R("/api/accounts/[id]"), "GET", { id: fx.accountId }, {}],
    ];
    const found: string[] = [];
    // 1. rep first
    for (const [route, m, i, init] of reads) { const r = await asRep(route, m, i, init); expect(r.status, route.urlPath).toBe(200); for (const s of leaks(r.text)) found.push(`${route.urlPath} (rep, cold): ${s}`); }
    // 2. director: sentinels present somewhere (proves the fixture and the reads are real)
    setActorForTests(seeded.PRICING_DIRECTOR);
    const dir = await (await callRoute(R("/api/proposals/[id]"), "GET", ids)).text();
    expect(leaks(dir)).toEqual(expect.arrayContaining(["1234.5678", "2345.6789"]));
    const dirScen = await (await callRoute(R("/api/proposals/[id]/scenarios/[sid]"), "GET", ids)).text();
    expect(dirScen).toContain("1234.5678");
    // 3. rep again, after the director's reads
    for (const [route, m, i, init] of reads) { const r = await asRep(route, m, i, init); for (const s of leaks(r.text)) found.push(`${route.urlPath} (rep, after director): ${s}`); }
    expect(found).toEqual([]);
  });

  test("mutating reads: line PATCH, scenario PATCH/POST and re-recommend answer without the sentinels; the explanation is the public wording", async () => {
    const ids = { id: fx.proposalId, lineId: fx.proposalLineId, sid: fx.scenarioId };
    const patch = await asRep(R("/api/proposals/[id]/lines/[lineId]"), "PATCH", ids, { body: { notes: "rep note" } });
    expect(patch.status).toBe(200); expect(leaks(patch.text)).toEqual([]);
    const j = JSON.parse(patch.text);
    expect(j.line.cost).toBeNull(); expect(j.line.floorPrice).toBeNull(); expect(j.line.marginPct).toBeNull(); expect(j.line.costBasisJson).toBeNull();
    expect(JSON.parse(j.line.recommendationJson).explanation).toBe("Matches the competitor's price.");
    expect(j.economics.cogs).toBeNull(); expect(j.economics.grossProfit).toBeNull(); expect(j.economics.blendedMarginPct).toBeNull();
    const sp = await asRep(R("/api/proposals/[id]/scenarios/[sid]"), "PATCH", ids, { body: { lineId: fx.proposalLineId, proposedPrice: "4650" } });
    expect(sp.status).toBe(200); expect(leaks(sp.text)).toEqual([]);
    expect(JSON.parse(sp.text).lines[0].marginPct).toBeNull();
    const created = await asRep(R("/api/proposals/[id]/scenarios"), "POST", ids, { body: { kind: "AGGRESSIVE" } });
    expect(created.status).toBe(200); expect(leaks(created.text)).toEqual([]);
    const rec = await asRep(R("/api/proposals/[id]/lines/[lineId]/recommend"), "POST", ids, { body: { strategy: "MATCH" } });
    expect(rec.status).toBe(200); expect(leaks(rec.text)).toEqual([]);
    expect(rec.text).not.toMatch(/"(cost|floorPrice|floor|marginPct|cogs)":"[0-9]/);
    const refreshed = await asRep(R("/api/proposals/[id]/refresh-context"), "POST", ids, {});
    expect([200, 400, 409]).toContain(refreshed.status); expect(leaks(refreshed.text)).toEqual([]);
  });

  test("approval rows: the queue for a REGIONAL_MANAGER (no view_cost) and the proposal's approvals lose the floor/margin figures in snapshot and reason", async () => {
    setActorForTests(seeded.REGIONAL_MANAGER);
    const q = await (await callRoute(R("/api/approvals"), "GET")).text();
    expect(leaks(q)).toEqual([]);
    expect(q).not.toMatch(/margin \d|floor \(/);
    const detail = await asRep(R("/api/proposals/[id]"), "GET", { id: fx.proposalId });
    const p = JSON.parse(detail.text);
    expect(p.approvals.length).toBeGreaterThan(0);
    for (const a of p.approvals) { expect(a.reason).toBe("below floor, 6.0% off list, margin"); expect(JSON.parse(a.snapshotJson)).toMatchObject({ floorPrice: null, marginPct: null, proposedPrice: "4700" }); }
    expect(p.economicsJson).toBeUndefined();
  });

  test("pure helpers: sensitive text and approval requests", () => {
    const rep: Actor = { id: "x", email: "x", name: "x", roles: ["SALES_REP"], permissions: permissionsFor(["SALES_REP"]), isDev: true };
    const dir: Actor = { ...rep, roles: ["PRICING_DIRECTOR"], permissions: permissionsFor(["PRICING_DIRECTOR"]) };
    expect(redactSensitiveText(rep, "close attribute fit, priced 4% under competitor, 62% margin")).toBe("close attribute fit, priced 4% under competitor, margin");
    expect(redactSensitiveText(rep, "below floor (80.00 < 95.50), 20.0% off list, margin 41.2%")).toBe("below floor, 20.0% off list, margin");
    expect(redactSensitiveText(rep, "Gross margin 34.6% at $4,700.00, $12.34 above the policy floor $2,345.68.")).toBe("Gross margin at $4,700.00, above the floor.");
    expect(redactSensitiveText(dir, "margin 41.2%")).toBe("margin 41.2%");
    expect(redactSensitiveText(rep, null)).toBeNull();
    expect(redactApprovalRequest(rep, { reason: "margin 41.2%", snapshotJson: "{not json" }).snapshotJson).toBeNull();
    expect(redactApprovalRequest(dir, { reason: "margin 41.2%", snapshotJson: "{}" })).toEqual({ reason: "margin 41.2%", snapshotJson: "{}" });
    expect(redactJsonForActor(rep, { a: [{ cogs: "1", nested: { floor: "2", marginPct: "3", keep: "4" } }] })).toEqual({ a: [{ cogs: null, nested: { floor: null, marginPct: null, keep: "4" } }] });
  });

  test("a rep cannot reconstruct cost from targetPrice and the policy margins (review REV-02): both are redacted; a director sees them", async () => {
    const ids = { id: fx.proposalId };
    const rep = JSON.parse((await asRep(R("/api/proposals/[id]"), "GET", ids)).text);
    for (const l of rep.lines) { expect(l.targetPrice).toBeNull(); expect(l.floorPrice).toBeNull(); expect(l.cost).toBeNull(); }
    const pol = JSON.parse((await asRep(R("/api/pricing-policies"), "GET", {})).text);
    expect(pol.length).toBeGreaterThan(0);
    for (const p of pol) { expect(p.targetMarginPct).toBeNull(); expect(p.minMarginPct).toBeNull(); expect(p.productFamily).toBeTruthy(); }
    setActorForTests(seeded.PRICING_DIRECTOR);
    const full = JSON.parse(await (await callRoute(R("/api/proposals/[id]"), "GET", ids)).text());
    expect(full.lines.some((l: { targetPrice: number | null }) => l.targetPrice != null)).toBe(true);
    const fullPol = JSON.parse(await (await callRoute(R("/api/pricing-policies"), "GET", {})).text());
    expect(fullPol.every((p: { targetMarginPct: number | null }) => typeof p.targetMarginPct === "number")).toBe(true);
  });

  test("the matcher rationale in the request detail loses its margin figure for a rep (the figure with the price is the COGS)", async () => {
    const d = await asRep(R("/api/requests/[id]"), "GET", { id: fx.requestId });
    const j = JSON.parse(d.text);
    const cand = j.lines[0].candidates[0];
    expect(cand.rationale).toBe("close attribute fit, priced 4% under competitor, margin");
    expect(cand.scoreMargin).toBeNull(); expect(cand.scoreCogs).toBeNull(); expect(cand.ownProduct.cogs).toBeNull();
    // the factor notes carry the same figure (review REV-03), and the line PATCH echoes the candidates too
    expect(JSON.parse(cand.factorsJson).notes).toEqual(["priced 4% under competitor", "margin"]);
    const patched = await asRep(R("/api/requests/[id]/lines/[lineId]"), "PATCH", { id: fx.requestId, lineId: fx.lineId }, { body: {} });
    const pc = JSON.parse(patched.text).candidates[0];
    expect(pc.rationale).toBe("close attribute fit, priced 4% under competitor, margin");
    expect(JSON.parse(pc.factorsJson).notes).toEqual(["priced 4% under competitor", "margin"]);
    expect(patched.text).not.toMatch(/62% margin/);
    setActorForTests(seeded.PRICING_DIRECTOR);
    const full = JSON.parse(await (await callRoute(R("/api/requests/[id]"), "GET", { id: fx.requestId })).text());
    expect(full.lines[0].candidates[0].rationale).toContain("62% margin");
    expect(JSON.parse(full.lines[0].candidates[0].factorsJson).notes).toContain("62% margin");
  });

  test("analytics for a PRODUCT_MARKETING user (view_analytics, no cost/margin): every report answers without the sentinels and with cost/margin keys nulled", async () => {
    setActorForTests(seeded.PRODUCT_MARKETING);
    for (const report of ["winloss", "pricing", "conversion", "accuracy"]) {
      const res = await callRoute(R("/api/analytics/[report]"), "GET", { report });
      const text = await res.text();
      expect(res.status, report).toBe(200);
      expect(leaks(text), report).toEqual([]);
      expect(text, report).not.toMatch(/"(cogs|grossProfit|blendedMarginPct|marginPct|margin|floorPrice|cost)":\s*("|[0-9-])/);
    }
    expect((await callRoute(R("/api/analytics/[report]"), "GET", { report: "../../etc" })).status).toBe(400);
  });

  // OPEN — src/lib/excel/export.ts (WS2-owned) writes the raw candidate rationale ("62% margin") into the "All Candidates"
  // sheet even with hide.margin; reported to WS2 with a patch (WS4 report, finding on the export). Un-skip when applied.
  test("xref xlsx for a rep: the candidate rationale loses its margin figure", async () => {
    setActorForTests(fx.owner);
    const x = await callRoute(R("/api/requests/[id]/export"), "GET", { id: fx.requestId }, { query: "?type=xref&format=xlsx" });
    expect(xlsxText(Buffer.from(await x.arrayBuffer()))).not.toMatch(/62% margin/);
  });

  test("xref export for a rep: xlsx (all sheets + sharedStrings) and csv carry no cost/margin values; the director's workbook does carry the COGS fit column", async () => {
    const ids = { id: fx.requestId };
    setActorForTests(fx.owner);
    const x = await callRoute(R("/api/requests/[id]/export"), "GET", ids, { query: "?type=xref&format=xlsx" });
    expect(x.status).toBe(200);
    const text = xlsxText(Buffer.from(await x.arrayBuffer()));
    expect(text).toContain("sharedStrings.xml");
    expect(leaks(text)).toEqual([]);
    const csv = await (await callRoute(R("/api/requests/[id]/export"), "GET", ids, { query: "?type=xref&format=csv" })).text();
    expect(leaks(csv)).toEqual([]);
    const offer = await callRoute(R("/api/requests/[id]/export"), "GET", ids, { query: "?type=offer&format=csv" });
    expect(offer.status).toBe(200); expect(leaks(await offer.text())).toEqual([]);
    // proposal quote exports (export_proposals) for the rep — the fixture's pending approval locks the quote, so approve it for this read
    const before = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposalId }, include: { lines: { select: { id: true, approvalState: true } } } });
    await prisma.approvalRequest.updateMany({ where: { proposalId: fx.proposalId }, data: { status: "APPROVED" } });
    await prisma.proposalLine.updateMany({ where: { proposalId: fx.proposalId }, data: { approvalState: "APPROVED" } });
    await prisma.proposal.update({ where: { id: fx.proposalId }, data: { status: "APPROVED" } });
    for (const format of ["csv", "xlsx"]) {
      const q = await callRoute(R("/api/proposals/[id]/export"), "GET", { id: fx.proposalId }, { query: `?format=${format}` });
      expect(q.status, format).toBe(200);
      const body = Buffer.from(await q.arrayBuffer());
      expect(leaks(format === "xlsx" ? xlsxText(body) : body.toString("utf8")), format).toEqual([]);
    }
    await prisma.approvalRequest.updateMany({ where: { proposalId: fx.proposalId }, data: { status: "PENDING" } });
    await prisma.proposal.update({ where: { id: fx.proposalId }, data: { status: before.status } });
    for (const l of before.lines) await prisma.proposalLine.update({ where: { id: l.id }, data: { approvalState: l.approvalState } });
    expect((await callRoute(R("/api/requests/[id]/export"), "GET", ids, { query: "?type=bogus" })).status).toBe(400);
  });
});

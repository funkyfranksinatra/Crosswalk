/**
 * Tier 3 (product and scale) — database-backed behaviour tests. Each case pins something the
 * Tier 3 work must hold: a shortlist that comes from embedding neighbours (and falls back),
 * analytics that are served from snapshots, a delegate who can decide but never approve by
 * proxy, tax that never touches margin, public awards that import idempotently, bulk actions
 * that only touch qualifying lines, and a branded PDF that renders.
 *
 * Needs DATABASE_URL with the demo seed and pgvector; no network — embeddings, AvaTax,
 * SAM.gov and USAspending are all injected.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { permissionsFor } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";
import { setFetchForTests } from "@/lib/gudid/http";
import { runScenario } from "../recorded/openfda-scenario";
import { runRequest } from "@/lib/pipeline/run";
import { getCompany } from "@/lib/settings";
import { money, ZERO } from "@/lib/money";
import { setEmbedderForTests, refreshEmbeddings, nearestOwnProducts, embeddingText, embeddingHash, pgvectorAvailable, ensureCompetitorEmbedding, EMBEDDING_DIMS, EMBEDDING_MODEL } from "@/lib/match/embeddings";
import { refreshSnapshots, readReport, STALE_AFTER_MS } from "@/lib/analytics/snapshots";
import { createDelegation, revokeDelegation, effectiveAuthority, authorityFor, delegatesFor, MAX_DELEGATION_DAYS } from "@/lib/approvals/delegation";
import { submitForApproval, decide, queueFor } from "@/lib/approvals/service";
import { createFromRequest, setProposedPrice, refreshEconomics } from "@/lib/proposals/service";
import { setProposalLogistics, calculateProposalTax, quoteTotals, computeFreight } from "@/lib/tax";
import { ManualTaxProvider } from "@/lib/tax/manual";
import { AvataxProvider, setAvataxFetchForTests } from "@/lib/tax/avatax";
import { pullSam, pullUsaspending, upsertAwards, ingestPublicAwards, importBidFileRows, sanitizeBidSettings, matchCompetitor, setBidFetchForTests, DEFAULT_BID_SETTINGS, listAwards } from "@/lib/intelligence/bids";
import { summaryFor } from "@/lib/intelligence";
import { buildQuotePdf, buildOfferPdf } from "@/lib/pdf";
import { renderDocument, pdfPageCount } from "@/lib/pdf/documents";
import { getBranding, saveBranding } from "@/lib/branding";
import { tenancyStatus } from "@/lib/tenancy";
import { POST as bulkRoute } from "@/app/api/requests/[id]/bulk/route";
import { GET as compareRoute } from "@/app/api/requests/[id]/lines/[lineId]/compare/route";

const hasDb = Boolean(process.env.DATABASE_URL);
const DIR = path.resolve(__dirname, "../recorded/openfda");
const strip = (url: string) => url.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "");
const CODES = ["1DLMC05", "SPMII", "1190500", "PPM1510X3", "1410015010"];

async function actor(email: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { roles: true } });
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}

/** Deterministic pseudo-embedding: tokens hashed into buckets, so similar text → nearby vectors. */
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map((t) => {
    const v = new Array<number>(EMBEDDING_DIMS).fill(0);
    for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { const h = createHash("md5").update(tok).digest(); for (let i = 0; i < 4; i++) v[h.readUInt16LE(i * 2) % EMBEDDING_DIMS] += 1; }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }));
}

async function makeRequest(tag: string, creator: Actor, codes = CODES) {
  const company = await getCompany();
  return prisma.request.create({ data: { companyId: company.id, reference: `TIER3-${tag}-${Date.now().toString(36)}`, accountNumber: "0001880967", accountName: "Memorial Sloan Kettering", useLlm: false, status: "queued", createdByUserId: creator.id, lines: { create: codes.map((c, i) => ({ lineNo: i + 1, rawCode: c, cfnNorm: c, quantity: 10 + i })) } } });
}

async function cleanup() {
  const reqs = await prisma.request.findMany({ where: { reference: { startsWith: "TIER3-" } }, select: { id: true } });
  const ids = reqs.map((r) => r.id);
  const props = await prisma.proposal.findMany({ where: { requestId: { in: ids } }, select: { id: true } });
  const lineIds = (await prisma.requestLine.findMany({ where: { requestId: { in: ids } }, select: { id: true } })).map((l) => l.id);
  await prisma.matchDecision.deleteMany({ where: { OR: [{ proposalLine: { proposalId: { in: props.map((p) => p.id) } } }, { requestLineId: { in: lineIds } }] } });
  await prisma.proposal.deleteMany({ where: { id: { in: props.map((p) => p.id) } } });
  await prisma.request.deleteMany({ where: { id: { in: ids } } });
  await prisma.knownCross.deleteMany({ where: { source: "rep", competitorCodeNorm: { in: CODES } } });
  await prisma.approvalDelegation.deleteMany({ where: { reason: { startsWith: "TIER3" } } });
  await prisma.notification.deleteMany({ where: { OR: [{ entityType: "ApprovalDelegation" }, { entityId: { in: ids } }] } });
  await prisma.publicAward.deleteMany({ where: { OR: [{ externalId: { startsWith: "T3-" } }, { source: "BIDFILE", externalId: { contains: "tier3" } }] } });
  await prisma.competitorPriceObservation.deleteMany({ where: { sourceType: "PUBLIC_BID_DB", sourceRef: { contains: "tier3" } } });
  await prisma.feedRun.deleteMany({ where: { feed: { startsWith: "bids-" } } });
  await prisma.analyticsSnapshot.deleteMany({ where: { trigger: "manual", report: { in: ["winloss", "pricing", "conversion", "accuracy"] } } });
  await prisma.setting.deleteMany({ where: { key: "bidIntel" } });
}

describe.skipIf(!hasDb)("Tier 3", () => {
  let rep: Actor, manager: Actor, director: Actor, analyst: Actor, admin: Actor;
  let vector = false;
  beforeAll(async () => {
    const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) as Record<string, string>;
    setFetchForTests(async (url) => {
      const key = strip(url); const file = index[key];
      if (!file) throw new Error(`unrecorded openFDA URL: ${key}`);
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { status: number; body: string };
      return new Response(rec.body, { status: rec.status, headers: { "content-type": "application/json" } });
    });
    await cleanup();
    await runScenario();
    [rep, manager, director, analyst, admin] = await Promise.all([actor("alex.rep@crosswalk.dev"), actor("maria.manager@crosswalk.dev"), actor("dana.director@crosswalk.dev"), actor("priya.analyst@crosswalk.dev"), actor("admin@crosswalk.dev")]);
    vector = await pgvectorAvailable();
    setEmbedderForTests(fakeEmbed);
  }, 120_000);
  afterAll(async () => { await cleanup(); setFetchForTests(null); setEmbedderForTests(null); setAvataxFetchForTests(null); setBidFetchForTests(null); });

  // ---- 3.5 embedding retrieval -------------------------------------------------------------
  describe("3.5 embedding retrieval", () => {
    test("embedding text is deterministic and the hash skips unchanged rows", async () => {
      const p = await prisma.ownProduct.findFirstOrThrow({ where: { sku: "PPM1510X3" } });
      const t1 = embeddingText(p), t2 = embeddingText({ ...p });
      expect(t1).toBe(t2); expect(t1).toContain("Catalog number: PPM1510X3");
      expect(embeddingHash(t1)).toBe(embeddingHash(t2));
      expect(embeddingHash(t1)).not.toBe(embeddingHash(t1 + " x"));
    });
    test("refreshEmbeddings writes vectors once, nearest neighbours rank the product's own text first", async () => {
      if (!vector) { console.warn("pgvector not installed locally; skipping"); return; }
      const hadKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-tier3-fake";
      try {
        const company = await getCompany();
        // Forget a few vectors so the sweep has work; only pending rows are scanned, oldest-embedded first.
        await prisma.$executeRawUnsafe(`UPDATE "OwnProduct" SET "embeddingHash" = NULL, "embeddedAt" = NULL WHERE "sku" IN ('PPM1510X3', 'PPM1106X3')`);
        const first = await refreshEmbeddings("OwnProduct", { limit: 60 });
        expect(first.scanned).toBeGreaterThan(0); expect(first.embedded).toBeGreaterThan(0);
        const again = await refreshEmbeddings("OwnProduct", { limit: 60 });
        expect(again.embedded).toBe(0); // unchanged text is not re-embedded
        expect(again.scanned).toBe(0); // …and nothing is pending any more
        // A row edited since it was embedded (Prisma bumps updatedAt) is picked up; unchanged text is re-stamped, not re-embedded.
        await prisma.$executeRawUnsafe(`UPDATE "OwnProduct" SET "updatedAt" = now() WHERE "sku" = 'PPM1510X3'`);
        const touched = await refreshEmbeddings("OwnProduct", { limit: 60 });
        expect(touched.scanned).toBe(1); expect(touched.embedded).toBe(0); expect(touched.unchanged).toBe(1);
        expect((await refreshEmbeddings("OwnProduct", { limit: 60 })).scanned).toBe(0);
        const p = await prisma.ownProduct.findFirstOrThrow({ where: { sku: "PPM1510X3" } });
        const rows = await prisma.$queryRawUnsafe<{ m: string | null }[]>(`SELECT "embeddingModel" AS m FROM "OwnProduct" WHERE id = $1`, p.id);
        expect(rows[0].m).toBe(EMBEDDING_MODEL);
        const [v] = await fakeEmbed([embeddingText(p)]);
        const near = await nearestOwnProducts(v, { companyId: company.id, k: 5 });
        expect(near[0]?.sku).toBe("PPM1510X3");
        expect(near[0].similarity).toBeGreaterThan(0.99);
        // Over-fetch for family filtering returns more rows than k (HNSW ef_search is raised to cover it).
        expect((await nearestOwnProducts(v, { companyId: company.id, k: 5, overfetch: 4 })).length).toBeGreaterThan(5);
        // Another company's catalog is never a neighbour.
        expect(await nearestOwnProducts(v, { companyId: "no-such-company", k: 5 })).toHaveLength(0);
      } finally { if (hadKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = hadKey; }
    });
    test("a run with embeddings on retrieves by neighbours and logs it; with embeddings off it scans — same selections for the curated lines", async () => {
      if (!vector) return;
      const hadKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-tier3-fake";
      try {
        await refreshEmbeddings("OwnProduct");
        const cps = await prisma.competitorProduct.findMany({ where: { cfnNorm: { in: CODES } } });
        for (const cp of cps) await ensureCompetitorEmbedding(cp);
        const a = await makeRequest("ann", rep);
        await runRequest(a.id);
        const ra = await prisma.request.findUniqueOrThrow({ where: { id: a.id }, include: { lines: { include: { candidates: { include: { ownProduct: true } } } } } });
        expect(ra.status).toBe("complete");
        const log = (JSON.parse(ra.logJson) as { m: string }[]).map((e) => e.m).join("\n");
        expect(log).toMatch(/Embedding retrieval on/);
        expect(log).toMatch(/Retrieval: \d+ line\(s\) by embedding neighbours/);
        process.env.EMBEDDINGS = "off";
        const b = await makeRequest("scan", rep);
        await runRequest(b.id);
        const rb = await prisma.request.findUniqueOrThrow({ where: { id: b.id }, include: { lines: { include: { candidates: { include: { ownProduct: true } } } } } });
        expect(rb.status).toBe("complete");
        expect((JSON.parse(rb.logJson) as { m: string }[]).map((e) => e.m).join("\n")).not.toMatch(/Embedding retrieval on/);
        const pick = (r: typeof ra) => Object.fromEntries(r.lines.map((l) => [l.cfnNorm, l.candidates.find((c) => c.id === l.selectedCandidateId)?.ownProduct.sku ?? null]));
        // Curated crosses are added regardless of retrieval, so the curated lines agree.
        const pa = pick(ra), pb = pick(rb);
        for (const code of ["1DLMC05", "PPM1510X3"]) expect(pa[code]).toBe(pb[code]);
      } finally { delete process.env.EMBEDDINGS; if (hadKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = hadKey; }
    }, 120_000);
  });

  // ---- 3.8 analytics snapshots -------------------------------------------------------------
  describe("3.8 analytics snapshots", () => {
    test("reports are served from the latest snapshot, computed live when missing, stale after the window", async () => {
      await prisma.analyticsSnapshot.deleteMany({ where: { report: { in: ["accuracy", "conversion"] } } }); // a worker's cron may have left fresh ones
      const live = await readReport("accuracy");
      expect(live.source).toBe("live"); expect(live.stale).toBe(false);
      const snap = await readReport("accuracy");
      expect(snap.source).toBe("snapshot"); expect(snap.ageMs).toBeLessThan(10_000);
      const res = await refreshSnapshots(["accuracy", "winloss"], "manual");
      expect(res.accuracy.ok).toBe(true); expect(res.winloss.ok).toBe(true);
      const old = await prisma.analyticsSnapshot.create({ data: { report: "conversion", json: JSON.stringify({ proposed: -1 }), computedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000), trigger: "manual" } });
      const served = await readReport<{ proposed: number }>("conversion");
      expect(served.stale).toBe(true); expect(served.data.proposed).toBe(-1);
      await prisma.analyticsSnapshot.delete({ where: { id: old.id } });
      const fresh = await readReport<{ proposed: number }>("conversion", { fresh: true });
      expect(fresh.source).toBe("live"); expect(fresh.data.proposed).toBeGreaterThanOrEqual(0);
      // History is capped.
      for (let i = 0; i < 30; i++) await prisma.analyticsSnapshot.create({ data: { report: "winloss", json: "{}", trigger: "manual" } });
      await refreshSnapshots(["winloss"], "manual");
      expect(await prisma.analyticsSnapshot.count({ where: { report: "winloss" } })).toBeLessThanOrEqual(24);
    });
  });

  // ---- 3.9 delegation ----------------------------------------------------------------------
  describe("3.9 approval delegation", () => {
    test("validation: not to yourself, window ≤ 90 days, only your own unless admin, delegator must have authority", async () => {
      const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await expect(createDelegation(director, { toUserId: director.id, endsAt: soon, reason: "TIER3" })).rejects.toThrow(/yourself/);
      await expect(createDelegation(director, { toUserId: manager.id, endsAt: new Date(Date.now() + (MAX_DELEGATION_DAYS + 2) * 86_400_000).toISOString(), reason: "TIER3" })).rejects.toThrow(/at most/);
      await expect(createDelegation(manager, { fromUserId: director.id, toUserId: admin.id, endsAt: soon, reason: "TIER3" })).rejects.toThrow(/admin/i);
      await expect(createDelegation(rep, { toUserId: manager.id, endsAt: soon, reason: "TIER3" })).rejects.toThrow(/no approval authority/);
      await expect(createDelegation(director, { toUserId: manager.id, endsAt: new Date(Date.now() - 86_400_000).toISOString(), reason: "TIER3" })).rejects.toThrow(/past|after/);
      // A delegate must already be an approver: a pricing analyst cannot be handed a queue.
      await expect(createDelegation(director, { toUserId: analyst.id, endsAt: soon, reason: "TIER3" })).rejects.toThrow(/cannot approve pricing/);
    });
    test("a delegate gains the delegator's authority (never ADMIN), sees the queue, decides on their behalf, and cannot approve by proxy what the delegator submitted", async () => {
      const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const d = await createDelegation(director, { toUserId: manager.id, endsAt: soon, reason: "TIER3 holiday" });
      expect(d.toUserId).toBe(manager.id);
      expect(await prisma.notification.count({ where: { userId: manager.id, entityType: "ApprovalDelegation", entityId: d.id } })).toBe(1);
      const eff = await effectiveAuthority(manager);
      expect(eff.roles).toContain("PRICING_DIRECTOR"); expect(eff.roles).not.toContain("ADMIN");
      expect(eff.permissions.has("approve_below_floor")).toBe(true); // lent by the director; the manager has none of their own
      expect((await authorityFor(manager, "PRICING_DIRECTOR")).onBehalfOf).toBe(director.id);
      expect((await authorityFor(manager, "REGIONAL_MANAGER")).onBehalfOf).toBeNull(); // own authority, no delegation involved
      // A lent PERMISSION is attributed too: a manager-level line that is below floor needs approve_below_floor, which only the director lends.
      expect((await authorityFor(manager, "REGIONAL_MANAGER", "approve_below_floor")).onBehalfOf).toBe(director.id);
      expect((await authorityFor(manager, "REGIONAL_MANAGER", "approve_below_floor", [director.id])).ok).toBe(false); // …and not for the director's own submissions
      expect((await delegatesFor("PRICING_DIRECTOR", true)).some((x) => x.toUserId === manager.id)).toBe(true);
      // Overlap refused; a second, disjoint window is fine.
      await expect(createDelegation(director, { toUserId: manager.id, endsAt: soon, reason: "TIER3 dup" })).rejects.toThrow(/overlapping/);

      // A director-level request: push a line far below list so it needs PRICING_DIRECTOR.
      const r = await makeRequest("deleg", rep, ["1DLMC05", "1410015010"]);
      await runRequest(r.id);
      const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
      const p = await createFromRequest(rep, r.id, { accountId: acc.id });
      const lines = await prisma.proposalLine.findMany({ where: { proposalId: p.id, included: true } });
      const l = lines[0];
      const base = money(l.contractPrice) ?? money(l.listPrice)!;
      await setProposedPrice(rep, l.id, base.times(0.68), "TIER3 deep discount"); // 32% off: director authority, unless the floor rules escalate
      await submitForApproval(rep, p.id);
      const req = await prisma.approvalRequest.findFirstOrThrow({ where: { proposalId: p.id, status: "PENDING" } });
      const q = await queueFor(manager);
      const mine = q.find((x) => x.id === req.id);
      if (req.requiredRole === "PRICING_COMMITTEE") {
        // Above the director's own authority: the delegation lends nothing here — the delegate must NOT see or decide it.
        expect(mine).toBeUndefined();
        await expect(decide(manager, req.id, "APPROVED", "TIER3")).rejects.toThrow(/authority|permission/);
      } else if (req.requiredRole === "REGIONAL_MANAGER") {
        // The manager's own authority covers it: no delegation is involved and none is recorded.
        expect(mine).toBeTruthy(); expect(mine!.onBehalfOf).toBeNull();
      } else {
        expect(mine).toBeTruthy();
        expect(mine!.onBehalfOf?.userId).toBe(director.id);
        const decided = await decide(manager, req.id, "APPROVED", "TIER3 approved for Dana");
        expect(["APPROVED", "PARTIALLY_APPROVED", "SUBMITTED"]).toContain(decided.status);
        const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
        expect(row.decidedByUserId).toBe(manager.id);
        expect(row.onBehalfOfUserId).toBe(director.id);
        const ev = await prisma.auditEvent.findFirst({ where: { entityType: "ApprovalRequest", entityId: req.id, action: "APPROVED" } });
        expect(ev?.contextJson).toContain(director.id);
      }

      // Proxy self-approval: the DIRECTOR submits; the delegate must not approve it with the director's authority.
      const r2 = await makeRequest("proxy", director, ["1DLMC05"]);
      await runRequest(r2.id);
      const p2 = await createFromRequest(director, r2.id, { accountId: acc.id });
      const l2 = (await prisma.proposalLine.findMany({ where: { proposalId: p2.id, included: true } }))[0];
      const base2 = money(l2.contractPrice) ?? money(l2.listPrice)!;
      // Director holds director authority, so most discounts auto-approve; a below-floor line needs committee. Route to committee by going very low.
      await setProposedPrice(director, l2.id, base2.times(0.05), "TIER3 proxy");
      const sub2 = await submitForApproval(director, p2.id);
      if (sub2.routed > 0) {
        const req2 = await prisma.approvalRequest.findFirstOrThrow({ where: { proposalId: p2.id, status: "PENDING" } });
        await expect(decide(manager, req2.id, "APPROVED", "TIER3")).rejects.toThrow(/cannot approve|authority|delegat|permission/i);
        expect((await queueFor(manager)).some((x) => x.id === req2.id)).toBe(false); // …and it is not in their queue
      }

      // Revoke: authority disappears at once.
      await revokeDelegation(director, d.id);
      expect((await effectiveAuthority(manager)).roles).not.toContain("PRICING_DIRECTOR");
      await expect(revokeDelegation(rep, d.id)).rejects.toThrow(/delegating user or an admin/); // a stranger cannot revoke
      await expect(revokeDelegation(director, d.id)).resolves.toBeTruthy(); // already revoked → no-op
    }, 120_000);
  });

  // ---- 3.7 tax and freight -----------------------------------------------------------------
  describe("3.7 tax and freight", () => {
    test("freight modes and the manual provider are exact decimal arithmetic", async () => {
      expect(computeFreight(money("1000")!, "FLAT", money("25.5"), "USD").toString()).toBe("25.5");
      expect(computeFreight(money("1000.005")!, "PCT", money("2.5"), "USD").toString()).toBe("25");
      expect(computeFreight(money("1000")!, "NONE", money("99"), "USD").toString()).toBe("0");
      const m = new ManualTaxProvider(money("0.0825")!);
      const r = await m.calculate({ currency: "USD", date: "2026-09-18", customerCode: "X", shipFrom: null, shipTo: { country: "US" }, lines: [{ number: "1", itemCode: "A", description: null, quantity: "3", amount: "100.10" }, { number: "2", itemCode: "B", description: null, quantity: "1", amount: "0.10" }], freight: { amount: "50" } });
      expect(r.totalTax).toBe("8.27"); // 8.25825 → 8.26 + 0.00825 → 0.01, line by line, freight untaxed by default
      expect(r.lines.find((l) => l.number === "FREIGHT")).toBeUndefined();
      const ex = await m.calculate({ currency: "USD", date: "2026-09-18", customerCode: "X", exemptionNo: "EX-1", shipFrom: null, shipTo: { country: "US" }, lines: [{ number: "1", itemCode: "A", description: null, quantity: "1", amount: "100" }] });
      expect(ex.totalTax).toBe("0"); expect(ex.note).toMatch(/Exempt/);
    });
    test("AvaTax adapter: request shape, response parsing, error surfacing, dry run — no network", async () => {
      const env = { AVATAX_ACCOUNT_ID: "acct", AVATAX_LICENSE_KEY: "key", AVATAX_COMPANY_CODE: "CW" };
      const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      try {
        let seen: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
        setAvataxFetchForTests(async (url, init) => {
          seen = { url, body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.authorization ?? null };
          return new Response(JSON.stringify({ id: 1, code: "abc", status: "Temporary", totalAmount: 1050, totalTax: 86.63, totalTaxable: 1050, totalExempt: 0, lines: [{ lineNumber: "1", tax: 82.5, taxableAmount: 1000, details: [{ jurisName: "CA", taxName: "CA STATE TAX", rate: 0.06, tax: 60 }, { jurisName: "LOS ANGELES", taxName: "CA COUNTY TAX", rate: 0.0225, tax: 22.5 }] }, { lineNumber: "FREIGHT", tax: 4.13, taxableAmount: 50, details: [{ rate: 0.0825 }] }], summary: [{ jurisName: "CALIFORNIA", taxName: "CA STATE TAX", rate: 0.06, tax: 63 }, { jurisName: "LOS ANGELES", taxName: "CA COUNTY TAX", rate: 0.0225, tax: 23.63 }] }), { status: 201, headers: { "content-type": "application/json" } });
        });
        const a = new AvataxProvider();
        expect(a.configured()).toBe(true);
        const r = await a.calculate({ currency: "USD", date: "2026-09-18", customerCode: "0001880967", shipFrom: { line1: "1 Main", city: "Minneapolis", region: "MN", postalCode: "55401", country: "US" }, shipTo: { line1: "2 Elm", city: "Los Angeles", region: "CA", postalCode: "90001", country: "US" }, lines: [{ number: "1", itemCode: "PPM1510X3", description: "mesh", quantity: "10", amount: "1000" }], freight: { amount: "50" } });
        expect(seen!.url).toMatch(/sandbox-rest\.avatax\.com\/api\/v2\/transactions\/create$/);
        expect(seen!.auth).toBe(`Basic ${Buffer.from("acct:key").toString("base64")}`);
        expect(seen!.body.type).toBe("SalesOrder"); expect(seen!.body.commit).toBe(false); expect(seen!.body.companyCode).toBe("CW");
        const lines = seen!.body.lines as { number: string; taxCode: string; amount: number }[];
        expect(lines.map((l) => l.number)).toEqual(["1", "FREIGHT"]); expect(lines[0].taxCode).toBe("P0000000"); expect(lines[1].taxCode).toBe("FR020100");
        expect(r.totalTax).toBe("86.63"); expect(r.lines[0].rate).toBeCloseTo(0.0825, 5); expect(r.summary).toHaveLength(2);
        setAvataxFetchForTests(async () => new Response(JSON.stringify({ error: { code: "AuthenticationException", message: "Authentication failed", details: [{ description: "The credentials are invalid" }] } }), { status: 401 }));
        await expect(a.calculate({ currency: "USD", date: "2026-09-18", customerCode: "X", shipFrom: null, shipTo: { postalCode: "90001" }, lines: [{ number: "1", itemCode: null, description: null, quantity: "1", amount: "1" }] })).rejects.toThrow(/AvaTax 401: Authentication failed — The credentials are invalid/);
        await expect(a.calculate({ currency: "USD", date: "2026-09-18", customerCode: "X", shipFrom: null, shipTo: { country: "US" }, lines: [] })).rejects.toThrow(/ship-to/);
        process.env.TAX_DRY_RUN = "true";
        setAvataxFetchForTests(async () => { throw new Error("must not be called in dry run"); });
        const dry = await a.calculate({ currency: "USD", date: "2026-09-18", customerCode: "X", shipFrom: null, shipTo: { postalCode: "90001" }, lines: [{ number: "1", itemCode: null, description: null, quantity: "1", amount: "10" }] });
        expect(dry.totalTax).toBe("0"); expect(dry.note).toMatch(/dry run/i);
      } finally { delete process.env.TAX_DRY_RUN; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } setAvataxFetchForTests(null); }
    });
    test("on a proposal: freight and tax change the quote total, never the economics; a price change makes tax stale; validation holds", async () => {
      const r = await makeRequest("tax", rep, ["1DLMC05", "1410015010"]);
      await runRequest(r.id);
      const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
      const p = await createFromRequest(rep, r.id, { accountId: acc.id });
      const econBefore = await refreshEconomics(p.id);
      await expect(setProposalLogistics(rep, p.id, { freightMode: "SHIP" })).rejects.toThrow(/freightMode/);
      await expect(setProposalLogistics(rep, p.id, { freightMode: "PCT", freightValue: "150" })).rejects.toThrow(/0–100/);
      await expect(setProposalLogistics(rep, p.id, { taxMode: "PROVIDER" })).rejects.toThrow(/AVATAX/);
      await expect(setProposalLogistics(rep, p.id, { taxMode: "MANUAL", taxRate: "0.9" })).rejects.toThrow(/fraction/);
      await expect(setProposalLogistics(analyst, p.id, { freightMode: "FLAT" })).resolves.toBeTruthy(); // analyst may edit pricing
      await expect(setProposalLogistics(await actor("exec@crosswalk.dev"), p.id, { freightMode: "FLAT" })).rejects.toThrow(/permission/i);
      await setProposalLogistics(rep, p.id, { freightMode: "FLAT", freightValue: "125", taxMode: "MANUAL", taxRate: "0.0825", shipTo: { line1: "1275 York Ave", city: "New York", region: "NY", postalCode: "10065" } });
      let t = await quoteTotals(p.id);
      expect(t.freight.toString()).toBe("125"); expect(t.tax).toBeNull(); expect(t.taxStale).toBe(true);
      const { result } = await calculateProposalTax(rep, p.id);
      expect(result.provider).toBe("manual");
      t = await quoteTotals(p.id);
      expect(t.tax!.gt(0)).toBe(true); expect(t.taxStale).toBe(false);
      expect(t.total.toString()).toBe(t.subtotal.plus(t.freight).plus(t.tax!).toString());
      const econAfter = await refreshEconomics(p.id);
      expect(econAfter.revenue.toString()).toBe(econBefore.revenue.toString());
      expect(econAfter.blendedMarginPct?.toString() ?? null).toBe(econBefore.blendedMarginPct?.toString() ?? null);
      // Writes that do not change what is quoted keep the figure: a note, an unchanged save, an economics refresh.
      const l = (await prisma.proposalLine.findMany({ where: { proposalId: p.id, included: true } }))[0];
      await prisma.proposalLine.update({ where: { id: l.id }, data: { customerNote: "TIER3 note", notes: "internal" } });
      await setProposalLogistics(rep, p.id, { freightMode: "FLAT", freightValue: "125", taxMode: "MANUAL", taxRate: "0.0825" });
      await refreshEconomics(p.id);
      t = await quoteTotals(p.id);
      expect(t.taxStale).toBe(false); expect(t.tax!.gt(0)).toBe(true);
      // A price change → stale tax; the PDF refuses until recalculated.
      await setProposedPrice(rep, l.id, (money(l.proposedPrice) ?? money(l.listPrice)!).times(0.98), "TIER3 tweak");
      t = await quoteTotals(p.id);
      expect(t.taxStale).toBe(true);
      // Freight is taxable in places: a freight change is stale too, and a mode switch re-checks the percent bound.
      await calculateProposalTax(rep, p.id);
      await setProposalLogistics(rep, p.id, { freightValue: "200" });
      expect((await quoteTotals(p.id)).taxStale).toBe(true);
      await expect(setProposalLogistics(rep, p.id, { freightMode: "PCT" })).rejects.toThrow(/0–100/); // 200 is not a percent
      // A country-only ship-to is no ship-to: the account default stays reachable.
      await setProposalLogistics(rep, p.id, { shipTo: { line1: "", city: "", region: "", postalCode: "", country: "US" } });
      expect((await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } })).shipToJson).toBeNull();
      // Exempt: zero, not stale, no provider call.
      await setProposalLogistics(rep, p.id, { taxMode: "EXEMPT", taxExemptionNo: "NY-EX-123" });
      t = await quoteTotals(p.id);
      expect(t.tax?.toString()).toBe("0"); expect(t.taxStale).toBe(false);
      expect(ZERO.eq(t.tax!)).toBe(true);
    }, 90_000);
  });

  // ---- 3.10 public bids --------------------------------------------------------------------
  describe("3.10 public bid intelligence", () => {
    const sam = { totalRecords: 2, limit: 1000, offset: 0, opportunitiesData: [
      { noticeId: "T3-SAM-1", title: "Surgical Staplers and Reloads", solicitationNumber: "36C24226Q0001", fullParentPathName: "VETERANS AFFAIRS, DEPARTMENT OF.VETERANS HEALTH ADMINISTRATION", postedDate: "2026-09-01", type: "Award Notice", naicsCode: "339112", classificationCode: "6515", award: { date: "2026-08-28", number: "36C24226P0100", amount: "184250.00", awardee: { name: "ETHICON US, LLC", ueiSAM: "ABC123" } }, uiLink: "https://sam.gov/opp/T3-SAM-1/view" },
      { noticeId: "T3-SAM-2", title: "Hernia mesh, various", fullParentPathName: "DEFENSE HEALTH AGENCY", postedDate: "2026-09-03", type: "Award Notice", naicsCode: "339113", award: { date: "2026-09-02", amount: 42000, awardee: { name: "Some Distributor Inc" } }, uiLink: "https://sam.gov/opp/T3-SAM-2/view" },
    ] };
    const usa = { results: [
      { internal_id: 1, "Award ID": "36C24226P0100", "Recipient Name": "APPLIED MEDICAL RESOURCES CORPORATION", "Award Amount": 99000.5, "Start Date": "2026-08-15", "Awarding Agency": "Department of Veterans Affairs", "Awarding Sub Agency": "VHA", Description: "TROCARS AND ACCESSORIES", NAICS: { code: "339112", description: "SURGICAL AND MEDICAL INSTRUMENT MANUFACTURING" }, PSC: { code: "6515", description: "MEDICAL AND SURGICAL INSTRUMENTS" }, generated_internal_id: "T3-CONT_AWD_1", recipient_id: "r-1" },
    ], page_metadata: { page: 1, hasNext: false } };
    test("settings sanitise; sources configure from the environment", async () => {
      const s = sanitizeBidSettings({ keywords: "trocar, hernia mesh;;bad<script>", naics: ["339112", "12", "abc"], psc: "6515, x1", lookbackDays: 900, minAmount: -5 });
      expect(s.keywords).toEqual(["trocar", "hernia mesh"]); expect(s.naics).toEqual(["339112", "12"]); expect(s.psc).toEqual(["6515", "X1"]); expect(s.lookbackDays).toBe(365); expect(s.minAmount).toBe(0);
      const { bidSourcesConfigured } = await import("@/lib/intelligence/bids");
      const had = process.env.SAM_API_KEY; delete process.env.SAM_API_KEY;
      expect(await bidSourcesConfigured()).toEqual(["usaspending"]);
      process.env.SAM_API_KEY = "k"; expect(await bidSourcesConfigured()).toEqual(["sam", "usaspending"]);
      if (had === undefined) delete process.env.SAM_API_KEY; else process.env.SAM_API_KEY = had;
    });
    test("SAM.gov and USAspending pulls map to awards, match competitors by name, and re-import idempotently", async () => {
      const calls: string[] = [];
      setBidFetchForTests(async (url, init) => {
        calls.push(url);
        if (url.includes("sam.gov")) { const u = new URL(url); expect(u.searchParams.get("ptype")).toBe("a"); expect(u.searchParams.get("postedFrom")).toMatch(/^\d{2}\/\d{2}\/\d{4}$/); expect(u.searchParams.get("api_key")).toBeNull(); expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key"); return new Response(JSON.stringify(sam), { status: 200 }); }
        const body = JSON.parse(String(init?.body)); expect(body.filters.award_type_codes).toEqual(["A", "B", "C", "D"]); expect(body.fields).toContain("generated_internal_id");
        if (body.filters.psc_codes) expect(body.filters.psc_codes.require[0][0]).toMatch(/^(Product|Service|Research and Development)$/); // hierarchical, or the API answers 422
        return new Response(JSON.stringify(usa), { status: 200 });
      });
      process.env.SAM_API_KEY = "test-key";
      const settings = { ...DEFAULT_BID_SETTINGS, naics: ["339112"], psc: ["6515"] };
      const { pscPath } = await import("@/lib/intelligence/bids");
      expect(pscPath("6515")).toEqual(["Product", "65", "6515"]); expect(pscPath("Q501")).toEqual(["Service", "Q", "Q5", "Q501"]); expect(pscPath("AC11")).toEqual(["Research and Development", "AC", "AC11"]);
      const s = await pullSam(settings, { from: new Date("2026-08-01"), to: new Date("2026-09-18") });
      expect(s).toHaveLength(2); expect(s[0].awardee).toBe("ETHICON US, LLC"); expect(s[0].awardDate?.toISOString().slice(0, 10)).toBe("2026-08-28");
      const u = await pullUsaspending(settings, { from: new Date("2026-08-01"), to: new Date("2026-09-18") });
      expect(u).toHaveLength(1); expect(u[0].url).toBe("https://www.usaspending.gov/award/T3-CONT_AWD_1"); expect(u[0].naics).toBe("339112");
      const first = await upsertAwards([...s, ...u], settings);
      expect(first.created).toBe(3); expect(first.matched).toBeGreaterThanOrEqual(1); // Ethicon / Applied Medical are seeded competitors
      const second = await upsertAwards([...s, ...u], settings);
      expect(second.created).toBe(0); expect(second.updated).toBe(3);
      const eth = await prisma.publicAward.findUniqueOrThrow({ where: { source_externalId: { source: "SAM", externalId: "T3-SAM-1" } } });
      expect(eth.competitorId).toBeTruthy(); expect(eth.keywordsMatched).toMatch(/NAICS 339112/); expect(eth.amount?.toString()).toBe("184250");
      const min = await upsertAwards(s, { ...settings, minAmount: 100_000 });
      expect(min.skipped).toBe(1);
      // The job path records a FeedRun.
      const run = await ingestPublicAwards("usaspending", { trigger: "manual", actorUserId: admin.id });
      expect(run.rows).toBe(1);
      const fr = await prisma.feedRun.findFirstOrThrow({ where: { feed: "bids-usaspending" }, orderBy: { startedAt: "desc" } });
      expect(fr.status).toBe("OK");
      expect(calls.filter((c) => c.includes("sam.gov")).length).toBe(1); // one call per NAICS by default
      setBidFetchForTests(async () => new Response("<html>gateway timeout</html>", { status: 504 }));
      await expect(ingestPublicAwards("sam", { trigger: "manual" })).rejects.toThrow(/504/);
      expect((await prisma.feedRun.findFirstOrThrow({ where: { feed: "bids-sam" }, orderBy: { startedAt: "desc" } })).status).toBe("FAILED");
      // A quota response fails the run but not the job (no retry storm against the daily allowance).
      setBidFetchForTests(async () => new Response("Too many requests", { status: 429 }));
      const quota = await ingestPublicAwards("sam", { trigger: "manual" });
      expect((quota as { quotaExceeded?: boolean }).quotaExceeded).toBe(true);
      expect((await prisma.feedRun.findFirstOrThrow({ where: { feed: "bids-sam" }, orderBy: { startedAt: "desc" } })).error).toMatch(/429/);
      delete process.env.SAM_API_KEY;
      const list = await listAwards({ q: "stapler", sinceDays: 3650 });
      expect(list.awards.some((a) => a.externalId === "T3-SAM-1")).toBe(true);
      expect((await listAwards({ q: "stapler", sinceDays: 1 })).awards.some((a) => a.externalId === "T3-SAM-1")).toBe(false); // both filters apply
      expect(await matchCompetitor("ETHICON US, LLC")).toBeTruthy();
      expect(await matchCompetitor("Bardot Medical Group")).toBeNull(); // no prefix matches
      expect(await matchCompetitor("Totally Unrelated LLC")).toBeNull();
    });
    test("a bid file with competitor codes and unit prices records public-bid price observations", async () => {
      const grid = [
        ["Source", "Bid Id", "Department", "Title", "Buyer", "Awardee", "Updated Date", "Award Date", "Amount", "Competitor", "Competitor Code", "Unit Price", "Qty", "Notes"],
        ["Texas SmartBuy tier3", "B-1", "Surgery", "Endomechanical supplies", "UT Southwestern", "Ethicon", "2026-09-01", "2026-07-01", "$55,000.00", "Ethicon", "PPM1510X3", "$41.25", 200, "line 4"],
        ["Texas SmartBuy tier3", "B-1", "Surgery", "Endomechanical supplies", "UT Southwestern", "Ethicon", "2026-09-01", "2026-07-01", 55000, "Ethicon", "NO MATCH", 10, 1, "placeholder row"],
        ["Texas SmartBuy tier3", "", "Surgery", "Trocar kit", "UT Southwestern", "Applied Medical", "", "not a date", "", "", "", "", "", ""],
      ];
      const res = await importBidFileRows(admin.id, grid, "tier3-file");
      expect(res.rows).toBe(3); expect(res.observations).toBe(1); expect(res.awards).toBeGreaterThanOrEqual(2);
      const obs = await prisma.competitorPriceObservation.findFirst({ where: { sourceType: "PUBLIC_BID_DB", competitorSku: "PPM1510X3" }, orderBy: { createdAt: "desc" } });
      expect(obs?.price.toString()).toBe("41.25"); expect(obs?.sourceRef).toMatch(/tier3 B-1/);
      expect(obs?.observedAt.toISOString().slice(0, 10)).toBe("2026-07-01"); // the award date, not "Updated Date"
      expect((await prisma.publicAward.findFirst({ where: { source: "BIDFILE", externalId: { contains: "B-1" } } }))?.amount?.toString()).toBe("55000");
      const summary = await summaryFor("PPM1510X3", { asOf: new Date(), accountId: null, gpoId: null, region: null, currency: "USD" });
      expect(summary.count).toBeGreaterThan(0);
    });
  });

  // ---- 3.1 / 3.2 bulk actions and compare ------------------------------------------------
  describe("3.1 / 3.2 bulk actions and side-by-side", () => {
    test("bulk actions touch only qualifying lines, record decisions, and refuse while a run is in progress", async () => {
      const r = await makeRequest("bulk", rep);
      await runRequest(r.id);
      const { setActorForTests } = await import("../setup");
      setActorForTests(rep);
      const post = (action: string) => bulkRoute(new Request("http://x/api", { method: "POST", body: JSON.stringify({ action }) }), { params: Promise.resolve({ id: r.id }) }).then((res) => res.json());
      const before = await prisma.requestLine.findMany({ where: { requestId: r.id }, include: { candidates: true } });
      const exact = before.filter((l) => l.candidates.find((c) => c.id === l.selectedCandidateId)?.matchType === "Exact Match").length;
      const rv = await post("review_exact");
      expect(rv.changed).toBe(exact);
      expect(await prisma.requestLine.count({ where: { requestId: r.id, reviewed: true } })).toBe(exact);
      expect(await prisma.matchDecision.count({ where: { requestLineId: { in: before.map((l) => l.id) }, acceptedTop: true } })).toBeGreaterThanOrEqual(exact);
      const fl = await post("flag_verify");
      const flagged = await prisma.requestLine.count({ where: { requestId: r.id, flag: "verify" } });
      expect(flagged).toBe(fl.changed);
      const again = await post("flag_verify");
      expect(again.changed).toBe(0); // idempotent
      await post("clear_flags");
      expect(await prisma.requestLine.count({ where: { requestId: r.id, flag: "verify" } })).toBe(0);
      await prisma.request.update({ where: { id: r.id }, data: { status: "running" } });
      const busy = await bulkRoute(new Request("http://x/api", { method: "POST", body: JSON.stringify({ action: "unreview_all" }) }), { params: Promise.resolve({ id: r.id }) });
      expect(busy.status).toBe(409);
      await prisma.request.update({ where: { id: r.id }, data: { status: "complete" } });
      const bad = await bulkRoute(new Request("http://x/api", { method: "POST", body: JSON.stringify({ action: "delete_everything" }) }), { params: Promise.resolve({ id: r.id }) });
      expect(bad.status).toBe(400);
      setActorForTests(null);
    }, 90_000);
    test("side-by-side returns GUDID and bin rows for the competitor and the candidate, flagging differences", async () => {
      const r = await makeRequest("cmp", rep, ["1DLMC05", "PPM1510X3"]);
      await runRequest(r.id);
      const { setActorForTests } = await import("../setup");
      setActorForTests(rep);
      const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r.id, selectedCandidateId: { not: null } } });
      const res = await compareRoute(new Request(`http://x/api?candidateId=${line.selectedCandidateId}`), { params: Promise.resolve({ id: r.id, lineId: line.id }) });
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.rows.length).toBeGreaterThan(10);
      expect(j.rows.map((x: { attribute: string }) => x.attribute)).toContain("Family");
      expect(j.competitor.gudidUrl ?? j.ours.gudidUrl).toBeTruthy();
      expect(typeof j.similarity?.score === "number" || j.similarity === null).toBe(true);
      const other = await prisma.requestLine.findFirstOrThrow({ where: { NOT: { requestId: r.id } } });
      expect((await compareRoute(new Request("http://x/api"), { params: Promise.resolve({ id: r.id, lineId: other.id }) })).status).toBe(404);
      setActorForTests(null);
    }, 60_000);
  });

  // ---- 3.3 / 3.4 notes and PDFs ------------------------------------------------------------
  describe("3.3 / 3.4 customer notes and branded PDFs", () => {
    test("a request line's customer note reaches the proposal line and the quote; the internal justification never does", async () => {
      const r = await makeRequest("note", rep, ["1DLMC05", "1410015010"]);
      await runRequest(r.id);
      const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r.id, selectedCandidateId: { not: null } } });
      await prisma.requestLine.update({ where: { id: line.id }, data: { customerNote: "TIER3 same platform; trim to size", overrideNote: "internal: rep preferred" } });
      const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
      const p = await createFromRequest(rep, r.id, { accountId: acc.id });
      const pl = await prisma.proposalLine.findFirstOrThrow({ where: { proposalId: p.id, competitorCode: line.rawCode } });
      expect(pl.customerNote).toBe("TIER3 same platform; trim to size");
      await prisma.proposalLine.update({ where: { id: pl.id }, data: { justification: "TIER3 INTERNAL premium case" } });
      const { quoteRows } = await import("@/lib/proposals/export");
      const q = await quoteRows(p.id);
      const flat = JSON.stringify(q.rows);
      expect(flat).toContain("TIER3 same platform"); expect(flat).not.toContain("INTERNAL premium");
    }, 60_000);
    test("branding is validated and the quote / offer PDFs render with letterhead, totals and terms", async () => {
      const before = await getBranding();
      await expect(saveBranding({ primaryColor: "red" })).rejects.toThrow(/hex/);
      await expect(saveBranding({ logoDataUrl: "data:text/plain;base64,QUJD" })).rejects.toThrow(/PNG or JPEG/);
      await expect(saveBranding({ logoDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).rejects.toThrow(/PNG or JPEG/);
      await expect(saveBranding({ validityDays: 0 })).rejects.toThrow(/validityDays/);
      // 1×1 PNG
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const b = await saveBranding({ legalName: "TIER3 Medical Devices Inc", address: { line1: "710 Medtronic Pkwy", city: "Minneapolis", region: "MN", postalCode: "55432" }, primaryColor: "#123456", logoDataUrl: png, footer: "Confidential", validityDays: 45 });
      expect(b.address?.city).toBe("Minneapolis"); expect(b.logoDataUrl).toBe(png);
      try {
        const r = await makeRequest("pdf", rep, ["1DLMC05", "1410015010"]);
        await runRequest(r.id);
        const offer = await buildOfferPdf(rep, r.id);
        expect(offer.contentType).toBe("application/pdf"); expect(offer.buffer.subarray(0, 5).toString()).toBe("%PDF-"); expect(offer.buffer.length).toBeGreaterThan(2000);
        expect(pdfPageCount(offer.buffer)).toBe(1); // a two-line offer is one page: the footer must not spill onto blank pages
        expect(offer.filename).toMatch(/Contract_Offer/);
        const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
        const p = await createFromRequest(rep, r.id, { accountId: acc.id });
        await expect(buildQuotePdf(rep, p.id)).rejects.toThrow(/locked until approval/);
        // Approve the draft the simple way: everything within rep authority.
        const sub = await submitForApproval(rep, p.id);
        if (sub.status !== "APPROVED") { for (const a of await prisma.approvalRequest.findMany({ where: { proposalId: p.id, status: "PENDING" } })) await decide(await actor("committee@crosswalk.dev"), a.id, "APPROVED", "TIER3"); }
        await setProposalLogistics(admin, p.id, { freightMode: "PCT", freightValue: "3", taxMode: "MANUAL", taxRate: "0.07" });
        await expect(buildQuotePdf(rep, p.id)).rejects.toThrow(/recalculate/);
        await calculateProposalTax(admin, p.id);
        const quote = await buildQuotePdf(rep, p.id);
        expect(quote.buffer.subarray(0, 5).toString()).toBe("%PDF-"); expect(quote.filename).toMatch(/Crosswalk_Quote_/);
        const exported = await prisma.auditEvent.findFirst({ where: { entityType: "Proposal", entityId: p.id, action: "EXPORTED" }, orderBy: { at: "desc" } });
        expect(exported?.contextJson).toContain('"pdf"');
        // The renderer paginates: 120 lines still produce a document.
        const big = await renderDocument({ kind: "quote", title: "Quotation", reference: "PRP-BIG", customer: { name: "X" }, date: new Date(), lines: Array.from({ length: 120 }, (_, i) => ({ code: `C${i}`, codeDescription: "competitor item with a fairly long description that wraps onto more than one line", sku: `S${i}`, description: "our item", qty: "1", unit: "10", extended: "10", note: i % 7 === 0 ? "note" : null })), totals: { currency: "USD", subtotal: "1200", total: "1200" }, notes: ["n"], terms: "t\n\nt2", branding: b });
        expect(big.length).toBeGreaterThan(10_000);
        const pages = pdfPageCount(big);
        expect(pages).toBeGreaterThanOrEqual(3); expect(pages).toBeLessThanOrEqual(8);
      } finally { await saveBranding({ ...before, address: before.address ?? null, logoDataUrl: before.logoDataUrl ?? null, footer: before.footer ?? null }); }
    }, 120_000);
  });

  // ---- 3.6 tenancy -------------------------------------------------------------------------
  describe("3.6 tenancy", () => {
    test("single tenant is reported; a stray second company is flagged, never served", async () => {
      const ok = await tenancyStatus();
      expect(ok.mode).toBe("single"); expect(ok.company?.name).toBeTruthy();
      const stray = await prisma.company.create({ data: { name: "TIER3 Stray Co" } });
      try {
        const t = await tenancyStatus();
        expect(t.ok).toBe(false); expect(t.note).toMatch(/extra company/); expect(t.company?.id).toBe(ok.company?.id);
      } finally { await prisma.company.delete({ where: { id: stray.id } }); }
    });
  });
});

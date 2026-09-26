/**
 * Tier 1 (pilot quality) — database-backed behaviour tests. Every case here pins a failure
 * mode the Tier 1 work was meant to close: a run lost to a restart, a rate-limited import,
 * a stale GUDID record, a rep's correction thrown away, a feed nobody re-imported, a draft
 * pricing off last month's contract, a notification that never reached anyone.
 *
 * Needs DATABASE_URL with the demo seed (users, MSK account, demo SKUs); no network — the
 * resolver replays recorded openFDA responses. Skipped without a database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { permissionsFor } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";
import { setFetchForTests } from "@/lib/gudid/http";
import { runScenario } from "../recorded/openfda-scenario";
import { runRequest, enqueueRun, cancelRun, RunCancelled, RunInterrupted } from "@/lib/pipeline/run";
import { proposeCross } from "@/lib/xref/governance";
import { getBoss, enqueue, queueHealth, recentFailures, stopBoss } from "@/lib/jobs/boss";
import { startWorkers } from "@/lib/jobs/workers";
import { refreshStaleRecords } from "@/lib/gudid/refresh";
import { recordLineDecision, crossesForMatching } from "@/lib/xref/learning";
import { ingestFeed, feedStatuses } from "@/lib/feeds";
import { notify, notifyApprovalRequested, preferencesFor, setPreference, inboxFor, markRead } from "@/lib/notifications";
import { deliver, setTransportsForTests } from "@/lib/notifications/deliver";
import { evaluateAlerts, modelRule, feedRule, RULES } from "@/lib/observability/alerts";
import { driftFor, refreshContext } from "@/lib/proposals/drift";
import { createFromRequest, setProposedPrice } from "@/lib/proposals/service";
import { submitForApproval, decide } from "@/lib/approvals/service";
import { sizeCoverage } from "@/lib/catalog/size-coverage";
import { runBenchmark, type BenchmarkCase } from "@/lib/eval/benchmark";
import { parseIntakeCsv } from "@/lib/excel/intake";
import { getCompany } from "@/lib/settings";
import { render } from "@/lib/observability/metrics";
import { money } from "@/lib/money";

const hasDb = Boolean(process.env.DATABASE_URL);
const DIR = path.resolve(__dirname, "../recorded/openfda");
const strip = (url: string) => url.replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "");

async function actor(email: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { roles: true } });
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}

const CODES = ["1DLMC05", "SPMII", "1190500", "PPM1510X3", "1410015010"];

async function makeRequest(tag: string, creator: Actor, codes = CODES) {
  const company = await getCompany();
  return prisma.request.create({ data: { companyId: company.id, reference: `TIER1-${tag}-${Date.now().toString(36)}`, accountNumber: "0001880967", accountName: "Memorial Sloan Kettering", useLlm: false, status: "queued", createdBy: creator.name, createdByUserId: creator.id, lines: { create: codes.map((c, i) => ({ lineNo: i + 1, rawCode: c, cfnNorm: c, quantity: 10 + i })) } } });
}

async function cleanup() {
  const reqs = await prisma.request.findMany({ where: { reference: { startsWith: "TIER1-" } }, select: { id: true } });
  const ids = reqs.map((r) => r.id);
  const props = await prisma.proposal.findMany({ where: { requestId: { in: ids } }, select: { id: true } });
  await prisma.matchDecision.deleteMany({ where: { OR: [{ proposalLine: { proposalId: { in: props.map((p) => p.id) } } }, { requestLineId: { in: (await prisma.requestLine.findMany({ where: { requestId: { in: ids } }, select: { id: true } })).map((l) => l.id) } }] } });
  await prisma.proposal.deleteMany({ where: { id: { in: props.map((p) => p.id) } } });
  await prisma.request.deleteMany({ where: { id: { in: ids } } });
  await prisma.knownCross.deleteMany({ where: { source: "rep", competitorCodeNorm: { in: CODES } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: "TIER1" } }, { entityType: "TIER1" }, { entityId: { in: ids } }] } });
  await prisma.alert.deleteMany({ where: { OR: [{ fingerprint: { startsWith: "tier1" } }, { fingerprint: { contains: "tier1x" } }] } });
  await prisma.feedRun.deleteMany({ where: { feed: { in: ["pricing", "crm"] }, OR: [{ sourceRef: "pricing.csv" }, { sourceRef: null }] } });
  await prisma.llmCall.deleteMany({ where: { subject: "tier1-test" } });
  await prisma.priceEntry.deleteMany({ where: { contract: { contractNumber: "TIER1-LOCAL" } } });
  await prisma.contract.deleteMany({ where: { contractNumber: "TIER1-LOCAL" } });
  await prisma.benchmarkRun.deleteMany({ where: { label: "tier1-test" } });
}

describe.skipIf(!hasDb)("Tier 1", () => {
  let rep: Actor, manager: Actor, admin: Actor;
  beforeAll(async () => {
    process.env.JOBS_WORKER = "inline";
    const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) as Record<string, string>;
    setFetchForTests(async (url) => {
      const key = strip(url);
      const file = index[key];
      if (!file) throw new Error(`unrecorded openFDA URL: ${key}`);
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { status: number; body: string };
      return new Response(rec.body, { status: rec.status, headers: { "content-type": "application/json" } });
    });
    await cleanup();
    await runScenario(); // warms the CompetitorProduct cache from the recordings, so runs never call the network
    [rep, manager, admin] = await Promise.all([actor("alex.rep@crosswalk.dev"), actor("maria.manager@crosswalk.dev"), actor("admin@crosswalk.dev")]);
  }, 120_000);
  afterAll(async () => { await cleanup(); await stopBoss().catch(() => undefined); setFetchForTests(null); setTransportsForTests(null); });

  // ---- 1.1 job queue ----------------------------------------------------------------------
  describe("1.1 job queue", () => {
    test("a run goes through the queue, completes, checkpoints every stage and notifies its creator", async () => {
      await startWorkers();
      const r = await makeRequest("queue", rep);
      const { jobId, alreadyQueued } = await enqueueRun(r.id);
      expect(jobId).toBeTruthy(); expect(alreadyQueued).toBe(false);
      const again = await enqueueRun(r.id);
      expect(again.alreadyQueued).toBe(true); // singleton: no second job while one is queued
      let row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      for (let i = 0; i < 120 && !["complete", "failed"].includes(row.status); i++) { await new Promise((x) => setTimeout(x, 500)); row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } }); }
      expect(row.status).toBe("complete");
      expect(row.checkpoint).toBe("match");
      expect(row.attempt).toBe(1);
      expect(row.jobId).toBe(jobId);
      expect(await prisma.matchCandidate.count({ where: { line: { requestId: r.id } } })).toBeGreaterThan(0);
      // The run sets "complete" and then notifies (the notification reads the final status), so the
      // row can land a moment after the status is visible — wait for it, bounded, instead of racing it
      // (a slow CI runner lost that race on Sept 26).
      let n = await prisma.notification.findFirst({ where: { userId: rep.id, kind: "RUN_COMPLETE", entityId: r.id } });
      for (let i = 0; i < 40 && !n; i++) { await new Promise((x) => setTimeout(x, 250)); n = await prisma.notification.findFirst({ where: { userId: rep.id, kind: "RUN_COMPLETE", entityId: r.id } }); }
      expect(n?.title).toMatch(/is ready/);
      const boss = await getBoss();
      const job = await boss.getJobById("request.run", jobId!);
      expect(job?.state).toBe("completed");
    }, 90_000);

    test("a retried run resumes after its checkpoint instead of resolving everything again", async () => {
      const r = await makeRequest("resume", rep);
      await runRequest(r.id, { attempt: 1 });
      // Simulate a crash after the resolve stage: checkpoint says "resolve", status still running.
      await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "resolve" } });
      await runRequest(r.id, { attempt: 2 });
      const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      const log = (JSON.parse(row.logJson) as { m: string }[]).map((l) => l.m);
      expect(row.status).toBe("complete");
      expect(row.attempt).toBe(2);
      expect(log.some((m) => /Resumed \(attempt 2\)/.test(m))).toBe(true);
      expect(log.some((m) => /Resolution stage already complete/.test(m))).toBe(true);
      // Orphan recovery after a restart is a NEW job (attempt 1) that must still resume.
      await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "bin" } });
      await runRequest(r.id, { attempt: 1, resume: true });
      const row2 = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      const log2 = (JSON.parse(row2.logJson) as { m: string }[]).map((l) => l.m);
      expect(row2.status).toBe("complete");
      expect(log2.filter((m) => /Resumed \(attempt \d+\)/.test(m)).length).toBe(2);
      expect(row2.attempt).toBe(3); // attempts are monotonic across retries and restarts
    }, 60_000);

    test("a fresh run (attempt 1) never resumes, even if a stale checkpoint is on the row", async () => {
      const r = await makeRequest("fresh", rep);
      await prisma.request.update({ where: { id: r.id }, data: { checkpoint: "bin" } });
      await runRequest(r.id, { attempt: 1 });
      const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      const log = (JSON.parse(row.logJson) as { m: string }[]).map((l) => l.m);
      expect(log.some((m) => /Resumed/.test(m))).toBe(false);
      expect(row.status).toBe("complete");
    }, 60_000);

    test("cancelling: a queued run is cancelled outright; a running run stops at a checkpoint and keeps the previous results", async () => {
      const r = await makeRequest("cancel", rep);
      await runRequest(r.id); // previous complete run → candidates exist
      const before = await prisma.matchCandidate.count({ where: { line: { requestId: r.id } } });
      expect(before).toBeGreaterThan(0);
      // Running path: request cancellation before the run starts → RunCancelled at the first checkpoint.
      await prisma.request.update({ where: { id: r.id }, data: { cancelRequested: true, status: "running" } });
      await runRequest(r.id);
      let row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("cancelled");
      expect(row.cancelRequested).toBe(false);
      expect(await prisma.matchCandidate.count({ where: { line: { requestId: r.id } } })).toBe(before);
      const q = await cancelRun(r.id);
      expect(q.cancelled).toBe(false); // nothing to cancel any more
      expect(new RunCancelled().name).toBe("RunCancelled");
    }, 60_000);

    test("an aborted signal (queue expiry / shutdown) is an interruption: status and checkpoint stay for the retry, nobody is told it was cancelled", async () => {
      const r = await makeRequest("abort", rep);
      await runRequest(r.id);
      await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "resolve" } });
      const ac = new AbortController(); ac.abort();
      await expect(runRequest(r.id, { signal: ac.signal, attempt: 2 })).rejects.toBeInstanceOf(RunInterrupted);
      const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("running");
      expect(row.checkpoint).toBe("resolve");
      expect(row.stage).toMatch(/Interrupted/);
      expect(await prisma.notification.count({ where: { entityId: r.id, kind: { in: ["RUN_FAILED", "RUN_COMPLETE"] }, title: { contains: "cancelled" } } })).toBe(0);
      // A cancel flag set while the row says running is honoured by the very next attempt before any work.
      await prisma.request.update({ where: { id: r.id }, data: { cancelRequested: true } });
      await runRequest(r.id, { attempt: 3 });
      expect((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("cancelled");
    }, 60_000);

    test("enqueueRun on a request with a live job is a no-op; on an orphan it re-queues without wiping the checkpoint", async () => {
      const r = await makeRequest("noop", rep);
      // Orphan: says running, has a checkpoint, no job → re-queued to resume.
      await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "bin", stage: "Binning" } });
      const res = await enqueueRun(r.id);
      expect(res.alreadyQueued).toBe(false); expect(res.resumed).toBe(true);
      let row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("queued"); expect(row.checkpoint).toBe("bin"); expect(row.jobId).toBe(res.jobId);
      // Live job now exists → a second call is a no-op that changes nothing.
      const again = await enqueueRun(r.id);
      expect(again.alreadyQueued).toBe(true);
      row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.checkpoint).toBe("bin"); expect(row.jobId).toBe(res.jobId);
      const boss = await getBoss();
      await boss.cancel("request.run", res.jobId!);
      await prisma.request.update({ where: { id: r.id }, data: { status: "draft", checkpoint: null } });
    });

    test("a failing attempt that the queue will retry stays 'running' and says so; the final attempt fails the run, tells the creator, and never shows raw driver text", async () => {
      const r = await makeRequest("fail", rep);
      await prisma.request.update({ where: { id: r.id }, data: { optionsJson: "{not json" } });
      await expect(runRequest(r.id, { attempt: 1, finalAttempt: false })).rejects.toThrow();
      let row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("queued"); // the retry is queued; the reason is on the stage
      expect(row.stage).toMatch(/Attempt 1 failed — retrying/);
      expect(await prisma.notification.count({ where: { entityId: r.id, kind: "RUN_FAILED" } })).toBe(0);
      await expect(runRequest(r.id, { attempt: 3, finalAttempt: true })).rejects.toThrow();
      row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("failed");
      expect(row.error).toBeTruthy();
      expect(row.error).not.toMatch(/Invalid `prisma|PrismaClient/);
      const log = (JSON.parse(row.logJson) as { m: string }[]).map((l) => l.m);
      expect(log.some((m) => /Attempt 1 failed, will retry/.test(m))).toBe(true);
      expect(log.some((m) => /^Failed:/.test(m))).toBe(true);
      expect(await prisma.notification.count({ where: { userId: rep.id, entityId: r.id, kind: "RUN_FAILED" } })).toBe(1);
    }, 30_000);

    test("two concurrent enqueues of the same request create exactly one job", async () => {
      const r = await makeRequest("race", rep);
      await prisma.request.update({ where: { id: r.id }, data: { status: "draft" } });
      const results = await Promise.all([enqueueRun(r.id), enqueueRun(r.id), enqueueRun(r.id)]);
      const created = results.filter((x) => x.jobId);
      expect(created).toHaveLength(1);
      expect(results.filter((x) => x.alreadyQueued)).toHaveLength(2);
      const boss = await getBoss();
      await boss.cancel("request.run", created[0].jobId!);
      await prisma.request.update({ where: { id: r.id }, data: { status: "draft" } });
    });

    test("the run log survives 250 concurrent appends: valid JSON, last 200 kept, nothing lost to a read-modify-write", async () => {
      const r = await makeRequest("log", rep);
      const { runRequest: _rr } = await import("@/lib/pipeline/run");
      void _rr;
      // The pipeline's log() is module-private; exercise it through the same SQL by running a real run and then hammering the row.
      await Promise.all(Array.from({ length: 250 }, (_, i) => prisma.$executeRawUnsafe(
        `UPDATE "Request" SET "logJson" = (SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb)::text FROM (SELECT e, n FROM jsonb_array_elements((CASE WHEN "logJson" ~ '^\\s*\\[' THEN "logJson"::jsonb ELSE '[]'::jsonb END) || $2::jsonb) WITH ORDINALITY AS t(e, n) ORDER BY n DESC LIMIT 200) AS last) WHERE id = $1`,
        r.id, JSON.stringify([{ t: new Date().toISOString(), m: `line ${i}` }]),
      )));
      const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
      const entries = JSON.parse(row.logJson) as { m: string }[];
      expect(entries).toHaveLength(200);
      expect(new Set(entries.map((e) => e.m)).size).toBe(200); // every kept line is a distinct append
      // Chronological: a real run's log must read oldest → newest after trimming.
      await runRequest(r.id);
      const log = (JSON.parse((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).logJson) as { m: string }[]).map((e) => e.m);
      expect(log.indexOf(log.find((m) => /^Run started/.test(m))!)).toBeLessThan(log.indexOf(log.find((m) => /^Matched/.test(m))!));
    }, 60_000);

    test("queue health reports counts; recent failures are readable", async () => {
      const h = await queueHealth();
      expect(h.map((q) => q.name)).toContain("request.run");
      expect(Array.isArray(await recentFailures(5))).toBe(true);
    });
  });

  // ---- 1.2 openFDA cache TTL ---------------------------------------------------------------
  describe("1.2 GUDID cache expiry", () => {
    test("a stale record is re-checked: unchanged version only stamps gudidCheckedAt; a changed version updates the row and clears its bin", async () => {
      const cp = await prisma.competitorProduct.findUniqueOrThrow({ where: { cfnNorm: "1DLMC05" } });
      const old = new Date(Date.now() - 200 * 86_400_000);
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { resolvedAt: old, gudidCheckedAt: null, binJson: JSON.stringify({ family: "Hernia Mesh" }) } });
      const rec = JSON.parse(cp.gudidJson!) as { public_version_date?: string; identifiers?: { id: string; type: string }[] };
      const di = rec.identifiers?.find((i) => i.type === "Primary")?.id ?? rec.identifiers?.[0]?.id;
      expect(di).toBe(cp.gudidDi);
      // Replay: the DI lookup answers with the same version → no change.
      setFetchForTests(async (url) => new Response(JSON.stringify({ meta: { results: { total: 1 } }, results: [rec] }), { status: 200 }));
      let rep = await refreshStaleRecords({ cfnNorm: "1DLMC05" });
      expect(rep).toMatchObject({ checked: 1, changed: 0, missing: 0 });
      let row = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: cp.id } });
      expect(row.gudidCheckedAt).toBeTruthy();
      expect(row.binJson).not.toBeNull();
      // A newer version with a new description → row refreshed, bin cleared, note appended.
      const changed = { ...rec, public_version_date: "2099-01-01", device_description: "GORE DUALMESH BIOMATERIAL 7.5cmX10cm (renamed)" };
      setFetchForTests(async () => new Response(JSON.stringify({ meta: { results: { total: 1 } }, results: [changed] }), { status: 200 }));
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { gudidCheckedAt: old } });
      rep = await refreshStaleRecords({ cfnNorm: "1DLMC05" });
      expect(rep.changed).toBe(1);
      row = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: cp.id } });
      expect(row.binJson).toBeNull();
      expect(row.description).toMatch(/renamed/);
      expect(row.resolutionNote).toMatch(/updated on refresh/);
      // Gone from GUDID → kept, noted, never deleted.
      setFetchForTests(async () => new Response("", { status: 404 }));
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { gudidCheckedAt: old } });
      rep = await refreshStaleRecords({ cfnNorm: "1DLMC05" });
      expect(rep.missing).toBe(1);
      row = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: cp.id } });
      expect(row.resolutionNote).toMatch(/no longer found/);
      // Restore the original record and the recorded fetch for later tests.
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { gudidJson: cp.gudidJson, description: cp.description, resolutionNote: cp.resolutionNote, gudidCheckedAt: new Date() } });
      const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) as Record<string, string>;
      setFetchForTests(async (url) => { const f = index[strip(url)]; if (!f) throw new Error(`unrecorded ${strip(url)}`); const r = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); return new Response(r.body, { status: r.status }); });
    });
  });

  // ---- 1.3 learning loop -------------------------------------------------------------------
  describe("1.3 learning loop", () => {
    test("an override becomes a DRAFT rep cross with evidence; the same choice again endorses it; undoing retires it; the matcher sees it as a prior", async () => {
      const r = await makeRequest("learn", rep, ["1DLMC05", "1410015010"]);
      await runRequest(r.id);
      const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r.id, lineNo: 1 }, include: { candidates: { orderBy: { rank: "asc" } } } });
      expect(line.candidates.length).toBeGreaterThanOrEqual(2);
      const second = line.candidates[1];
      const learned = await recordLineDecision(rep, line.id, { selectedCandidateId: second.id, overrideNote: "TIER1 surgeon prefers this one" });
      expect(learned.proposedCrossId).toBeTruthy();
      const k = await prisma.knownCross.findUniqueOrThrow({ where: { id: learned.proposedCrossId! } });
      expect(k.approvalStatus).toBe("DRAFT"); expect(k.source).toBe("rep"); expect(k.createdByUserId).toBe(rep.id);
      expect(JSON.parse(k.evidenceJson!)).toMatchObject({ endorsements: 1 });
      const d = await prisma.matchDecision.findFirstOrThrow({ where: { requestLineId: line.id }, orderBy: { at: "desc" } });
      expect(d.acceptedTop).toBe(false);
      expect(d.overrideReason).toMatch(/surgeon/);
      // Reviewers were told.
      const reviewer = await prisma.user.findUniqueOrThrow({ where: { email: "dr.clinical@crosswalk.dev" } });
      expect(await prisma.notification.count({ where: { userId: reviewer.id, kind: "CROSS_PROPOSED", entityId: k.id } })).toBe(1);
      // The same rep toggling the same line again is NOT new evidence; a manager choosing it on another list is.
      const toggle = await recordLineDecision(rep, line.id, { selectedCandidateId: second.id });
      expect(toggle.proposedCrossId).toBe(k.id);
      expect(JSON.parse((await prisma.knownCross.findUniqueOrThrow({ where: { id: k.id } })).evidenceJson!)).toMatchObject({ endorsements: 1 });
      const r2 = await makeRequest("learn2", manager, ["1DLMC05"]);
      await runRequest(r2.id);
      const line2b = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r2.id }, include: { candidates: { orderBy: { rank: "asc" } } } });
      const sameSku = line2b.candidates.find((c) => c.ownProductId === second.ownProductId)!;
      const again = await recordLineDecision(manager, line2b.id, { selectedCandidateId: sameSku.id });
      expect(again.proposedCrossId).toBe(k.id);
      expect(JSON.parse((await prisma.knownCross.findUniqueOrThrow({ where: { id: k.id } })).evidenceJson!)).toMatchObject({ endorsements: 2 });
      expect(await prisma.knownCross.count({ where: { competitorCodeNorm: "1DLMC05", source: "rep" } })).toBe(1);
      // The matcher loads it as a prior (not approved) — and an approved cross with full weight.
      const forMatch = await crossesForMatching();
      const mine = forMatch.find((x) => x.id === k.id)!;
      expect(mine.approvalStatus).toBe("DRAFT"); expect(mine.endorsements).toBe(2);
      // Undo by the rep does not retire a cross someone else also chose.
      const undo = await recordLineDecision(rep, line.id, { selectedCandidateId: line.candidates[0].id });
      expect(undo.retiredCrossId).toBeUndefined();
      // "Reviewed" with no new selection judges the CURRENT selection (the top pick) → acceptedTop ground truth.
      const ok = await recordLineDecision(rep, line.id, { reviewed: true });
      expect(ok.decisionId).toBeTruthy();
      const dd = await prisma.matchDecision.findUniqueOrThrow({ where: { id: ok.decisionId! } });
      expect(dd.acceptedTop).toBe(true); expect(dd.chosenSku).toBe((await prisma.ownProduct.findUniqueOrThrow({ where: { id: line.candidates[0].ownProductId } })).sku);
      // Once under review, a rep cannot change its tier by re-proposing; it only gains evidence.
      await prisma.knownCross.update({ where: { id: k.id }, data: { approvalStatus: "IN_REVIEW" } });
      await expect(proposeCross(rep.id, { ownSku: k.ownSku, competitorName: k.competitorName, competitorCode: k.competitorCode, matchType: "Exact Match" })).rejects.toThrow(/already in review/);
      const r3 = await makeRequest("learn3", rep, ["1DLMC05"]);
      await runRequest(r3.id);
      const line3 = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r3.id }, include: { candidates: { orderBy: { rank: "asc" } } } });
      const same3 = line3.candidates.find((c) => c.ownProductId === second.ownProductId)!;
      await recordLineDecision(rep, line3.id, { selectedCandidateId: same3.id, overrideNote: "TIER1 trying to rewrite" });
      const afterReview = await prisma.knownCross.findUniqueOrThrow({ where: { id: k.id } });
      expect(afterReview.approvalStatus).toBe("IN_REVIEW");
      expect(afterReview.matchType).toBe(k.matchType);
      expect(afterReview.justification).toBe(k.justification);
      expect(JSON.parse(afterReview.evidenceJson!)).toMatchObject({ endorsements: 3 });
      await prisma.knownCross.update({ where: { id: k.id }, data: { approvalStatus: "DRAFT" } });
      // A lone draft by this rep on another code IS retired on undo.
      const line2 = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r.id, lineNo: 2 }, include: { candidates: { orderBy: { rank: "asc" } } } });
      if (line2.candidates.length >= 2) {
        const l2 = await recordLineDecision(rep, line2.id, { selectedCandidateId: line2.candidates[1].id });
        const back = await recordLineDecision(rep, line2.id, { selectedCandidateId: line2.candidates[0].id });
        expect(back.retiredCrossId).toBe(l2.proposedCrossId);
        expect((await prisma.knownCross.findUniqueOrThrow({ where: { id: l2.proposedCrossId! } })).approvalStatus).toBe("RETIRED");
      }
    }, 60_000);

    test("a draft rep cross lifts its SKU on the next run without granting a curated tier", async () => {
      const k = await prisma.knownCross.findFirstOrThrow({ where: { competitorCodeNorm: "1DLMC05", source: "rep", approvalStatus: "DRAFT" } });
      const r = await makeRequest("prior", rep, ["1DLMC05"]);
      await runRequest(r.id);
      const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: r.id }, include: { candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } });
      const c = line.candidates.find((x) => x.ownProduct.sku.toUpperCase() === k.ownSku)!;
      expect(c).toBeTruthy();
      expect(c.source).not.toBe("known-cross");
      expect(c.rationale).toMatch(/chosen by 3 reps before/);
    }, 60_000);
  });

  // ---- 1.4 feeds ---------------------------------------------------------------------------
  describe("1.4 scheduled feeds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier1-feeds-"));
    const write = (csv: string) => fs.writeFileSync(path.join(dir, "pricing.csv"), csv);
    afterAll(() => { delete process.env.INTEGRATION_FEED_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

    test("ingests a file drop, skips an unchanged file, re-ingests a changed one, and records every run", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      write("SKU,List Price\nPPM1510X3,101.25\nPPDS2015,1130.00\n");
      const before = await prisma.ownProduct.findFirstOrThrow({ where: { sku: "PPM1510X3" } });
      const first = await ingestFeed("pricing", { trigger: "manual", actorUserId: admin.id });
      expect(first.status).toBe("OK");
      expect((await prisma.ownProduct.findFirstOrThrow({ where: { sku: "PPM1510X3" } })).listPrice?.toString()).toMatch(/^101\.25/);
      const second = await ingestFeed("pricing", { trigger: "schedule" });
      expect(second.status).toBe("SKIPPED"); expect(second.reason).toMatch(/unchanged/);
      write("SKU,List Price\nPPM1510X3,102.00\n");
      const third = await ingestFeed("pricing", { trigger: "schedule" });
      expect(third.status).toBe("OK");
      expect((await prisma.ownProduct.findFirstOrThrow({ where: { sku: "PPM1510X3" } })).listPrice?.toString()).toMatch(/^102/);
      const forced = await ingestFeed("pricing", { trigger: "manual", force: true });
      expect(forced.status).toBe("OK");
      const runs = await prisma.feedRun.findMany({ where: { feed: "pricing", sourceRef: "pricing.csv" } });
      expect(runs.map((x) => x.status).sort()).toEqual(["OK", "OK", "OK", "SKIPPED"]);
      expect(runs.every((x) => !x.sourceRef?.includes("/"))).toBe(true); // file names, never server paths
      // A run with rejected rows does not "consume" the file: the next schedule tries again.
      write("SKU,List Price\nPPM1510X3,103.00\nNO-SUCH-SKU,1.00\n");
      const partial = await ingestFeed("pricing", { trigger: "schedule" });
      expect(partial.status).toBe("OK"); expect((partial as { failed: number }).failed).toBe(1);
      const retry = await ingestFeed("pricing", { trigger: "schedule" });
      expect(retry.status).toBe("OK");
      // One ingestion of a feed at a time, whichever door it came through.
      const stuck = await prisma.feedRun.create({ data: { feed: "pricing", trigger: "manual", status: "RUNNING" } });
      await expect(ingestFeed("pricing", { trigger: "manual", force: true })).rejects.toThrow(/already being ingested/);
      await prisma.feedRun.delete({ where: { id: stuck.id } });
      await prisma.ownProduct.update({ where: { id: before.id }, data: { listPrice: before.listPrice } });
    });

    test("a missing file is SKIPPED with the reason; a bad file FAILS, is recorded, and admins are told", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      fs.rmSync(path.join(dir, "pricing.csv"));
      await expect(ingestFeed("constructor", { trigger: "manual" })).rejects.toThrow(/unknown feed/);
      const none = await ingestFeed("pricing", { trigger: "schedule" });
      expect(none.status).toBe("SKIPPED"); expect(none.reason).toMatch(/no source configured/);
      write("garbage without a header\n");
      await expect(ingestFeed("pricing", { trigger: "schedule" })).rejects.toThrow();
      const failed = await prisma.feedRun.findFirst({ where: { feed: "pricing", status: "FAILED" }, orderBy: { startedAt: "desc" } });
      expect(failed?.error).toBeTruthy();
      expect(await prisma.notification.count({ where: { userId: admin.id, kind: "FEED_FAILED", entityId: failed!.id } })).toBe(1);
      // Status: connected + scheduled + last run failed → the feed rule fires CRITICAL.
      const st = (await feedStatuses()).find((f) => f.name === "pricing")!;
      expect(st.source.kind).toBe("file"); expect(st.lastRun?.status).toBe("FAILED");
      const conds = await feedRule();
      expect(conds.find((c) => c.fingerprint === "feed_failed:pricing")?.severity).toBe("CRITICAL");
      await prisma.feedRun.deleteMany({ where: { feed: "pricing", status: "FAILED", sourceRef: "pricing.csv" } });
    });

    test("the manual Sync-now path and the feed path share one FeedRun history", async () => {
      process.env.INTEGRATION_FEED_DIR = dir;
      const r = await ingestFeed("crm", { trigger: "manual", actorUserId: admin.id, force: true });
      expect(["SKIPPED", "OK"]).toContain(r.status); // no crm files in the temp dir → skipped with a reason
      if (r.status === "SKIPPED") expect(r.reason).toMatch(/no source configured/);
    });
  });

  // ---- 1.5 size coverage -------------------------------------------------------------------
  describe("1.5 competitor size worklist", () => {
    test("ranks unsized codes first by estimated spend and reports coverage", async () => {
      const { rows, totals } = await sizeCoverage();
      expect(totals.codes).toBeGreaterThan(0);
      const unsizedIdx = rows.findIndex((r) => r.sized), firstSized = unsizedIdx === -1 ? rows.length : unsizedIdx;
      expect(rows.slice(0, firstSized).every((r) => !r.sized)).toBe(true);
      expect(rows.slice(firstSized).every((r) => r.sized)).toBe(true);
      for (let i = 1; i < firstSized; i++) expect(rows[i - 1].spend >= rows[i].spend).toBe(true);
      expect(rows[0].priority).toBe(1);
      expect(totals.coveredSpendPct).toBeGreaterThanOrEqual(0);
    });
  });

  // ---- 1.6 benchmark -----------------------------------------------------------------------
  describe("1.6 benchmark", () => {
    test("runs a case through the real pipeline, scores per family, persists the run and removes its request", async () => {
      const intake = parseIntakeCsv("Product Code,Quantity\n1DLMC05,12\n1410015010,4\nSPMII,30\n", "intake.csv");
      const line = await prisma.requestLine.findFirst({ where: { cfnNorm: "1DLMC05", request: { reference: { startsWith: "TIER1-" } }, matchStatus: "matched" }, include: { candidates: { where: { rank: 1 }, include: { ownProduct: true } } } });
      const expectedTop = line?.candidates[0]?.ownProduct.sku ?? "PPM1510X3";
      const c: BenchmarkCase = { name: "tier1-case", intake, reference: [{ code: "1DLMC05", norm: "1DLMC05", expected: [expectedTop], matchType: "Close Match", family: "Hernia Mesh", notes: null }, { code: "1410015010", norm: "1410015010", expected: ["NO-SUCH-SKU"], matchType: "Close Match", family: "Hernia Mesh", notes: null }, { code: "SPMII", norm: "SPMII", expected: [], matchType: "Not Found", family: null, notes: null }], meta: { account: "TIER1", source: "test" } };
      const r = await runBenchmark([c], { label: "tier1-test" });
      expect(r.cases).toBe(1); expect(r.lines).toBe(3);
      expect(r.top1).toBeGreaterThanOrEqual(1); // the expected top for 1DLMC05
      expect(r.misses.some((m) => m.code === "1410015010")).toBe(true);
      expect(Object.keys(r.byFamily)).toContain("Hernia Mesh");
      const row = await prisma.benchmarkRun.findUniqueOrThrow({ where: { id: r.runId } });
      expect(row.lines).toBe(3); expect(row.binVersion).toBeGreaterThan(0);
      expect(await prisma.request.count({ where: { reference: { startsWith: "BENCH-tier1-case" } } })).toBe(0);
    }, 90_000);
  });

  // ---- 1.10 notifications ------------------------------------------------------------------
  describe("1.10 notifications", () => {
    test("in-app rows honour preferences and dedupe; deliveries record success and failure; a failing transport is retried by the queue", async () => {
      const kind = "ALERT" as const;
      await setPreference(rep.id, "*", { inApp: true, email: false, teams: false });
      const one = await notify({ kind, userIds: [rep.id, rep.id], title: "TIER1 dedupe", entityType: "TIER1", entityId: "x", dedupeKey: "k" });
      expect(one.created).toBe(1);
      const two = await notify({ kind, userIds: [rep.id], title: "TIER1 dedupe (title changed, same key)", entityType: "TIER1", entityId: "x", dedupeKey: "k" });
      expect(two.created).toBe(0);
      const three = await notify({ kind, userIds: [rep.id], title: "TIER1 dedupe", entityType: "TIER1", entityId: "x", dedupeKey: "k2" });
      expect(three.created).toBe(1); // a different key is a different message even with the same title
      expect((await notify({ kind, userIds: ["no-such-user"], title: "TIER1 ghost", entityType: "TIER1" })).created).toBe(0); // never throws
      await setPreference(rep.id, kind, { inApp: false, email: false, teams: false });
      expect((await preferencesFor(rep.id, kind)).inApp).toBe(false);
      expect((await notify({ kind, userIds: [rep.id], title: "TIER1 muted", entityType: "TIER1" })).created).toBe(0);
      await prisma.notificationPreference.deleteMany({ where: { userId: rep.id } });
      // Delivery with test transports.
      const sent: string[] = [];
      setTransportsForTests({ email: async (m) => { sent.push(m.subject); }, teams: async () => { throw new Error("webhook 500"); } });
      const n = (await inboxFor(rep.id, { take: 1 }))[0];
      expect((await deliver(n.id, "email")).delivered).toBe(true);
      expect(sent[0]).toMatch(/TIER1 dedupe/);
      expect((await deliver(n.id, "email")).skipped).toMatch(/already delivered/);
      await expect(deliver(n.id, "teams")).rejects.toThrow(/webhook 500/);
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
      const del = JSON.parse(row.deliveriesJson!);
      expect(del.email.ok).toBe(true); expect(del.teams.ok).toBe(false); expect(del.teams.attempts).toBe(1);
      expect(await markRead(rep.id, [n.id])).toBe(1);
      expect(await markRead(manager.id, [n.id])).toBe(0); // never someone else's row
      // No external delivery is ever attempted when the channel is not configured (no SMTP here).
      const { channelsConfigured } = await import("@/lib/notifications");
      expect(channelsConfigured().email).toBe(false);
    });

    test("approval requests reach approvers with enough authority (not the submitter); decisions reach the owner", async () => {
      const r = await makeRequest("appr", rep, ["1DLMC05", "1410015010"]);
      await runRequest(r.id);
      const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
      const p = await createFromRequest(rep, r.id, { accountId: acc.id });
      const lines = await prisma.proposalLine.findMany({ where: { proposalId: p.id, included: true } });
      expect(lines.length).toBeGreaterThan(0);
      // Push a line 20% below its contract/list so it needs a manager.
      const l = lines[0];
      const base = money(l.contractPrice) ?? money(l.listPrice)!;
      await setProposedPrice(rep, l.id, base.times(0.8), "TIER1 discount");
      const sub = await submitForApproval(rep, p.id);
      expect(sub.routed).toBeGreaterThan(0);
      const req = await prisma.approvalRequest.findFirstOrThrow({ where: { proposalId: p.id, status: "PENDING" } });
      const managerNotes = await prisma.notification.count({ where: { userId: manager.id, kind: "APPROVAL_REQUESTED", entityId: p.id } });
      const repNotes = await prisma.notification.count({ where: { userId: rep.id, kind: "APPROVAL_REQUESTED", entityId: p.id } });
      expect(managerNotes + (await prisma.notification.count({ where: { kind: "APPROVAL_REQUESTED", entityId: p.id, user: { roles: { some: { role: { in: ["PRICING_DIRECTOR", "PRICING_COMMITTEE", "CONTRACTING_MANAGER", "ADMIN"] } } } } } }))).toBeGreaterThan(0);
      expect(repNotes).toBe(0);
      await notifyApprovalRequested(p.id); // repeat within the hour for the SAME submission → deduped
      expect(await prisma.notification.count({ where: { userId: manager.id, kind: "APPROVAL_REQUESTED", entityId: p.id } })).toBe(managerNotes);
      const decider = ["REGIONAL_MANAGER"].includes(req.requiredRole) ? manager : await actor("dana.director@crosswalk.dev");
      await decide(decider, req.id, "CHANGES_REQUESTED", "TIER1 please lower");
      expect(await prisma.notification.count({ where: { userId: rep.id, kind: "APPROVAL_DECIDED", entityId: req.id } })).toBe(1);
      // Resubmission within the hour is a NEW ask: approvers are told again.
      const beforeResubmit = await prisma.notification.count({ where: { kind: "APPROVAL_REQUESTED", entityId: p.id } });
      await submitForApproval(rep, p.id);
      expect(await prisma.notification.count({ where: { kind: "APPROVAL_REQUESTED", entityId: p.id } })).toBeGreaterThan(beforeResubmit);
    }, 90_000);
  });

  // ---- 1.9 observability -------------------------------------------------------------------
  describe("1.9 alerts and metrics", () => {
    test("model failures raise one alert, notify admins once, re-notify only after the window, and resolve when calls recover", async () => {
      const hadKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-tier1-fake";
      await prisma.llmCall.deleteMany({ where: { createdAt: { gt: new Date(Date.now() - 3600_000) } } });
      for (let i = 0; i < 4; i++) await prisma.llmCall.create({ data: { purpose: "grade", subject: "tier1-test", model: "x", ok: false, durationMs: 10, error: "401 invalid key" } });
      expect((await modelRule())[0]?.fingerprint).toBe("model_unreachable");
      const first = await evaluateAlerts();
      expect(first.firing.some((c) => c.fingerprint === "model_unreachable")).toBe(true);
      const a1 = await prisma.alert.findUniqueOrThrow({ where: { fingerprint: "model_unreachable" } });
      expect(a1.resolvedAt).toBeNull();
      const notes = await prisma.notification.count({ where: { userId: admin.id, kind: "ALERT", entityId: a1.id } });
      expect(notes).toBe(1);
      await evaluateAlerts();
      expect(await prisma.notification.count({ where: { userId: admin.id, kind: "ALERT", entityId: a1.id } })).toBe(1); // no re-notify within the window
      for (let i = 0; i < 5; i++) await prisma.llmCall.create({ data: { purpose: "grade", subject: "tier1-test", model: "x", ok: true, durationMs: 10 } });
      const after = await evaluateAlerts();
      expect(after.firing.some((c) => c.fingerprint === "model_unreachable")).toBe(false);
      expect((await prisma.alert.findUniqueOrThrow({ where: { fingerprint: "model_unreachable" } })).resolvedAt).not.toBeNull();
      await prisma.notification.deleteMany({ where: { entityId: a1.id } });
      await prisma.alert.delete({ where: { fingerprint: "model_unreachable" } });
      if (hadKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = hadKey;
    });

    test("a rule that cannot run leaves its own alerts untouched instead of resolving them", async () => {
      await prisma.alert.create({ data: { fingerprint: "feed_failed:tier1x", rule: "feed_failed", severity: "CRITICAL", title: "TIER1 synthetic" } });
      const broken = RULES.map((r) => (r.name === "feeds" ? { ...r, run: async () => { throw new Error("feed store down"); } } : r));
      const res = await evaluateAlerts(broken);
      expect(res.rulesFailed).toEqual(["feeds"]);
      expect((await prisma.alert.findUniqueOrThrow({ where: { fingerprint: "feed_failed:tier1x" } })).resolvedAt).toBeNull();
      const healthy = await evaluateAlerts();
      expect(healthy.rulesFailed).toEqual([]);
      expect((await prisma.alert.findUniqueOrThrow({ where: { fingerprint: "feed_failed:tier1x" } })).resolvedAt).not.toBeNull();
      await prisma.alert.delete({ where: { fingerprint: "feed_failed:tier1x" } });
    });

    test("metrics render the application series and never leak secrets", () => {
      const out = render();
      expect(out).toMatch(/crosswalk_runs_total\{outcome="complete"\} \d+/);
      expect(out).toContain("crosswalk_notifications_total");
      expect(out).not.toMatch(/postgres:\/\//);
      expect(out).not.toMatch(/sk-/);
    });
  });

  // ---- 1.11 drift ------------------------------------------------------------------------
  describe("1.11 context drift", () => {
    test("a new local contract price is reported as drift; refresh re-snapshots an unlocked draft (audited) and refuses a submitted one", async () => {
      const r = await makeRequest("drift", rep, ["1DLMC05", "1410015010"]);
      await runRequest(r.id);
      const acc = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "0001880967" } });
      const p = await createFromRequest(rep, r.id, { accountId: acc.id });
      expect((await driftFor(p.id)).lines).toHaveLength(0); // fresh: nothing moved
      const line = await prisma.proposalLine.findFirstOrThrow({ where: { proposalId: p.id, included: true, productId: { not: null } } });
      // The world moves: a new LOCAL contract with a lower price for this SKU.
      // Effective from now: the newest local contract is the account's primary one (context.ts).
      const from = new Date(Date.now() - 1000);
      const contract = await prisma.contract.create({ data: { contractNumber: "TIER1-LOCAL", name: "TIER1 local", type: "LOCAL", status: "ACTIVE", accountId: acc.id, currency: "USD", effectiveFrom: from, effectiveTo: new Date(Date.now() + 30 * 86_400_000), sourceSystem: "test", createdByUserId: admin.id } });
      const newPrice = (money(line.contractPrice) ?? money(line.listPrice)!).times(0.5).toFixed(2);
      await prisma.priceEntry.create({ data: { contractId: contract.id, accountId: acc.id, productId: line.productId!, productFamily: line.productFamily, price: newPrice, currency: "USD", effectiveFrom: from, effectiveTo: new Date(Date.now() + 30 * 86_400_000), source: "test", status: "ACTIVE", approvalState: "APPROVED" } });
      const d = await driftFor(p.id);
      expect(d.editable).toBe(true);
      const ld = d.lines.find((x) => x.lineId === line.id)!;
      expect(ld.changes.some((c) => c.field === "contractPrice" && c.to && Number(c.to) === Number(newPrice))).toBe(true);
      expect(d.proposal.some((c) => /local contract/.test(c.note ?? ""))).toBe(true);
      // Refresh keeps the proposed price, updates the snapshot, audits.
      const proposedBefore = line.proposedPrice?.toString();
      const res = await refreshContext(rep, p.id);
      expect(res.refreshed).toBeGreaterThanOrEqual(1);
      const after = await prisma.proposalLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(Number(after.contractPrice)).toBe(Number(newPrice));
      expect(after.proposedPrice?.toString()).toBe(proposedBefore);
      const pAfter = await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } });
      expect(pAfter.contractId).toBe(contract.id);
      expect(pAfter.lockedAt).toBeNull(); // the refresh's claim is released
      expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: p.id, action: "CONTEXT_REFRESHED" } })).toBe(1);
      expect((await driftFor(p.id)).lines).toHaveLength(0);
      // A floor that moved for a policy reason (no cost change) is still reported, with the below-floor count.
      await prisma.proposalLine.update({ where: { id: line.id }, data: { floorPrice: "0.01", proposedPrice: "0.005" } });
      const dFloor = await driftFor(p.id);
      const lf = dFloor.lines.find((x) => x.lineId === line.id)!;
      expect(lf.changes.some((c) => c.field === "floorPrice")).toBe(true);
      expect(lf.changes.some((c) => c.field === "cost")).toBe(false);
      expect(dFloor.summary.belowNewFloor).toBe(1);
      await refreshContext(rep, p.id);
      await prisma.proposalLine.update({ where: { id: line.id }, data: { proposedPrice: after.proposedPrice } });
      // Submitted → reported but not refreshable; a rep without view_cost sees cost deltas redacted at the route (checked in adversarial pass).
      await submitForApproval(rep, p.id);
      await prisma.priceEntry.updateMany({ where: { contractId: contract.id }, data: { price: (Number(newPrice) * 0.9).toFixed(2) } });
      const d2 = await driftFor(p.id);
      expect(d2.editable).toBe(false);
      expect(d2.lines.length).toBeGreaterThan(0);
      await expect(refreshContext(rep, p.id)).rejects.toThrow(/only an unlocked draft/);
    }, 90_000);
  });
});

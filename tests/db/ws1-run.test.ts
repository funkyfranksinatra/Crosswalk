/**
 * WS1 run lifecycle, settings snapshot (KN-06) and learning-loop guards, on a database with the demo
 * seed. No network: the fixture's competitor codes are pre-resolved ("manual") rows with crafted bins,
 * so the resolver answers from its cache. Everything the suite creates carries the WS1RUN- prefix and
 * is removed afterwards; Settings are restored to what they were.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { permissionsFor } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";
import { runRequest, enqueueRun, cancelRun } from "@/lib/pipeline/run";
import { getSettings, saveSettings, getCompany } from "@/lib/settings";
import { DEFAULT_WEIGHTS } from "@/lib/match/score";
import { BIN_VERSION, type Bin } from "@/lib/match/bin";
import { recordLineDecision } from "@/lib/xref/learning";
import { proposeCross, publishVersion } from "@/lib/xref/governance";
import { isPlaceholderSku } from "@/lib/cfn";
import { getBoss, stopBoss } from "@/lib/jobs/boss";

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = "WS1RUN";

async function actor(email: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { roles: true } });
  const roles = u.roles.map((r) => r.role);
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}

/** A bin in a family the demo catalog does not populate, so the fixture SKUs are the whole shortlist. */
const bin = (features: string[], extra: Partial<Bin> = {}): Bin => ({ v: BIN_VERSION, productType: "vessel sealer", family: "Energy", function: "seals", materials: ["steel"], dimensions: [{ name: "length", value: 37, unit: "cm" }, { name: "diameter", value: 5, unit: "mm" }], features, compatibility: [], singleUse: true, sterile: true, implantable: false, summary: "ws1 fixture vessel sealer 5 mm 37 cm", ...extra });
const FEATS = ["single-use", "sterile", "curved tip", "articulating"];

describe.skipIf(!hasDb)("WS1 run lifecycle", () => {
  let rep: Actor, manager: Actor;
  let companyId: string;
  let settingsBefore: { weights: string | null; max: string | null };
  const ownIds: Record<string, string> = {};

  async function cleanup() {
    const reqs = await prisma.request.findMany({ where: { reference: { startsWith: `${TAG}-` } }, select: { id: true } });
    const ids = reqs.map((r) => r.id);
    const lineIds = (await prisma.requestLine.findMany({ where: { requestId: { in: ids } }, select: { id: true } })).map((l) => l.id);
    await prisma.matchDecision.deleteMany({ where: { requestLineId: { in: lineIds } } });
    await prisma.request.deleteMany({ where: { id: { in: ids } } });
    await prisma.knownCross.deleteMany({ where: { competitorCodeNorm: { startsWith: `${TAG}-` } } });
    await prisma.matchCandidate.deleteMany({ where: { ownProduct: { sku: { startsWith: `${TAG}-` } } } });
    await prisma.ownProduct.deleteMany({ where: { sku: { startsWith: `${TAG}-` } } });
    await prisma.competitorProduct.deleteMany({ where: { cfnNorm: { startsWith: `${TAG}-` } } });
  }
  async function restoreSettings() {
    for (const [key, value] of [["weights", settingsBefore.weights], ["maxCandidates", settingsBefore.max]] as const) {
      if (value == null) await prisma.setting.deleteMany({ where: { key } });
      else await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
  }

  beforeAll(async () => {
    await cleanup();
    [rep, manager] = await Promise.all([actor("alex.rep@crosswalk.dev"), actor("maria.manager@crosswalk.dev")]);
    companyId = (await getCompany()).id;
    const rows = await prisma.setting.findMany({ where: { key: { in: ["weights", "maxCandidates"] } } });
    settingsBefore = { weights: rows.find((r) => r.key === "weights")?.value ?? null, max: rows.find((r) => r.key === "maxCandidates")?.value ?? null };
    // Two own SKUs: A is the closer product (all four features), B differs on three features but is cheaper.
    for (const [sku, feats, price] of [[`${TAG}-A`, FEATS, "110"], [`${TAG}-B`, [FEATS[0]], "90"]] as const) {
      const p = await prisma.ownProduct.create({ data: { companyId, sku, description: "ws1 fixture vessel sealer 5 mm 37 cm", category: "Energy", listPrice: price, binJson: JSON.stringify(bin([...feats])), binSource: "heuristic", binnedAt: new Date(), source: "manual" } });
      ownIds[sku] = p.id;
    }
    // Sixty pre-resolved competitor codes with the same bin (enough lines for two persistence chunks).
    for (let i = 1; i <= 60; i++) {
      const code = `${TAG}-${String(i).padStart(3, "0")}`;
      await prisma.competitorProduct.create({ data: { cfnNorm: code, cfnMatched: code, manufacturer: "Ethicon", labeler: "ETHICON", brand: "WS1 Sealer", description: "ws1 fixture vessel sealer 5 mm 37 cm", resolution: "manual", resolutionNote: "ws1 fixture", confidence: 1, binJson: JSON.stringify(bin(FEATS)), binSource: "heuristic", binnedAt: new Date() } });
    }
  }, 120_000);
  afterAll(async () => { await cleanup(); await restoreSettings(); await stopBoss().catch(() => undefined); });
  afterEach(async () => { await restoreSettings(); });

  async function makeRequest(tag: string, n = 1, opts: { estPrice?: string | null } = {}) {
    const estCompetitorPrice = opts.estPrice === null ? null : opts.estPrice ?? "100";
    return prisma.request.create({ data: { companyId, reference: `${TAG}-${tag}-${Date.now().toString(36)}`, accountNumber: null, accountName: "WS1 fixture hospital", useLlm: false, status: "queued", createdBy: rep.name, createdByUserId: rep.id, lines: { create: Array.from({ length: n }, (_, i) => ({ lineNo: i + 1, rawCode: `${TAG}-${String(i + 1).padStart(3, "0")}`, cfnNorm: `${TAG}-${String(i + 1).padStart(3, "0")}`, quantity: 10, estCompetitorPrice })) } } });
  }
  const topOf = async (requestId: string, lineNo = 1) => {
    const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId, lineNo }, include: { candidates: { orderBy: { rank: "asc" }, include: { ownProduct: { select: { sku: true } } } } } });
    return { line, top: line.candidates[0], skus: line.candidates.map((c) => c.ownProduct.sku), factors: line.candidates.map((c) => JSON.parse(c.factorsJson ?? "{}") as { weights?: Record<string, number>; cap?: string }) };
  };
  const finishJob = async (jobId: string | null) => { if (jobId) await (await getBoss()).cancel("request.run", jobId).catch(() => undefined); };

  // ---- KN-06: Settings weights reach the run through a snapshot --------------------------------
  test("KN-06: saved weights are snapshotted at enqueue, applied by the run, kept by a retry/resume, and re-snapshotted by a fresh Re-run", async () => {
    // Defaults: the closer product (A) wins.
    const r = await makeRequest("weights");
    const q1 = await enqueueRun(r.id);
    expect(q1.jobId).toBeTruthy();
    let row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(JSON.parse(row.optionsJson!)).toMatchObject({ weights: DEFAULT_WEIGHTS, maxCandidates: (await getSettings()).maxCandidates });
    await runRequest(r.id, { jobId: q1.jobId });
    let t = await topOf(r.id);
    expect(t.top.ownProduct.sku).toBe(`${TAG}-A`);
    expect(t.factors[0].weights).toEqual(DEFAULT_WEIGHTS);
    expect(t.skus).toEqual([`${TAG}-A`, `${TAG}-B`]);
    expect((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("complete");
    await finishJob(q1.jobId);

    // Price-heavy weights saved on Settings: the next enqueue snapshots them and the cheaper product (B) wins.
    const custom = { bin: 0.4, price: 0.6, cogs: 0, margin: 0 };
    await saveSettings({ weights: custom, maxCandidates: 7 });
    const q2 = await enqueueRun(r.id);
    expect(q2.jobId).toBeTruthy();
    row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(JSON.parse(row.optionsJson!)).toMatchObject({ weights: custom, maxCandidates: 7 });
    await runRequest(r.id, { jobId: q2.jobId });
    t = await topOf(r.id);
    expect(t.top.ownProduct.sku).toBe(`${TAG}-B`);
    expect(t.factors[0].weights).toEqual(custom);
    expect(t.skus).toEqual([`${TAG}-B`, `${TAG}-A`]);
    // grade and cap are untouched by the weights: both candidates keep the grade they had under defaults
    const grades = (await prisma.matchCandidate.findMany({ where: { line: { requestId: r.id } }, select: { matchType: true, factorsJson: true } }));
    expect(new Set(grades.map((g) => g.matchType)).size).toBe(1);
    expect(grades.every((g) => (JSON.parse(g.factorsJson!) as { cap: string }).cap === "Exact Match")).toBe(true);
    await finishJob(q2.jobId);

    // Settings change back to defaults, but a retry / orphan resume of THIS run keeps its snapshot.
    await saveSettings({ weights: DEFAULT_WEIGHTS, maxCandidates: 5 });
    await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "bin" } });
    await runRequest(r.id, { attempt: 2 });
    t = await topOf(r.id);
    expect(t.top.ownProduct.sku).toBe(`${TAG}-B`);
    expect(t.factors[0].weights).toEqual(custom);
    await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "resolve" } });
    await runRequest(r.id, { attempt: 1, resume: true });
    expect((await topOf(r.id)).factors[0].weights).toEqual(custom);
    // An orphan re-queue keeps the snapshot too …
    await prisma.request.update({ where: { id: r.id }, data: { status: "running", checkpoint: "bin", jobId: null } });
    const q3 = await enqueueRun(r.id);
    expect(q3.resumed).toBe(true);
    expect(JSON.parse((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).optionsJson!).weights).toEqual(custom);
    await finishJob(q3.jobId);
    await prisma.request.update({ where: { id: r.id }, data: { status: "complete" } });
    // … and a fresh Re-run of the finished request takes a new snapshot: defaults again, A wins again.
    const q4 = await enqueueRun(r.id);
    expect(q4.jobId).toBeTruthy(); expect(q4.resumed).toBe(false);
    expect(JSON.parse((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).optionsJson!).weights).toEqual(DEFAULT_WEIGHTS);
    await runRequest(r.id, { jobId: q4.jobId });
    t = await topOf(r.id);
    expect(t.top.ownProduct.sku).toBe(`${TAG}-A`);
    expect(t.factors[0].weights).toEqual(DEFAULT_WEIGHTS);
    await finishJob(q4.jobId);
  }, 120_000);

  test("a corrupt or hostile snapshot never reaches the scorer: bad weights fall back to the Settings, an out-of-range maxCandidates to the Settings value", async () => {
    const r = await makeRequest("badsnap");
    await prisma.request.update({ where: { id: r.id }, data: { optionsJson: JSON.stringify({ weights: { bin: "x", price: -1, cogs: Number.NaN, margin: 99 }, maxCandidates: 999 }) } });
    await runRequest(r.id);
    const t = await topOf(r.id);
    expect(t.factors[0].weights).toEqual(DEFAULT_WEIGHTS);
    expect(t.skus).toHaveLength(2);
    // Options that are not JSON at all are corrupt data: the run fails with a plain message, it does not guess.
    await prisma.request.update({ where: { id: r.id }, data: { optionsJson: "not json" } });
    await expect(runRequest(r.id)).rejects.toThrow(/run options stored on this request are corrupt/);
    expect((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("failed");
  }, 60_000);

  // ---- lifecycle --------------------------------------------------------------------------------
  test("queued → running → complete: checkpoints, progress, timestamps and the log; 'complete' is never written while lines are unfinished", async () => {
    const r = await makeRequest("life", 3);
    const stages: string[] = [];
    const orig = prisma.request.update.bind(prisma.request);
    let completeSeenWithPending = false;
    (prisma.request as { update: typeof prisma.request.update }).update = (async (args: Parameters<typeof orig>[0]) => {
      const d = args.data as { stage?: string; status?: string };
      if (typeof d.stage === "string") stages.push(d.stage);
      if (d.status === "complete") {
        const pending = await prisma.requestLine.count({ where: { requestId: r.id, matchStatus: { notIn: ["matched", "no-match", "error"] } } });
        if (pending > 0) completeSeenWithPending = true;
      }
      return orig(args);
    }) as unknown as typeof prisma.request.update;
    try { await runRequest(r.id); } finally { (prisma.request as { update: typeof prisma.request.update }).update = orig; }
    const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: "complete", stage: "Complete", progress: 100, checkpoint: "match", attempt: 1, cancelRequested: false });
    expect(row.startedAt).toBeTruthy(); expect(row.completedAt).toBeTruthy();
    expect(completeSeenWithPending).toBe(false);
    expect(stages[0]).toMatch(/Resolving/); expect(stages.some((s) => /Binning/.test(s))).toBe(true); expect(stages.some((s) => /Matching/.test(s))).toBe(true); expect(stages[stages.length - 1]).toBe("Complete");
    const log = (JSON.parse(row.logJson) as { m: string }[]).map((l) => l.m);
    expect(log.some((m) => /Run started · 3 lines · heuristic matching/.test(m))).toBe(true);
    expect(log.some((m) => /Matched 3\/3 lines/.test(m))).toBe(true);
    expect(await prisma.requestLine.count({ where: { requestId: r.id, matchStatus: "matched", selectedCandidateId: { not: null } } })).toBe(3);
  }, 60_000);

  test("cancel before pickup: cancelRun wins the queued → cancelled race and a late handler does no work", async () => {
    const r = await makeRequest("cancel-early", 2);
    const q = await cancelRun(r.id);
    expect(q).toEqual({ cancelled: true, status: "cancelled" });
    await runRequest(r.id); // the worker picks up a cancelled request: no work, no candidates
    const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("cancelled"); expect(row.cancelRequested).toBe(false);
    expect(await prisma.matchCandidate.count({ where: { line: { requestId: r.id } } })).toBe(0);
    expect(await cancelRun(r.id)).toEqual({ cancelled: false, status: "cancelled" });
  }, 60_000);

  test("cancel mid-stage: a cancel that lands during binning stops at the next checkpoint, keeps the previous result, and a re-run completes", async () => {
    const r = await makeRequest("cancel-mid", 3);
    await runRequest(r.id);
    const before = await prisma.matchCandidate.findMany({ where: { line: { requestId: r.id } }, select: { id: true } });
    expect(before.length).toBeGreaterThan(0);
    await prisma.request.update({ where: { id: r.id }, data: { status: "queued" } });
    const orig = prisma.request.update.bind(prisma.request);
    let injected = false;
    (prisma.request as { update: typeof prisma.request.update }).update = (async (args: Parameters<typeof orig>[0]) => {
      const d = args.data as { stage?: string };
      if (!injected && typeof d.stage === "string" && /^Binning/.test(d.stage)) { injected = true; const res = await cancelRun(r.id); expect(res.status).toBe("running"); }
      return orig(args);
    }) as unknown as typeof prisma.request.update;
    try { await runRequest(r.id); } finally { (prisma.request as { update: typeof prisma.request.update }).update = orig; }
    expect(injected).toBe(true);
    const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("cancelled"); expect(row.stage).toBe("Cancelled"); expect(row.cancelRequested).toBe(false);
    expect(row.checkpoint).toBe("bin"); // stopped at the checkpoint after binning, before matching
    const after = await prisma.matchCandidate.findMany({ where: { line: { requestId: r.id } }, select: { id: true } });
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort()); // previous result intact
    expect((JSON.parse(row.logJson) as { m: string }[]).some((l) => /Cancelled by request/.test(l.m))).toBe(true);
    await prisma.request.update({ where: { id: r.id }, data: { status: "queued" } });
    await runRequest(r.id);
    expect((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("complete");
  }, 60_000);

  test("a failure inside the 2nd persistence chunk rolls that chunk back: no duplicate or orphan candidates, selections consistent, status failed with an error; a retry completes", async () => {
    const r = await makeRequest("chunkfail", 60);
    await runRequest(r.id);
    const firstRun = await prisma.matchCandidate.findMany({ where: { line: { requestId: r.id } }, select: { id: true, lineId: true } });
    expect(firstRun.length).toBe(120);
    const origTx = prisma.$transaction.bind(prisma);
    let chunks = 0;
    (prisma as { $transaction: typeof prisma.$transaction }).$transaction = (async (arg: unknown, opts?: unknown) => {
      if (typeof arg !== "function") return (origTx as (a: unknown, o?: unknown) => Promise<unknown>)(arg, opts);
      const fn = arg as (tx: unknown) => Promise<unknown>;
      return (origTx as (a: unknown, o?: unknown) => Promise<unknown>)(async (tx: { matchCandidate: { createManyAndReturn: (a: unknown) => Promise<unknown> } }) => {
        const inner = tx.matchCandidate.createManyAndReturn.bind(tx.matchCandidate);
        const proxied = new Proxy(tx, { get(t, k) { if (k !== "matchCandidate") return Reflect.get(t, k); return new Proxy(t.matchCandidate, { get(m, mk) { if (mk !== "createManyAndReturn") return Reflect.get(m, mk); return async (a: unknown) => { chunks++; const res = await inner(a); if (chunks === 2) throw new Error("injected failure after the 2nd chunk's insert"); return res; }; } }); } });
        return fn(proxied);
      }, opts);
    }) as unknown as typeof prisma.$transaction;
    try { await expect(runRequest(r.id, { finalAttempt: true })).rejects.toThrow(/injected failure/); } finally { (prisma as { $transaction: typeof prisma.$transaction }).$transaction = origTx; }
    expect(chunks).toBe(2);
    const row = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("failed"); expect(row.stage).toBe("Failed"); expect(row.error).toMatch(/injected failure after the 2nd chunk's insert/);
    expect(row.checkpoint).toBe("bin");
    // Every line has exactly its two candidates (chunk 1 new, chunk 2 old), one selected, and the selection exists.
    const lines = await prisma.requestLine.findMany({ where: { requestId: r.id }, include: { candidates: true }, orderBy: { lineNo: "asc" } });
    expect(lines).toHaveLength(60);
    const oldIds = new Set(firstRun.map((c) => c.id));
    let oldLines = 0, newLines = 0;
    for (const l of lines) {
      expect(l.candidates, `line ${l.lineNo}`).toHaveLength(2);
      expect(new Set(l.candidates.map((c) => c.ownProductId)).size).toBe(2);
      expect(l.candidates.filter((c) => c.isSelected)).toHaveLength(1);
      expect(l.candidates.some((c) => c.id === l.selectedCandidateId)).toBe(true);
      expect(l.matchStatus).toBe("matched");
      const old = l.candidates.filter((c) => oldIds.has(c.id)).length;
      expect([0, 2], `line ${l.lineNo} is whole: old or new, never mixed`).toContain(old);
      if (old === 2) oldLines++; else newLines++;
    }
    // Chunk 1 (50 lines, in completion order) was committed; chunk 2 (10 lines) rolled back to the previous result.
    expect(newLines).toBe(50); expect(oldLines).toBe(10);
    expect(await prisma.matchCandidate.count({ where: { line: { requestId: r.id } } })).toBe(120);
    // The retry resumes from the checkpoint and completes with a clean, consistent result.
    await runRequest(r.id, { attempt: 2 });
    const row2 = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(row2.status).toBe("complete"); expect(row2.attempt).toBe(2); expect(row2.error).toBeNull();
    const final = await prisma.requestLine.findMany({ where: { requestId: r.id }, include: { candidates: true } });
    expect(final.every((l) => l.candidates.length === 2 && l.candidates.some((c) => c.id === l.selectedCandidateId))).toBe(true);
    expect(await prisma.matchCandidate.count({ where: { line: { requestId: r.id } } })).toBe(120);
  }, 120_000);

  test("re-run keeps a reviewed line's chosen SKU when it is still offered, and clears the review when it is not", async () => {
    const r = await makeRequest("rerun", 2);
    await runRequest(r.id);
    const l1 = await topOf(r.id, 1);
    const second = l1.line.candidates[1];
    // The rep chooses the runner-up on line 1 and reviews both lines.
    await prisma.requestLine.update({ where: { id: l1.line.id }, data: { selectedCandidateId: second.id, reviewed: true, overrideNote: "ws1 keep me" } });
    await prisma.matchCandidate.updateMany({ where: { lineId: l1.line.id }, data: { isSelected: false } });
    await prisma.matchCandidate.update({ where: { id: second.id }, data: { isSelected: true } });
    const l2 = await topOf(r.id, 2);
    await prisma.requestLine.update({ where: { id: l2.line.id }, data: { selectedCandidateId: l2.top.id, reviewed: true } });
    await prisma.request.update({ where: { id: r.id }, data: { status: "queued" } });
    await runRequest(r.id);
    const after1 = await topOf(r.id, 1);
    expect(after1.line.reviewed).toBe(true);
    expect(after1.line.overrideNote).toBe("ws1 keep me");
    const chosen = after1.line.candidates.find((c) => c.id === after1.line.selectedCandidateId)!;
    expect(chosen.ownProductId).toBe(second.ownProductId); // the selection followed the SKU to its new row
    expect(chosen.id).not.toBe(second.id);
    expect(chosen.isSelected).toBe(true); expect(after1.top.isSelected).toBe(false);
    expect(after1.line.candidates.filter((c) => c.isSelected)).toHaveLength(1);
    const after2 = await topOf(r.id, 2);
    expect(after2.line.reviewed).toBe(true); expect(after2.line.selectedCandidateId).toBe(after2.top.id);
    // Now the chosen SKU disappears from the catalog: the review is void and the line takes the new top pick.
    await prisma.ownProduct.update({ where: { id: second.ownProductId }, data: { isActive: false } });
    await prisma.request.update({ where: { id: r.id }, data: { status: "queued" } });
    try {
      await runRequest(r.id);
      const gone = await topOf(r.id, 1);
      expect(gone.skus).not.toContain(second.ownProduct.sku);
      expect(gone.line.reviewed).toBe(false);
      expect(gone.line.selectedCandidateId).toBe(gone.top.id);
      expect(gone.line.overrideNote).toBe("ws1 keep me"); // notes are never touched
      expect((await topOf(r.id, 2)).line.reviewed).toBe(true);
      const log = (JSON.parse((await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).logJson) as { m: string }[]).map((l) => l.m);
      expect(log.some((m) => /Review cleared on 1 line\(s\).*WS1RUN-001/.test(m))).toBe(true);
    } finally { await prisma.ownProduct.update({ where: { id: second.ownProductId }, data: { isActive: true } }); }
  }, 90_000);

  // ---- learning loop guards ------------------------------------------------------------------------
  test("learning loop: repeated selection does not multiply endorsements; undo retires only a lone-opinion draft; reps cannot rewrite approved crosses", async () => {
    // No competitor price: the rep's draft prior (REP_PRIOR_BOOST) cannot flip the top pick on the second request.
    const r = await makeRequest("learn", 2, { estPrice: null });
    await runRequest(r.id);
    const l1 = await topOf(r.id, 1);
    const runnerUp = l1.line.candidates[1];
    const first = await recordLineDecision(rep, l1.line.id, { selectedCandidateId: runnerUp.id, overrideNote: "ws1 override" });
    expect(first.proposedCrossId).toBeTruthy();
    const ev = async () => JSON.parse((await prisma.knownCross.findUniqueOrThrow({ where: { id: first.proposedCrossId! } })).evidenceJson!) as { endorsements: number; users: string[]; lines: string[] };
    expect(await ev()).toMatchObject({ endorsements: 1 });
    for (let i = 0; i < 3; i++) await recordLineDecision(rep, l1.line.id, { selectedCandidateId: runnerUp.id });
    expect(await ev()).toMatchObject({ endorsements: 1 }); // same rep, same line: not new evidence
    expect(await prisma.matchDecision.count({ where: { requestLineId: l1.line.id } })).toBe(4); // every decision is recorded, though
    // Lone opinion: undoing the override (selecting the top pick again) retires the draft.
    const undo = await recordLineDecision(rep, l1.line.id, { selectedCandidateId: l1.top.id });
    expect(undo.retiredCrossId).toBe(first.proposedCrossId);
    expect((await prisma.knownCross.findUniqueOrThrow({ where: { id: first.proposedCrossId! } })).approvalStatus).toBe("RETIRED");
    // Re-proposed by the rep (revived draft) and then endorsed by a manager on line 2 of the same code family: no longer lone, so an undo keeps it.
    const again = await recordLineDecision(rep, l1.line.id, { selectedCandidateId: runnerUp.id });
    expect(again.proposedCrossId).toBe(first.proposedCrossId);
    expect((await prisma.knownCross.findUniqueOrThrow({ where: { id: first.proposedCrossId! } })).approvalStatus).toBe("DRAFT");
    const r2 = await makeRequest("learn-b", 1, { estPrice: null });
    await runRequest(r2.id);
    const other = await topOf(r2.id, 1);
    expect(other.top.ownProductId).toBe(l1.top.ownProductId); // the prior did not flip the top pick
    const sameSku = other.line.candidates.find((c) => c.ownProductId === runnerUp.ownProductId)!;
    await recordLineDecision(manager, other.line.id, { selectedCandidateId: sameSku.id });
    expect((await ev()).endorsements).toBe(2);
    const undo2 = await recordLineDecision(rep, l1.line.id, { selectedCandidateId: l1.top.id });
    expect(undo2.retiredCrossId).toBeUndefined();
    expect((await prisma.knownCross.findUniqueOrThrow({ where: { id: first.proposedCrossId! } })).approvalStatus).toBe("DRAFT");
    // Reps cannot rewrite a cross under review or approved through proposeCross; the rep-decision path only adds evidence.
    const k = await prisma.knownCross.findUniqueOrThrow({ where: { id: first.proposedCrossId! } });
    await prisma.knownCross.update({ where: { id: k.id }, data: { approvalStatus: "APPROVED", clinicalReviewStatus: "APPROVED", marketingReviewStatus: "APPROVED", matchType: "Close Match" } });
    await expect(proposeCross(rep.id, { ownSku: k.ownSku, competitorName: k.competitorName, competitorCode: k.competitorCode, matchType: "Exact Match" })).rejects.toThrow(/already approved/);
    await recordLineDecision(manager, l1.line.id, { selectedCandidateId: runnerUp.id, overrideNote: "trying to change the tier" });
    const afterK = await prisma.knownCross.findUniqueOrThrow({ where: { id: k.id } });
    expect(afterK).toMatchObject({ approvalStatus: "APPROVED", matchType: "Close Match", justification: k.justification });
    expect(JSON.parse(afterK.evidenceJson!).endorsements).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test("publishVersion never publishes a reviewer note as an own SKU; the preferred column redirects only to catalog SKUs", async () => {
    const catalog = new Set((await prisma.ownProduct.findMany({ select: { sku: true } })).map((p) => p.sku.toUpperCase()));
    // Two approved fixture rows: one with a note in the preferred column, one redirected to a real SKU.
    await prisma.knownCross.createMany({ data: [
      { ownSku: `${TAG}-A`, competitorName: "Ethicon", competitorCode: `${TAG}-PUB1`, competitorCodeNorm: `${TAG}-PUB1`, matchType: "Close Match", source: "ws1-fixture", approvalStatus: "APPROVED", clinicalReviewStatus: "NOT_REQUIRED", marketingReviewStatus: "NOT_REQUIRED", equivalenceLevel: "FUNCTIONAL", preferredOwnSku: "DUPLICATE" },
      { ownSku: `${TAG}-A`, competitorName: "Ethicon", competitorCode: `${TAG}-PUB2`, competitorCodeNorm: `${TAG}-PUB2`, matchType: "Close Match", source: "ws1-fixture", approvalStatus: "APPROVED", clinicalReviewStatus: "NOT_REQUIRED", marketingReviewStatus: "NOT_REQUIRED", equivalenceLevel: "FUNCTIONAL", preferredOwnSku: `${TAG}-B` },
    ] });
    const previous = await prisma.crosswalkVersion.findFirst({ where: { status: "PUBLISHED" } });
    const { version, entries } = await publishVersion(manager.id, "ws1 governance check");
    try {
      const rows = await prisma.crosswalkVersionEntry.findMany({ where: { versionId: version.id } });
      expect(rows.length).toBe(entries);
      expect(rows.filter((e) => isPlaceholderSku(e.ownSku))).toHaveLength(0);
      const notes = ["DUPLICATE", "REPEAT", "HAND", "DISCONT", "WRONG", "TAKE", "THIS", "DOESNT"];
      expect(rows.filter((e) => notes.includes(e.ownSku))).toHaveLength(0);
      expect(rows.find((e) => e.competitorCodeNorm === `${TAG}-PUB1`)?.ownSku).toBe(`${TAG}-A`);
      expect(rows.find((e) => e.competitorCodeNorm === `${TAG}-PUB2`)?.ownSku).toBe(`${TAG}-B`);
      // every redirected entry points at a catalog SKU
      const redirected = rows.filter((e) => e.ownSku !== (e.ownSku ?? "").toUpperCase() || false);
      expect(redirected).toHaveLength(0);
      expect(rows.every((e) => catalog.has(e.ownSku) || !isPlaceholderSku(e.ownSku))).toBe(true);
    } finally {
      // Put the previously published version back so the rest of the suites keep their pinned version.
      await prisma.crosswalkVersionEntry.deleteMany({ where: { versionId: version.id } });
      await prisma.crosswalkVersion.delete({ where: { id: version.id } });
      if (previous) await prisma.crosswalkVersion.update({ where: { id: previous.id }, data: { status: "PUBLISHED", supersededAt: null } });
    }
  }, 120_000);
});

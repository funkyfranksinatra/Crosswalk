/**
 * The request pipeline: resolve → bin → match → rank. Executed by the `request.run`
 * queue (src/lib/jobs) so a server restart cannot lose a run: every stage writes a
 * checkpoint, and a retried job resumes after the last completed stage instead of
 * starting over. Every step is persisted so the UI can poll progress.
 *
 * Resumability rules (checked by scripts/test-tier1.ts):
 *   - resolve: lines already resolved / not-found are kept; only pending lines are looked up
 *   - bin: bins are cached on the CompetitorProduct row; a re-run re-uses them
 *   - match/grade: deterministic and cached (LlmGrade); the previous candidates are only
 *     replaced at the very end, so an interrupted run leaves the last complete result visible
 *   - cancel: `cancelRequested` on the request is honoured between stages and inside loops
 */
import { prisma } from "@/lib/db";
import { log as slog } from "@/lib/log";
import { runsFinished, lastRunResolution, lastRunMatch } from "@/lib/observability/metrics";
import { specFor } from "@/lib/excel/sizes";
import { compactCfn, isPlaceholderSku } from "@/lib/cfn";
import { num, toDb, times } from "@/lib/money";
import { summarizeRecord, type OpenFdaRecord } from "@/lib/gudid/openfda";
import { binProduct } from "@/lib/llm/tasks";
import { groupSiblings, gradeGroup, applyGroupGrades, type GradeLineInput } from "@/lib/match/grading";
import { resolveCfn, buildContext, type ResolutionContext } from "./resolve";
import { llmConfig, llmPreflight } from "@/lib/llm/client";
import { parseBin, binSimilarity, type Bin, heuristicBin } from "@/lib/match/bin";
import { scoreCandidates, DEFAULT_WEIGHTS, type Weights, type CandidateInput, type ScoredCandidate } from "@/lib/match/score";
import { embeddingsEnabled, ensureCompetitorEmbedding, nearestOwnProducts, RETRIEVAL_K } from "@/lib/match/embeddings";
import { getSettings } from "@/lib/settings";

export class RunCancelled extends Error {
  constructor() { super("cancelled"); this.name = "RunCancelled"; }
}
/** The queue aborted this attempt (expiry / shutdown): not a user decision, the retry resumes. */
export class RunInterrupted extends Error {
  constructor() { super("interrupted"); this.name = "RunInterrupted"; }
}

export type RunOptions = { jobId?: string | null; attempt?: number; freshGrades?: boolean; signal?: AbortSignal; /** continue from the checkpoint even on attempt 1 (orphan recovery) */ resume?: boolean; /** the queue will not retry after this attempt */ finalAttempt?: boolean };

/**
 * Queue a run. Idempotent per request: while a job for this request is queued or running,
 * a second call returns `{ alreadyQueued: true }` instead of starting another.
 */
export async function enqueueRun(requestId: string, opts: { freshGrades?: boolean; useLlm?: boolean } = {}) {
  const { enqueue } = await import("@/lib/jobs/boss");
  const r = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { optionsJson: true, status: true, jobId: true, checkpoint: true } });
  // Already in flight? Only if a live job exists — a freshly created request also says "queued" (no job yet).
  const inFlight = ["queued", "running"].includes(r.status);
  if (inFlight && r.jobId) {
    const { getBoss } = await import("@/lib/jobs/boss");
    const job = await (await getBoss()).getJobById("request.run", r.jobId).catch(() => null);
    if (job && ["created", "retry", "active"].includes(job.state)) return { jobId: null, alreadyQueued: true };
  }
  // In flight on paper but with no live job (an orphan): re-queue it and let it resume its checkpoint.
  const resume = inFlight && Boolean(r.checkpoint);
  const options = r.optionsJson ? (safeJson(r.optionsJson) ?? {}) : {};
  // Enqueue first: a deduplicated send (a job for this request is queued or active) must not
  // touch the row — resetting it would wipe the checkpoint the running attempt relies on.
  let res: { jobId: string | null; deduplicated: boolean };
  try {
    res = await enqueue("request.run", { requestId, freshGrades: Boolean(opts.freshGrades), ...(resume ? { resume: true } : {}) }, { singletonKey: requestId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.request.update({ where: { id: requestId }, data: { status: "failed", stage: "Could not queue", error: `The job queue is unavailable: ${message}` } }).catch(() => undefined);
    throw new Error("The job queue is unavailable right now; try again in a moment");
  }
  if (res.jobId) await prisma.request.update({ where: { id: requestId }, data: { status: "queued", progress: 0, stage: resume ? "Queued (resuming)" : "Queued", error: null, ...(resume ? {} : { checkpoint: null }), cancelRequested: false, jobId: res.jobId, optionsJson: JSON.stringify({ ...options, freshGrades: Boolean(opts.freshGrades) }), ...(typeof opts.useLlm === "boolean" ? { useLlm: opts.useLlm } : {}) } });
  return { jobId: res.jobId, alreadyQueued: res.deduplicated, resumed: resume };
}

function safeJson(text: string): Record<string, unknown> | null {
  try { const v = JSON.parse(text); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}

/** Ask a queued or running run to stop. Queued jobs are cancelled outright; running ones stop at the next checkpoint. */
export async function cancelRun(requestId: string) {
  const r = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, jobId: true } });
  if (!["queued", "running"].includes(r.status)) return { cancelled: false, status: r.status };
  // The flag is only ever cleared by the handler that honours it (or by a fresh enqueue), so a
  // cancel that lands while the worker is between "claimed" and "running" is not lost.
  await prisma.request.update({ where: { id: requestId }, data: { cancelRequested: true } });
  // Still queued (not picked up): mark it cancelled here. The conditional update loses the race
  // to a handler that just flipped the row to running — in which case the handler stops itself.
  const claimed = await prisma.request.updateMany({ where: { id: requestId, status: "queued" }, data: { status: "cancelled", stage: "Cancelled", cancelRequested: false } });
  if (claimed.count === 1) {
    if (r.jobId) { const { getBoss } = await import("@/lib/jobs/boss"); await (await getBoss()).cancel("request.run", r.jobId).catch(() => undefined); }
    return { cancelled: true, status: "cancelled" };
  }
  return { cancelled: true, status: "running" };
}

async function checkCancelled(requestId: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new RunInterrupted();
  const r = await prisma.request.findUnique({ where: { id: requestId }, select: { cancelRequested: true } });
  if (r?.cancelRequested) throw new RunCancelled();
}

const STAGE_ORDER = ["resolve", "bin", "match"] as const;
type Stage = (typeof STAGE_ORDER)[number];
const stageDone = (checkpoint: string | null, stage: Stage) => checkpoint !== null && STAGE_ORDER.indexOf(checkpoint as Stage) >= STAGE_ORDER.indexOf(stage);

/** Append one log line atomically (concurrent workers must not lose each other's lines); keeps the last 200. */
async function log(requestId: string, message: string) {
  const entry = JSON.stringify({ t: new Date().toISOString(), m: message });
  await prisma.$executeRawUnsafe(
    `UPDATE "Request" SET "logJson" = (
       SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb)::text FROM (
         SELECT e, n FROM jsonb_array_elements((CASE WHEN "logJson" ~ '^\\s*\\[' THEN "logJson"::jsonb ELSE '[]'::jsonb END) || $2::jsonb) WITH ORDINALITY AS t(e, n)
         ORDER BY n DESC LIMIT 200
       ) AS last
     ) WHERE id = $1`,
    requestId, `[${entry}]`,
  ).catch(async () => {
    // Fallback (unparseable log column): reset it with this line.
    await prisma.request.update({ where: { id: requestId }, data: { logJson: `[${entry}]` } }).catch(() => undefined);
  });
}

/** Progress write; a job whose signal the queue aborted must not keep writing alongside its retry. */
async function setStage(requestId: string, stage: string, progress: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new RunInterrupted();
  await prisma.request.update({ where: { id: requestId }, data: { stage, progress: Math.min(100, Math.round(progress)) } });
}

/** One own product with a usable bin (rebuilt heuristically if stale), for a neighbour outside the preloaded pool. */
async function loadOwnWithBin(id: string, pricebookId: string | null) {
  const p = await prisma.ownProduct.findUnique({ where: { id }, omit: { gudidJson: true }, include: { prices: pricebookId ? { where: { pricebookId } } : false } });
  if (!p || !p.isActive) return null;
  let bin = parseBin(p.binJson);
  if (!bin) {
    const full = await prisma.ownProduct.findUnique({ where: { id }, select: { gudidJson: true } });
    const raw = full?.gudidJson ? (JSON.parse(full.gudidJson) as OpenFdaRecord) : null;
    const g = raw ? summarizeRecord(raw) : null;
    bin = heuristicBin({ sku: p.sku, brand: p.brand, description: g ? `${p.description} ; ${g.description ?? ""}` : p.description, category: p.category, gmdnName: p.gmdnName, specialties: g?.specialties, sizes: g?.sizes, singleUse: g?.singleUse, sterile: g?.sterile, implantable: g?.implantable });
  }
  return { p, bin };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runRequest(requestId: string, runOpts: RunOptions = {}) {
  const attempt = runOpts.attempt ?? 1;
  try {
    await runRequestInner(requestId, runOpts);
  } catch (e) {
    if (e instanceof RunCancelled) {
      await prisma.request.update({ where: { id: requestId }, data: { status: "cancelled", stage: "Cancelled", cancelRequested: false, completedAt: new Date() } });
      await log(requestId, "Cancelled by request");
      runsFinished.inc({ outcome: "cancelled" });
      await notifyFinished(requestId).catch(() => undefined);
      return;
    }
    if (e instanceof RunInterrupted && !runOpts.finalAttempt) {
      // The queue took the job away (expiry / shutdown); status and checkpoint stay for the retry.
      await prisma.request.update({ where: { id: requestId }, data: { stage: `Interrupted (attempt ${attempt}) — will resume` } }).catch(() => undefined);
      await log(requestId, `Interrupted by the queue during attempt ${attempt}; the retry resumes from the last checkpoint`);
      slog.warn("run.interrupted", { crossRef: requestId, attempt });
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    const { publicErrorMessage } = await import("@/lib/api");
    const final = runOpts.finalAttempt ?? true;
    // Only the last attempt is a failure the user sees; earlier ones stay "running" and say why.
    // Not final: the retry is queued, so the row says "queued" with the reason; the checkpoint stays.
    await prisma.request.update({ where: { id: requestId }, data: final ? { status: "failed", error: publicErrorMessage(e), stage: "Failed" } : { status: "queued", stage: `Attempt ${attempt} failed — retrying from the last checkpoint`, error: publicErrorMessage(e) } });
    await log(requestId, `${final ? "Failed" : `Attempt ${attempt} failed, will retry`}: ${publicErrorMessage(e)}`);
    runsFinished.inc({ outcome: final ? "failed" : "retry" });
    slog.error("run.failed", { crossRef: requestId, attempt, final, error: message });
    if (final) await notifyFinished(requestId).catch(() => undefined);
    throw e; // let the queue retry from the checkpoint
  }
}

async function notifyFinished(requestId: string) {
  const { notifyRunFinished } = await import("@/lib/notifications");
  await notifyRunFinished(requestId);
}

async function runRequestInner(requestId: string, runOpts: RunOptions) {
  const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, include: { lines: { orderBy: { lineNo: "asc" } }, company: true } });
  const settings = await getSettings();
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...(request.optionsJson ? JSON.parse(request.optionsJson).weights ?? {} : settings.weights) };
  let useLlm = request.useLlm && llmConfig().available;
  const resuming = (runOpts.attempt ?? 1) > 1 || Boolean(runOpts.resume);
  // Attempts are monotonic across retries AND restarts (a recovered orphan is a new job with retryCount 0).
  const attempt = resuming ? Math.max(runOpts.attempt ?? 1, request.attempt + 1) : Math.max(1, runOpts.attempt ?? 1);
  // A retry (or a recovered orphan) resumes after the last completed stage; a fresh run starts clean.
  const resumeFrom = resuming ? request.checkpoint : null;
  if (!resumeFrom && request.checkpoint) await prisma.request.update({ where: { id: requestId }, data: { checkpoint: null } });

  // A cancel that arrived while the job sat in the queue is honoured before any work starts, and the
  // queued→running transition is conditional so a cancel racing this exact moment still wins.
  await checkCancelled(requestId, runOpts.signal);
  const started = await prisma.request.updateMany({ where: { id: requestId, cancelRequested: false, status: { notIn: ["cancelled"] } }, data: { status: "running", startedAt: resumeFrom ? request.startedAt ?? new Date() : new Date(), error: null, progress: 0, attempt, jobId: runOpts.jobId ?? request.jobId } });
  if (started.count !== 1) throw new RunCancelled();
  if (resumeFrom) await log(requestId, `Resumed (attempt ${attempt}) after an interrupted run — stage "${resumeFrom}" was complete, continuing from there`);

  // Prove the model works before we depend on it, and record the outcome on the request so the UI can say so.
  const options = request.optionsJson ? JSON.parse(request.optionsJson) : {};
  let modelStatus: { requested: boolean; used: boolean; model: string; error?: string };
  if (!request.useLlm) modelStatus = { requested: false, used: false, model: llmConfig().model };
  else if (!llmConfig().available) modelStatus = { requested: true, used: false, model: llmConfig().model, error: "OPENAI_API_KEY is not set in .env (restart the server after adding it)" };
  else {
    await setStage(requestId, "Checking the model", 1);
    const pf = await llmPreflight();
    modelStatus = pf.ok ? { requested: true, used: true, model: pf.model } : { requested: true, used: false, model: pf.model, error: pf.error };
    if (!pf.ok) useLlm = false;
  }
  await prisma.request.update({ where: { id: requestId }, data: { optionsJson: JSON.stringify({ ...options, model: modelStatus, freshGrades: false }) } });
  await log(requestId, useLlm ? `Run started · ${request.lines.length} lines · model ${modelStatus.model} (preflight OK)` : `Run started · ${request.lines.length} lines · heuristic matching${modelStatus.error ? ` — MODEL UNAVAILABLE: ${modelStatus.error}` : ""}`);

  // Previous candidates stay visible until the new result is complete (see header).
  const siblingCfns = request.lines.map((l) => l.cfnNorm);
  const preferCompanies = JSON.parse(request.company.labelers || "[]") as string[];

  // ---- Stage 1: resolve (two passes) --------------------------------------
  const total = request.lines.length;
  let done = 0;
  const skipResolve = stageDone(resumeFrom, "resolve");
  if (skipResolve) await log(requestId, "Resolution stage already complete — reusing it");
  else await setStage(requestId, "Resolving competitor products in GUDID", 2);
  // On a retry, lines that already have an answer are not looked up again.
  const toResolve = skipResolve ? [] : resuming ? request.lines.filter((l) => !["resolved", "not-found"].includes(l.resolutionStatus)) : request.lines;
  if (resuming && !skipResolve && toResolve.length < total) await log(requestId, `Resolving ${toResolve.length} of ${total} lines (the rest were resolved before the interruption)`);
  const applyResolution = async (line: (typeof request.lines)[number], cp: Awaited<ReturnType<typeof resolveCfn>>) => {
    if (!cp) return;
    await prisma.requestLine.update({
      where: { id: line.id },
      data: { competitorProductId: cp.id, resolutionStatus: cp.resolution === "not-found" ? "not-found" : "resolved", resolutionNote: cp.resolutionNote },
    });
  };
  // Pass 1: unambiguous codes only.
  const pending: typeof request.lines = [];
  await mapLimit(toResolve, 3, async (line, i) => {
    if (i % 10 === 9) await checkCancelled(requestId, runOpts.signal);
    try {
      const cp = await resolveCfn(line.cfnNorm, { useLlm, strict: true, siblingCfns, accountName: request.accountName });
      if (cp) await applyResolution(line, cp); else pending.push(line);
    } catch (e) {
      pending.push(line);
      await log(requestId, `  ${line.cfnNorm}: ${e instanceof Error ? e.message : String(e)}`);
    }
    done++;
    await setStage(requestId, `Resolving competitor products in GUDID (${done}/${toResolve.length})`, 2 + (done / Math.max(1, toResolve.length)) * 20, runOpts.signal);
  });
  await checkCancelled(requestId, runOpts.signal);
  // Build the request context from what we know so far, then pass 2.
  const firstPass = await prisma.requestLine.findMany({ where: { requestId, resolutionStatus: "resolved" }, include: { competitorProduct: true } });
  const ctx: ResolutionContext = buildContext(
    firstPass.map((l) => ({ manufacturer: l.competitorProduct?.manufacturer ?? null, category: l.competitorProduct?.category ?? null, binFamily: l.competitorProduct ? heuristicBin({ brand: l.competitorProduct.brand, description: l.competitorProduct.description, gmdnName: l.competitorProduct.gmdnName }).family : null })),
    siblingCfns,
    request.company.name,
    preferCompanies,
  );
  if (ctx.commonPrefixes.length) await log(requestId, `Detected list-wide item-number prefix ${ctx.commonPrefixes.join(", ")}`);
  if (pending.length) await log(requestId, `Pass 2: ${pending.length} ambiguous codes resolved with list context (${[...ctx.manufacturers.keys()].join(", ") || "no manufacturers yet"})`);
  done = 0;
  await mapLimit(pending, 3, async (line, i) => {
    if (i % 10 === 9) await checkCancelled(requestId, runOpts.signal);
    try {
      const cp = await resolveCfn(line.cfnNorm, { useLlm, ctx, siblingCfns, accountName: request.accountName });
      await applyResolution(line, cp);
    } catch (e) {
      await prisma.requestLine.update({ where: { id: line.id }, data: { resolutionStatus: "error", resolutionNote: e instanceof Error ? e.message : String(e) } });
    }
    done++;
    await setStage(requestId, `Resolving ambiguous codes with list context (${done}/${pending.length})`, 22 + (done / Math.max(1, pending.length)) * 18, runOpts.signal);
  });
  const resolvedCount = await prisma.requestLine.count({ where: { requestId, resolutionStatus: "resolved" } });
  if (!skipResolve) await log(requestId, `Resolved ${resolvedCount}/${total} competitor codes`);
  await prisma.request.update({ where: { id: requestId }, data: { checkpoint: "resolve" } });
  await checkCancelled(requestId, runOpts.signal);

  // Codes that turn out to be *our own* products: make sure they are in the catalog so they self-match.
  const ours = await prisma.requestLine.findMany({ where: { requestId, resolutionStatus: "resolved", competitorProduct: { manufacturer: request.company.name } }, include: { competitorProduct: true } });
  for (const l of ours) {
    const cp = l.competitorProduct!;
    const sku = (cp.cfnMatched ?? cp.cfnNorm).toUpperCase();
    if (isPlaceholderSku(sku)) continue;
    const exists = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: request.companyId, sku } } });
    if (!exists) {
      const raw = cp.gudidJson ? (JSON.parse(cp.gudidJson) as OpenFdaRecord) : null;
      const s = raw ? summarizeRecord(raw) : null;
      const bin = heuristicBin({ sku, brand: cp.brand, description: cp.description, gmdnName: cp.gmdnName, specialties: s?.specialties, sizes: s?.sizes, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable });
      await prisma.ownProduct.create({ data: { companyId: request.companyId, sku, description: cp.description ?? sku, category: bin.family, brand: cp.brand, labeler: cp.labeler, status: cp.status, gudidDi: cp.gudidDi, gmdnName: cp.gmdnName, gmdnCode: cp.gmdnCode, fdaProductCode: cp.fdaProductCode, gudidJson: cp.gudidJson, gudidSyncedAt: new Date(), binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date() } });
      await log(requestId, `Added our own SKU ${sku} to the catalog (customer already buys it from us)`);
    }
  }

  // ---- Stage 2: bin competitor products ------------------------------------
  const lines = await prisma.requestLine.findMany({ where: { requestId }, include: { competitorProduct: true }, orderBy: { lineNo: "asc" } });
  const uniqueCps = new Map<string, NonNullable<(typeof lines)[number]["competitorProduct"]>>();
  for (const l of lines) if (l.competitorProduct && l.competitorProduct.resolution !== "not-found") uniqueCps.set(l.competitorProduct.id, l.competitorProduct);
  await setStage(requestId, "Binning competitor products", 42);
  let binned = 0;
  await mapLimit([...uniqueCps.values()], 3, async (cp, i) => {
    if (i % 10 === 9) await checkCancelled(requestId, runOpts.signal);
    if (!parseBin(cp.binJson) || (useLlm && cp.binSource !== "llm")) {
      const raw = cp.gudidJson ? (JSON.parse(cp.gudidJson) as OpenFdaRecord) : null;
      const s = raw ? summarizeRecord(raw) : null;
      // The curated sheets often describe a competitor code better than its GUDID record (sizes, cannula type…).
      const curated = await prisma.knownCross.findFirst({ where: { competitorCodeNorm: { in: [cp.cfnNorm, compactCfn(cp.cfnNorm), (cp.cfnMatched ?? "").toUpperCase()] }, competitorDescription: { not: null } }, select: { competitorDescription: true } });
      const description = [cp.description, curated?.competitorDescription].filter((x): x is string => Boolean(x) && !(cp.description ?? "").includes(x!)).join(" ; ");
      // Codes that are our own SKUs (the customer already buys them from us) get the size our
      // catalog-number convention encodes, exactly like the catalog side does.
      const ownSku = cp.manufacturer === request.company.name ? (cp.cfnMatched ?? cp.cfnNorm).toUpperCase() : null;
      // Sizes the rep imported for this code (Catalog → Competitor sizes) beat GUDID and regex.
      const spec = await specFor([cp.cfnNorm, cp.cfnMatched]);
      if (spec) await log(requestId, `  ${cp.cfnNorm}: using imported competitor size (${spec.dims.map((d) => `${d.name} ${d.value} ${d.unit}`).join(", ")})`);
      const { bin, source } = await binProduct({
        subject: cp.cfnNorm,
        sku: ownSku,
        importedSizes: spec?.dims ?? null,
        name: cp.brand,
        description: description || cp.description,
        brand: cp.brand,
        manufacturer: cp.manufacturer,
        gmdnName: cp.gmdnName,
        gmdnDefinition: raw?.gmdn_terms?.[0]?.definition ?? null,
        category: cp.category,
        sizes: s?.sizes ?? null,
        singleUse: s?.singleUse ?? null,
        sterile: s?.sterile ?? null,
        implantable: s?.implantable ?? null,
        specialties: s?.specialties ?? null,
        useLlm,
      });
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { binJson: JSON.stringify(bin), binSource: source, binnedAt: new Date(), category: cp.category ?? bin.family } });
    }
    binned++;
    await setStage(requestId, `Binning competitor products (${binned}/${uniqueCps.size})`, 42 + (binned / Math.max(1, uniqueCps.size)) * 18, runOpts.signal);
  });

  await prisma.request.update({ where: { id: requestId }, data: { checkpoint: "bin" } });
  await checkCancelled(requestId, runOpts.signal);

  // ---- Stage 3: match & rank ---------------------------------------------
  await setStage(requestId, "Matching against our catalog", 60);
  // Candidate pool: every curated / hand-added SKU, plus SKUs adopted from GUDID imports only in the
  // families this list is about (a whole-labeler import can be tens of thousands of rows). gudidJson
  // is fetched lazily — only for rows that need (re)binning.
  const requestFamilies = new Set<string>();
  for (const cp of uniqueCps.values()) { const b = parseBin(cp.binJson, { allowStale: true }); if (b && b.family !== "Other") requestFamilies.add(b.family); }
  const ownProducts = await prisma.ownProduct.findMany({
    where: { companyId: request.companyId, isActive: true, OR: [{ source: { not: "gudid-import" } }, { category: { in: [...requestFamilies] } }] },
    omit: { gudidJson: true },
    include: { prices: request.pricebookId ? { where: { pricebookId: request.pricebookId } } : false },
  });
  await log(requestId, `Candidate pool: ${ownProducts.length} SKUs (${ownProducts.filter((p) => p.source === "gudid-import").length} from GUDID imports in ${[...requestFamilies].join(", ") || "no families"})`);
  // Own bins: keep model bins and current-version heuristic bins; rebuild stale ones (with GUDID sizes) and persist.
  const ownWithBins = await mapLimit(ownProducts, 8, async (p, i) => {
    if (i % 200 === 199) await checkCancelled(requestId, runOpts.signal);
    const existing = parseBin(p.binJson);
    if (existing) return { p, bin: existing };
    const full = await prisma.ownProduct.findUnique({ where: { id: p.id }, select: { gudidJson: true } });
    const raw = full?.gudidJson ? (JSON.parse(full.gudidJson) as OpenFdaRecord) : null;
    const g = raw ? summarizeRecord(raw) : null;
    const bin = heuristicBin({ sku: p.sku, brand: p.brand, description: g ? `${p.description} ; ${g.description ?? ""}` : p.description, category: p.category, gmdnName: p.gmdnName, specialties: g?.specialties, sizes: g?.sizes, singleUse: g?.singleUse, sterile: g?.sterile, implantable: g?.implantable });
    await prisma.ownProduct.update({ where: { id: p.id }, data: { binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date(), ...(p.source === "gudid-import" ? { category: bin.family } : {}) } });
    return { p, bin };
  });
  // Embedding retrieval (Tier 3): when the catalog is embedded, each line's attribute scan is limited to
  // its nearest neighbours instead of the whole pool. Missing vectors fall back to the scan, per line.
  const ownById = new Map(ownWithBins.map((o) => [o.p.id, o]));
  let useEmbeddings = embeddingsEnabled();
  const retrievalStats = { ann: 0, scan: 0 };
  // Per-run memo: one embedding per competitor product however many lines share it (and one lazy load per
  // neighbour, whichever line asks first — the promise is stored before it resolves, so there is no race).
  const competitorVectors = new Map<string, Promise<number[] | null>>();
  const lazyLoads = new Map<string, Promise<(typeof ownWithBins)[number] | null>>();
  if (useEmbeddings) await log(requestId, `Embedding retrieval on: nearest ${RETRIEVAL_K} catalog products per line, attribute scan as fallback`);
  // Approved crosses carry the tier floor; rep-proposed drafts ride along as soft priors (xref/learning.ts).
  const { crossesForMatching } = await import("@/lib/xref/learning");
  const knownCrosses = await crossesForMatching();
  const crossesByCode = new Map<string, typeof knownCrosses>();
  for (const k of knownCrosses) {
    const arr = crossesByCode.get(k.competitorCodeNorm) ?? [];
    arr.push(k);
    crossesByCode.set(k.competitorCodeNorm, arr);
  }

  const freshLines = await prisma.requestLine.findMany({ where: { requestId }, include: { competitorProduct: true }, orderBy: { lineNo: "asc" } });
  type LineWork = { line: (typeof freshLines)[number]; scored: ScoredCandidate[]; gradeInput: GradeLineInput | null };
  const work: LineWork[] = [];
  let matched = 0;

  // ---- Phase A: retrieve + score every line (deterministic) ---------------
  await mapLimit(freshLines, 2, async (line, i) => {
    if (i % 10 === 9) await checkCancelled(requestId, runOpts.signal);
    try {
      const cp = line.competitorProduct;
      const compBin = cp ? parseBin(cp.binJson, { allowStale: true }) : null;
      const crosses = [...(crossesByCode.get(line.cfnNorm) ?? []), ...(crossesByCode.get(compactCfn(line.cfnNorm)) ?? [])];

      if (!cp || cp.resolution === "not-found" || !compBin) {
        if (crosses.length === 0) {
          await prisma.requestLine.update({ where: { id: line.id }, data: { matchStatus: "no-match" } });
          return;
        }
      }

      // Candidate retrieval: curated crosses + top attribute neighbours in the same family.
      const candidateIds = new Set<string>();
      const crossBySku = new Map<string, (typeof crosses)[number]>();
      for (const k of crosses) {
        const sku = (k.preferredOwnSku && /^[A-Z0-9-]{4,}$/i.test(k.preferredOwnSku.trim()) ? k.preferredOwnSku : k.ownSku).trim().toUpperCase();
        const own = ownWithBins.find((o) => o.p.sku.toUpperCase() === sku);
        if (own) {
          candidateIds.add(own.p.id);
          const cur = crossBySku.get(own.p.id);
          const approved = (x: { approvalStatus: string }) => x.approvalStatus === "APPROVED";
          if (!cur || (approved(k) && !approved(cur)) || (approved(k) === approved(cur) && betterCross(k.matchType, cur.matchType))) crossBySku.set(own.p.id, k);
        }
      }
      if (compBin) {
        // Who to compare: the embedding neighbours when we have them, else the whole family pool.
        let pool = ownWithBins.filter((o) => compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family);
        let viaAnn = false;
        if (useEmbeddings && cp) {
          try {
            let vp = competitorVectors.get(cp.id);
            if (!vp) { vp = ensureCompetitorEmbedding(cp); competitorVectors.set(cp.id, vp); }
            const vector = await vp;
            // Over-fetch, then keep the neighbours in this line's family (the bin family, not the catalog category).
            const raw = vector ? await nearestOwnProducts(vector, { companyId: request.companyId, k: RETRIEVAL_K, overfetch: compBin.family === "Other" ? 1 : 4 }) : [];
            const loaded: (typeof ownWithBins)[number][] = [];
            for (const n of raw) {
              let o = ownById.get(n.id);
              if (!o) {
                // A neighbour outside the preloaded pool (a GUDID-import row in another family): load its bin lazily, once.
                let lp = lazyLoads.get(n.id);
                if (!lp) { lp = loadOwnWithBin(n.id, request.pricebookId) as Promise<(typeof ownWithBins)[number] | null>; lazyLoads.set(n.id, lp); }
                const extra = await lp;
                if (extra && !ownById.has(extra.p.id)) { ownById.set(extra.p.id, extra); ownWithBins.push(extra); }
                o = extra ?? undefined;
              }
              if (o && (compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family)) loaded.push(o);
              if (loaded.length >= RETRIEVAL_K) break;
            }
            // Too few neighbours in the family means the index did not cover it: the scan is the safer shortlist.
            if (loaded.length >= Math.min(5, Math.ceil(RETRIEVAL_K / 4))) { pool = loaded; viaAnn = true; }
          } catch (e) {
            // One failure trips the breaker for the rest of the run: no per-line retry storm against a dead endpoint.
            useEmbeddings = false;
            await log(requestId, `  ${line.cfnNorm}: embedding retrieval failed (${e instanceof Error ? e.message.slice(0, 120) : String(e)}) — attribute scan for the rest of this run`);
            pool = ownWithBins.filter((o) => compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family);
          }
        }
        if (viaAnn) retrievalStats.ann++; else retrievalStats.scan++;
        const ranked = pool
          .map((o) => ({ o, s: binSimilarity(compBin, o.bin, cp?.description ?? "", o.p.description).score }))
          .sort((a, b) => b.s - a.s)
          .slice(0, settings.maxCandidates);
        for (const r of ranked) if (r.s >= 0.3) candidateIds.add(r.o.p.id);
      }

      const selfSku = cp?.manufacturer === request.company.name ? (cp.cfnMatched ?? cp.cfnNorm).toUpperCase() : null;
      if (selfSku) { const self = ownWithBins.find((o) => o.p.sku.toUpperCase() === selfSku); if (self) candidateIds.add(self.p.id); }
      const seenIds = new Set<string>();
      const candidates = ownWithBins.filter((o) => candidateIds.has(o.p.id) && !seenIds.has(o.p.id) && seenIds.add(o.p.id));
      if (candidates.length === 0) {
        await prisma.requestLine.update({ where: { id: line.id }, data: { matchStatus: "no-match" } });
        return;
      }

      // Make sure our candidates have model-quality bins when a model is available (lazy, cached).
      if (useLlm) {
        await mapLimit(candidates, 3, async (c) => {
          if (c.p.binSource === "llm") return;
          const full = await prisma.ownProduct.findUnique({ where: { id: c.p.id }, select: { gudidJson: true } });
          const raw = full?.gudidJson ? (JSON.parse(full.gudidJson) as OpenFdaRecord) : null;
          const s = raw ? summarizeRecord(raw) : null;
          const { bin, source } = await binProduct({ subject: c.p.sku, sku: c.p.sku, name: c.p.brand, brand: c.p.brand, description: c.p.description, manufacturer: c.p.labeler ?? request.company.name, gmdnName: c.p.gmdnName, gmdnDefinition: raw?.gmdn_terms?.[0]?.definition ?? null, category: c.p.category, sizes: s?.sizes ?? null, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable, specialties: s?.specialties ?? null, useLlm });
          c.bin = bin;
          c.p.binSource = source;
          await prisma.ownProduct.update({ where: { id: c.p.id }, data: { binJson: JSON.stringify(bin), binSource: source, binnedAt: new Date() } });
        });
      }

      const competitorForScore = { bin: compBin ?? heuristicBin({ description: crosses[0]?.competitorDescription }), description: cp?.description ?? crosses[0]?.competitorDescription ?? "", estPrice: num(line.estCompetitorPrice) };
      const inputs: CandidateInput[] = candidates.map((c) => {
        const k = crossBySku.get(c.p.id);
        const pb = Array.isArray(c.p.prices) ? c.p.prices[0] : undefined;
        return {
          ownProductId: c.p.id,
          sku: c.p.sku,
          description: c.p.description,
          bin: c.bin,
          unitPrice: num(pb?.price ?? c.p.listPrice),
          cogs: num(c.p.cogs),
          identity: selfSku != null && c.p.sku.toUpperCase() === selfSku,
          provenance: c.p.source,
          knownCross: k ? { matchType: k.matchType, preferredOwnSku: k.preferredOwnSku, additionalProducts: k.additionalProducts, notes: k.notes, source: k.source, approvalStatus: k.approvalStatus, endorsements: k.endorsements } : null,
        };
      });
      const scored = scoreCandidates(competitorForScore, inputs, weights);
      work.push({
        line,
        scored,
        gradeInput: useLlm && cp && compBin ? { lineId: line.id, cfn: line.cfnNorm, manufacturer: cp.manufacturer, brand: cp.brand, description: cp.description, bin: compBin, candidates: scored } : null,
      });
    } catch (e) {
      await prisma.requestLine.update({ where: { id: line.id }, data: { matchStatus: "error", resolutionNote: e instanceof Error ? e.message : String(e) } });
    } finally {
      matched++;
      await setStage(requestId, `Matching against our catalog (${matched}/${freshLines.length})`, 60 + (matched / Math.max(1, freshLines.length)) * (useLlm ? 18 : 38), runOpts.signal);
    }
  });

  if (useEmbeddings) await log(requestId, `Retrieval: ${retrievalStats.ann} line(s) by embedding neighbours, ${retrievalStats.scan} by attribute scan`);

  // ---- Phase B: model grading, siblings together, verdicts cached ---------
  await checkCancelled(requestId, runOpts.signal);
  const graded = new Map<string, ScoredCandidate[]>();
  if (useLlm) {
    const inputs = work.map((w) => w.gradeInput).filter((g): g is GradeLineInput => g !== null);
    const groups = groupSiblings(inputs);
    await log(requestId, `Grading ${inputs.length} lines in ${groups.length} sibling group(s)`);
    let doneGroups = 0;
    let cachedGroups = 0;
    await mapLimit(groups, 2, async (group, gi) => {
      if (gi % 5 === 4) await checkCancelled(requestId, runOpts.signal);
      const { grade, cached } = await gradeGroup(group, request.company.name, (m) => log(requestId, m), { ignoreCache: Boolean(options.freshGrades) });
      if (cached) cachedGroups++;
      for (const [lineId, scored] of applyGroupGrades(group, grade, cached)) graded.set(lineId, scored);
      doneGroups++;
      await setStage(requestId, `Grading with the model (${doneGroups}/${groups.length} groups)`, 78 + (doneGroups / Math.max(1, groups.length)) * 20, runOpts.signal);
    });
    if (cachedGroups) await log(requestId, `${cachedGroups} of ${groups.length} verdicts replayed from cache (inputs unchanged since last run)`);
  }

  await checkCancelled(requestId, runOpts.signal);
  // ---- Phase C: persist -----------------------------------------------------
  // Only now do the previous run's candidates go: an interruption before this point leaves them intact.
  // Each line is replaced in one transaction, so a crash mid-way never leaves a line pointing at a deleted candidate.
  const workedIds = new Set(work.map((w) => w.line.id));
  await prisma.$transaction([
    prisma.requestLine.updateMany({ where: { requestId, id: { notIn: [...workedIds] } }, data: { selectedCandidateId: null } }),
    prisma.matchCandidate.deleteMany({ where: { line: { requestId, id: { notIn: [...workedIds] } } } }),
  ]);
  for (const w of work) {
    const line = w.line;
    const scored = graded.get(line.id) ?? w.scored;
    const keep = scored.filter((s) => s.matchType !== "No Match").slice(0, settings.maxCandidates);
    const rows = (keep.length ? keep : scored.slice(0, 3)).map((s, i) => ({
      lineId: line.id,
      ownProductId: s.ownProductId,
      rank: i + 1,
      matchType: s.matchType,
      source: s.source,
      score: s.score,
      scoreBin: s.scoreBin,
      scorePrice: s.scorePrice,
      scoreCogs: s.scoreCogs,
      scoreMargin: s.scoreMargin,
      factorsJson: JSON.stringify(s.factors),
      rationale: s.rationale,
      additionalProducts: (s as { additionalProducts?: string }).additionalProducts ?? s.knownCross?.additionalProducts ?? null,
      unitPrice: toDb(s.unitPrice),
      extended: toDb(times(s.unitPrice, line.quantity)),
      isSelected: i === 0 && s.matchType !== "No Match",
    }));
    await prisma.$transaction(async (tx) => {
      await tx.matchCandidate.deleteMany({ where: { lineId: line.id } });
      await tx.matchCandidate.createMany({ data: rows });
      const first = await tx.matchCandidate.findFirst({ where: { lineId: line.id, rank: 1 } });
      await tx.requestLine.update({
        where: { id: line.id },
        data: { matchStatus: first && first.matchType !== "No Match" ? "matched" : "no-match", selectedCandidateId: first && first.matchType !== "No Match" ? first.id : null },
      });
    });
  }

  const matchedCount = await prisma.requestLine.count({ where: { requestId, matchStatus: "matched" } });
  await log(requestId, `Matched ${matchedCount}/${total} lines`);
  await prisma.request.update({ where: { id: requestId }, data: { status: "complete", stage: "Complete", progress: 100, completedAt: new Date(), checkpoint: "match", cancelRequested: false } });
  runsFinished.inc({ outcome: "complete" });
  if (total > 0) { lastRunResolution.set({}, resolvedCount / total); lastRunMatch.set({}, matchedCount / total); }
  slog.info("run.complete", { crossRef: requestId, lines: total, resolved: resolvedCount, matched: matchedCount, attempt, model: useLlm ? modelStatus.model : null });
  await notifyFinished(requestId).catch((e) => slog.warn("run.notify_failed", { crossRef: requestId, error: e instanceof Error ? e.message : String(e) }));
}

function betterCross(a: string, b: string) {
  const order: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "US Downsell Match": 3 };
  return (order[a] ?? 9) < (order[b] ?? 9);
}

export type { Bin };

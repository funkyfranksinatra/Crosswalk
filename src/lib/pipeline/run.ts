/**
 * The request pipeline: resolve → bin → match → rank. Runs in-process in the
 * Next.js server (this is a local tool), persists every step to SQLite so the
 * UI can poll progress and nothing is lost if the tab closes.
 */
import { prisma } from "@/lib/db";
import { specFor } from "@/lib/excel/sizes";
import { compactCfn } from "@/lib/cfn";
import { summarizeRecord, type OpenFdaRecord } from "@/lib/gudid/openfda";
import { binProduct } from "@/lib/llm/tasks";
import { groupSiblings, gradeGroup, applyGroupGrades, type GradeLineInput } from "@/lib/match/grading";
import { resolveCfn, buildContext, type ResolutionContext } from "./resolve";
import { llmConfig, llmPreflight } from "@/lib/llm/client";
import { parseBin, binSimilarity, type Bin, heuristicBin } from "@/lib/match/bin";
import { scoreCandidates, DEFAULT_WEIGHTS, type Weights, type CandidateInput, type ScoredCandidate } from "@/lib/match/score";
import { getSettings } from "@/lib/settings";

const running = new Set<string>();

export function isRunning(id: string) {
  return running.has(id);
}

export function startRun(requestId: string) {
  if (running.has(requestId)) return;
  running.add(requestId);
  runRequest(requestId)
    .catch(async (e) => {
      await prisma.request.update({ where: { id: requestId }, data: { status: "failed", error: e instanceof Error ? e.message : String(e) } });
    })
    .finally(() => running.delete(requestId));
}

async function log(requestId: string, message: string) {
  const r = await prisma.request.findUnique({ where: { id: requestId }, select: { logJson: true } });
  const entries: { t: string; m: string }[] = r ? JSON.parse(r.logJson) : [];
  entries.push({ t: new Date().toISOString(), m: message });
  await prisma.request.update({ where: { id: requestId }, data: { logJson: JSON.stringify(entries.slice(-200)) } });
}

async function setStage(requestId: string, stage: string, progress: number) {
  await prisma.request.update({ where: { id: requestId }, data: { stage, progress: Math.min(100, Math.round(progress)) } });
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

export async function runRequest(requestId: string) {
  const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, include: { lines: { orderBy: { lineNo: "asc" } }, company: true } });
  const settings = await getSettings();
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...(request.optionsJson ? JSON.parse(request.optionsJson).weights ?? {} : settings.weights) };
  let useLlm = request.useLlm && llmConfig().available;

  await prisma.request.update({ where: { id: requestId }, data: { status: "running", startedAt: new Date(), error: null, progress: 0 } });

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

  // Reset previous results (re-runs are expected while tuning)
  await prisma.matchCandidate.deleteMany({ where: { line: { requestId } } });

  const siblingCfns = request.lines.map((l) => l.cfnNorm);
  const preferCompanies = JSON.parse(request.company.labelers || "[]") as string[];

  // ---- Stage 1: resolve (two passes) --------------------------------------
  await setStage(requestId, "Resolving competitor products in GUDID", 2);
  const total = request.lines.length;
  let done = 0;
  const applyResolution = async (line: (typeof request.lines)[number], cp: Awaited<ReturnType<typeof resolveCfn>>) => {
    if (!cp) return;
    await prisma.requestLine.update({
      where: { id: line.id },
      data: { competitorProductId: cp.id, resolutionStatus: cp.resolution === "not-found" ? "not-found" : "resolved", resolutionNote: cp.resolutionNote },
    });
  };
  // Pass 1: unambiguous codes only.
  const pending: typeof request.lines = [];
  await mapLimit(request.lines, 3, async (line) => {
    try {
      const cp = await resolveCfn(line.cfnNorm, { useLlm, strict: true, siblingCfns, accountName: request.accountName });
      if (cp) await applyResolution(line, cp); else pending.push(line);
    } catch (e) {
      pending.push(line);
      await log(requestId, `  ${line.cfnNorm}: ${e instanceof Error ? e.message : String(e)}`);
    }
    done++;
    await setStage(requestId, `Resolving competitor products in GUDID (${done}/${total})`, 2 + (done / total) * 20);
  });
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
  await mapLimit(pending, 3, async (line) => {
    try {
      const cp = await resolveCfn(line.cfnNorm, { useLlm, ctx, siblingCfns, accountName: request.accountName });
      await applyResolution(line, cp);
    } catch (e) {
      await prisma.requestLine.update({ where: { id: line.id }, data: { resolutionStatus: "error", resolutionNote: e instanceof Error ? e.message : String(e) } });
    }
    done++;
    await setStage(requestId, `Resolving ambiguous codes with list context (${done}/${pending.length})`, 22 + (done / Math.max(1, pending.length)) * 18);
  });
  const resolvedCount = await prisma.requestLine.count({ where: { requestId, resolutionStatus: "resolved" } });
  await log(requestId, `Resolved ${resolvedCount}/${total} competitor codes`);

  // Codes that turn out to be *our own* products: make sure they are in the catalog so they self-match.
  const ours = await prisma.requestLine.findMany({ where: { requestId, resolutionStatus: "resolved", competitorProduct: { manufacturer: request.company.name } }, include: { competitorProduct: true } });
  for (const l of ours) {
    const cp = l.competitorProduct!;
    const sku = (cp.cfnMatched ?? cp.cfnNorm).toUpperCase();
    const exists = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: request.companyId, sku } } });
    if (!exists) {
      const raw = cp.gudidJson ? (JSON.parse(cp.gudidJson) as OpenFdaRecord) : null;
      const s = raw ? summarizeRecord(raw) : null;
      const bin = heuristicBin({ sku, brand: cp.brand, description: cp.description, gmdnName: cp.gmdnName, sizes: s?.sizes, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable });
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
  await mapLimit([...uniqueCps.values()], 3, async (cp) => {
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
        useLlm,
      });
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { binJson: JSON.stringify(bin), binSource: source, binnedAt: new Date(), category: cp.category ?? bin.family } });
    }
    binned++;
    await setStage(requestId, `Binning competitor products (${binned}/${uniqueCps.size})`, 42 + (binned / Math.max(1, uniqueCps.size)) * 18);
  });

  // ---- Stage 3: match & rank ---------------------------------------------
  await setStage(requestId, "Matching against our catalog", 60);
  const ownProducts = await prisma.ownProduct.findMany({ where: { companyId: request.companyId, isActive: true }, include: { prices: request.pricebookId ? { where: { pricebookId: request.pricebookId } } : false } });
  // Own bins: keep model bins and current-version heuristic bins; rebuild stale ones (with GUDID sizes) and persist.
  const ownWithBins = await Promise.all(ownProducts.map(async (p) => {
    const existing = parseBin(p.binJson);
    if (existing) return { p, bin: existing };
    const raw = p.gudidJson ? (JSON.parse(p.gudidJson) as OpenFdaRecord) : null;
    const g = raw ? summarizeRecord(raw) : null;
    const bin = heuristicBin({ sku: p.sku, brand: p.brand, description: g ? `${p.description} ; ${g.description ?? ""}` : p.description, category: p.category, gmdnName: p.gmdnName, sizes: g?.sizes, singleUse: g?.singleUse, sterile: g?.sterile, implantable: g?.implantable });
    await prisma.ownProduct.update({ where: { id: p.id }, data: { binJson: JSON.stringify(bin), binSource: "heuristic", binnedAt: new Date() } });
    return { p, bin };
  }));
  const knownCrosses = await prisma.knownCross.findMany({ where: { isActive: true } });
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
  await mapLimit(freshLines, 2, async (line) => {
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
          if (!crossBySku.has(own.p.id) || betterCross(k.matchType, crossBySku.get(own.p.id)!.matchType)) crossBySku.set(own.p.id, k);
        }
      }
      if (compBin) {
        const pool = ownWithBins.filter((o) => compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family);
        const ranked = pool
          .map((o) => ({ o, s: binSimilarity(compBin, o.bin, cp?.description ?? "", o.p.description).score }))
          .sort((a, b) => b.s - a.s)
          .slice(0, settings.maxCandidates);
        for (const r of ranked) if (r.s >= 0.3) candidateIds.add(r.o.p.id);
      }

      const selfSku = cp?.manufacturer === request.company.name ? (cp.cfnMatched ?? cp.cfnNorm).toUpperCase() : null;
      if (selfSku) { const self = ownWithBins.find((o) => o.p.sku.toUpperCase() === selfSku); if (self) candidateIds.add(self.p.id); }
      const candidates = ownWithBins.filter((o) => candidateIds.has(o.p.id));
      if (candidates.length === 0) {
        await prisma.requestLine.update({ where: { id: line.id }, data: { matchStatus: "no-match" } });
        return;
      }

      // Make sure our candidates have model-quality bins when a model is available (lazy, cached).
      if (useLlm) {
        await mapLimit(candidates, 3, async (c) => {
          if (c.p.binSource === "llm") return;
          const raw = c.p.gudidJson ? (JSON.parse(c.p.gudidJson) as OpenFdaRecord) : null;
          const s = raw ? summarizeRecord(raw) : null;
          const { bin, source } = await binProduct({ subject: c.p.sku, sku: c.p.sku, name: c.p.brand, brand: c.p.brand, description: c.p.description, manufacturer: c.p.labeler ?? request.company.name, gmdnName: c.p.gmdnName, gmdnDefinition: raw?.gmdn_terms?.[0]?.definition ?? null, category: c.p.category, sizes: s?.sizes ?? null, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable, useLlm });
          c.bin = bin;
          c.p.binSource = source;
          await prisma.ownProduct.update({ where: { id: c.p.id }, data: { binJson: JSON.stringify(bin), binSource: source, binnedAt: new Date() } });
        });
      }

      const competitorForScore = { bin: compBin ?? heuristicBin({ description: crosses[0]?.competitorDescription }), description: cp?.description ?? crosses[0]?.competitorDescription ?? "", estPrice: line.estCompetitorPrice };
      const inputs: CandidateInput[] = candidates.map((c) => {
        const k = crossBySku.get(c.p.id);
        const pb = Array.isArray(c.p.prices) ? c.p.prices[0] : undefined;
        return {
          ownProductId: c.p.id,
          sku: c.p.sku,
          description: c.p.description,
          bin: c.bin,
          unitPrice: pb?.price ?? c.p.listPrice ?? null,
          cogs: c.p.cogs ?? null,
          identity: selfSku != null && c.p.sku.toUpperCase() === selfSku,
          knownCross: k ? { matchType: k.matchType, preferredOwnSku: k.preferredOwnSku, additionalProducts: k.additionalProducts, notes: k.notes, source: k.source } : null,
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
      await setStage(requestId, `Matching against our catalog (${matched}/${freshLines.length})`, 60 + (matched / Math.max(1, freshLines.length)) * (useLlm ? 18 : 38));
    }
  });

  // ---- Phase B: model grading, siblings together, verdicts cached ---------
  const graded = new Map<string, ScoredCandidate[]>();
  if (useLlm) {
    const inputs = work.map((w) => w.gradeInput).filter((g): g is GradeLineInput => g !== null);
    const groups = groupSiblings(inputs);
    await log(requestId, `Grading ${inputs.length} lines in ${groups.length} sibling group(s)`);
    let doneGroups = 0;
    let cachedGroups = 0;
    await mapLimit(groups, 2, async (group) => {
      const { grade, cached } = await gradeGroup(group, request.company.name, (m) => log(requestId, m), { ignoreCache: Boolean(options.freshGrades) });
      if (cached) cachedGroups++;
      for (const [lineId, scored] of applyGroupGrades(group, grade, cached)) graded.set(lineId, scored);
      doneGroups++;
      await setStage(requestId, `Grading with the model (${doneGroups}/${groups.length} groups)`, 78 + (doneGroups / Math.max(1, groups.length)) * 20);
    });
    if (cachedGroups) await log(requestId, `${cachedGroups} of ${groups.length} verdicts replayed from cache (inputs unchanged since last run)`);
  }

  // ---- Phase C: persist -----------------------------------------------------
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
      unitPrice: s.unitPrice,
      extended: s.unitPrice != null ? s.unitPrice * line.quantity : null,
      isSelected: i === 0 && s.matchType !== "No Match",
    }));
    await prisma.matchCandidate.createMany({ data: rows });
    const first = await prisma.matchCandidate.findFirst({ where: { lineId: line.id, rank: 1 } });
    await prisma.requestLine.update({
      where: { id: line.id },
      data: { matchStatus: first && first.matchType !== "No Match" ? "matched" : "no-match", selectedCandidateId: first && first.matchType !== "No Match" ? first.id : null },
    });
  }

  const matchedCount = await prisma.requestLine.count({ where: { requestId, matchStatus: "matched" } });
  await log(requestId, `Matched ${matchedCount}/${total} lines`);
  await prisma.request.update({ where: { id: requestId }, data: { status: "complete", stage: "Complete", progress: 100, completedAt: new Date() } });
}

function betterCross(a: string, b: string) {
  const order: Record<string, number> = { "Exact Match": 0, "Close Match": 1, "Alternative Match": 2, "US Downsell Match": 3 };
  return (order[a] ?? 9) < (order[b] ?? 9);
}

export type { Bin };

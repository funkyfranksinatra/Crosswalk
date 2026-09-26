/**
 * Model evaluation harness — the gate on prompt and model changes.
 *
 * `evaluateModel` samples approved curated crosses (seeded, so runs are comparable),
 * builds each line's shortlist the way the pipeline does, guarantees the curated answer is
 * on the shortlist (this measures *grading*, not retrieval), runs the real sibling-grouped
 * grading, and scores: top-1 agreement (the model's first pick is the curated SKU), tier
 * agreement (Exact / Close / Alternative), and false No-Match. Every run is a ModelEval row.
 *
 * `acceptBaseline` writes data/eval/model-baseline.json (committed). `gate` — run by CI and
 * `npm run eval:gate` — fails when GRADE_PROMPT_VERSION or BIN_VERSION in the code differ from
 * the accepted baseline (a prompt was edited without measuring it), or when the latest
 * measurement for the current version fell more than `tolerance` points below the baseline.
 * The file check needs no database or network, so the gate holds in CI without a key.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { resolveCfn } from "@/lib/pipeline/resolve";
import { parseBin, binSimilarity, heuristicBin, BIN_VERSION, type Bin } from "@/lib/match/bin";
import { scoreCandidates, type ScoredCandidate } from "@/lib/match/score";
import { groupSiblings, gradeGroup, applyGroupGrades, GRADE_PROMPT_VERSION, type GradeLineInput } from "@/lib/match/grading";
import { binProduct } from "@/lib/ai/gateway";
import { loadSiblingIndex } from "@/lib/pipeline/siblings-index";
import { summarizeRecord, type OpenFdaRecord } from "@/lib/gudid/openfda";
import { llmConfig } from "@/lib/ai/gateway";
import { getCompany } from "@/lib/settings";
import { isPlaceholderSku } from "@/lib/cfn";
import { log } from "@/lib/log";

export const BASELINE_PATH = path.resolve(process.cwd(), "data/eval/model-baseline.json");

export type Baseline = { model: string; promptVersion: number; binVersion: number; sampleSeed: number; sampleSize: number; graded: number; top1Agree: number; tierAgree: number; noMatchFalse: number; acceptedAt: string; evalId: string | null; notes?: string | null };

export function readBaseline(file = BASELINE_PATH): Baseline | null {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as Baseline; } catch { return null; }
}

/** Codes the test suites create (scripts/test-enterprise.ts, tests/): never part of a measurement. */
export const isTestFixture = (code: string) => /^E2E[-_]/i.test(code) || /^(TEST|FIXTURE)[-_]/i.test(code);

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const tier = (t: string | null | undefined) => (t ?? "").replace(/\s*Match$/i, "").trim().toLowerCase().replace("us downsell", "alternative");

export type EvalDetail = { code: string; competitor: string; expected: string[]; pick: string | null; pickType: string | null; curatedType: string; top1: boolean; tierAgree: boolean; noMatch: boolean; cached: boolean };
export type EvalResult = { id: string; model: string; promptVersion: number; binVersion: number; sampleSeed: number; sampleSize: number; graded: number; top1Agree: number; tierAgree: number; noMatchFalse: number; durationMs: number; details: EvalDetail[] };

export async function evaluateModel(opts: { n?: number; seed?: number; family?: string | null; ignoreCache?: boolean; onProgress?: (m: string) => void } = {}): Promise<EvalResult> {
  if (!llmConfig().available) throw new Error("OPENAI_API_KEY is not set — the model evaluation needs the model");
  const t0 = Date.now();
  const n = opts.n ?? 40, seed = opts.seed ?? 7;
  const rand = rng(seed);
  const company = await getCompany();
  const all = await prisma.knownCross.findMany({ where: { isActive: true, approvalStatus: "APPROVED", matchType: { in: ["Exact Match", "Close Match", "Alternative Match"] }, NOT: { competitorName: company.name }, ...(opts.family ? { category: opts.family } : {}) }, orderBy: [{ competitorCodeNorm: "asc" }, { ownSku: "asc" }] });
  // Placeholder rows that slipped into a catalog ("NOMATCH", "TOTAL") are never candidates or answers,
  // and fixtures the test suites leave behind (E2E-*) are never sampled: both would grade noise.
  const own = (await prisma.ownProduct.findMany({ where: { isActive: true }, select: { id: true, sku: true, description: true, category: true, brand: true, listPrice: true, cogs: true, binJson: true, source: true } })).filter((p) => !isPlaceholderSku(p.sku) && !isTestFixture(p.sku));
  const ownSkus = new Set(own.map((p) => p.sku.toUpperCase()));
  const byCode = new Map<string, { code: string; expected: Set<string>; name: string; desc: string | null; type: string }>();
  for (const k of all) {
    if (isTestFixture(k.competitorCodeNorm) || isPlaceholderSku(k.competitorCodeNorm)) continue;
    const e = byCode.get(k.competitorCodeNorm) ?? { code: k.competitorCodeNorm, expected: new Set<string>(), name: k.competitorName, desc: k.competitorDescription, type: k.matchType };
    const sku = (k.preferredOwnSku && /^[A-Z0-9-]{4,}$/i.test(k.preferredOwnSku) ? k.preferredOwnSku : k.ownSku).toUpperCase();
    if (ownSkus.has(sku)) e.expected.add(sku);
    byCode.set(k.competitorCodeNorm, e);
  }
  // Fisher–Yates with the seeded RNG over a stably ordered list: the same seed grades the same codes.
  const eligible = [...byCode.values()].filter((e) => e.expected.size > 0).sort((a, b) => a.code.localeCompare(b.code));
  for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j], eligible[i]]; }
  const pool = eligible.slice(0, n);
  const ownBins = own.map((p) => ({ p, bin: parseBin(p.binJson) ?? heuristicBin({ sku: p.sku, brand: p.brand, description: p.description, category: p.category }) }));

  const inputs: (GradeLineInput & { expected: Set<string>; curatedType: string; competitor: string })[] = [];
  const siblingIndex = new Map<string, Awaited<ReturnType<typeof loadSiblingIndex>>>();
  for (const [i, item] of pool.entries()) {
    opts.onProgress?.(`preparing ${i + 1}/${pool.length} ${item.code}`);
    const cp = await resolveCfn(item.code, { useLlm: false, strict: false });
    if (!cp || cp.resolution === "not-found") continue;
    let bin: Bin | null = parseBin(cp.binJson);
    if (!bin) {
      const raw = cp.gudidJson ? (JSON.parse(cp.gudidJson) as OpenFdaRecord) : null;
      const s = raw ? summarizeRecord(raw) : null;
      if (cp.manufacturer && !siblingIndex.has(cp.manufacturer)) siblingIndex.set(cp.manufacturer, await loadSiblingIndex([cp.manufacturer]));
      const b = await binProduct({ subject: item.code, code: cp.cfnMatched ?? cp.cfnNorm, brand: cp.brand, description: [cp.description, item.desc].filter(Boolean).join(" ; "), manufacturer: cp.manufacturer, gmdnName: cp.gmdnName, sizes: s?.sizes, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable, siblings: cp.manufacturer ? siblingIndex.get(cp.manufacturer)!.get(cp.manufacturer, cp.brand) : null, useLlm: true });
      bin = b.bin;
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { binJson: JSON.stringify(bin), binSource: b.source, binnedAt: new Date() } });
    }
    const compDesc = [cp.description, item.desc].filter(Boolean).join(" ; ");
    const poolFam = ownBins.filter((o) => bin!.family === "Other" || o.bin.family === "Other" || o.bin.family === bin!.family);
    const ranked = poolFam.map((o) => ({ o, s: binSimilarity(bin!, o.bin, compDesc, o.p.description).score })).sort((a, b) => b.s - a.s).slice(0, 5);
    const ids = new Set(ranked.map((r) => r.o.p.id));
    for (const sku of item.expected) { const o = ownBins.find((x) => x.p.sku.toUpperCase() === sku); if (o) ids.add(o.p.id); }
    const cands = ownBins.filter((o) => ids.has(o.p.id));
    const scored = scoreCandidates({ bin, description: compDesc, estPrice: null }, cands.map((c) => ({ ownProductId: c.p.id, sku: c.p.sku, description: c.p.description, bin: c.bin, unitPrice: null, cogs: null, provenance: c.p.source })));
    inputs.push({ lineId: `eval:${item.code}`, cfn: item.code, manufacturer: cp.manufacturer, brand: cp.brand, description: cp.description, bin, candidates: scored, expected: item.expected, curatedType: item.type, competitor: item.name });
  }

  const details: EvalDetail[] = [];
  const groups = groupSiblings(inputs);
  for (const [gi, group] of groups.entries()) {
    opts.onProgress?.(`grading group ${gi + 1}/${groups.length} (${group.length} lines)`);
    const { grade, cached } = await gradeGroup(group, company.name, undefined, { ignoreCache: opts.ignoreCache });
    const graded = applyGroupGrades(group, grade, cached);
    for (const l of group) {
      const scored: ScoredCandidate[] = graded.get(l.lineId) ?? l.candidates;
      const pick = scored.find((s) => s.matchType !== "No Match") ?? null;
      const noMatch = !pick;
      details.push({ code: l.cfn, competitor: l.competitor, expected: [...l.expected], pick: pick?.sku ?? null, pickType: pick?.matchType ?? null, curatedType: l.curatedType, top1: Boolean(pick && l.expected.has(pick.sku.toUpperCase())), tierAgree: Boolean(pick && tier(pick.matchType) === tier(l.curatedType)), noMatch, cached });
    }
  }
  const graded = details.length;
  const top1Agree = details.filter((d) => d.top1).length, tierAgree = details.filter((d) => d.tierAgree).length, noMatchFalse = details.filter((d) => d.noMatch).length;
  const row = await prisma.modelEval.create({ data: { model: llmConfig().model, promptVersion: GRADE_PROMPT_VERSION, binVersion: BIN_VERSION, sampleSeed: seed, sampleSize: pool.length, graded, top1Agree, tierAgree, noMatchFalse, durationMs: Date.now() - t0, detailJson: JSON.stringify(details) } });
  log.info("model_eval.done", { id: row.id, model: row.model, promptVersion: row.promptVersion, graded, top1Agree, tierAgree, noMatchFalse });
  return { id: row.id, model: row.model, promptVersion: row.promptVersion, binVersion: row.binVersion, sampleSeed: seed, sampleSize: pool.length, graded, top1Agree, tierAgree, noMatchFalse, durationMs: Date.now() - t0, details };
}

export async function acceptBaseline(evalId: string, notes?: string | null, file = BASELINE_PATH) {
  const e = await prisma.modelEval.findUniqueOrThrow({ where: { id: evalId } });
  await prisma.modelEval.update({ where: { id: evalId }, data: { accepted: true, notes: notes ?? null } });
  const b: Baseline = { model: e.model, promptVersion: e.promptVersion, binVersion: e.binVersion, sampleSeed: e.sampleSeed, sampleSize: e.sampleSize, graded: e.graded, top1Agree: e.top1Agree, tierAgree: e.tierAgree, noMatchFalse: e.noMatchFalse, acceptedAt: new Date().toISOString(), evalId: e.id, notes: notes ?? null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(b, null, 2) + "\n");
  return b;
}

export type GateResult = { ok: boolean; reasons: string[]; warnings: string[]; baseline: Baseline | null; current: { promptVersion: number; binVersion: number; model: string } };

/**
 * The gate. Pure on the file + code constants; consults the database for the latest
 * measurement only when `checkDb` and a connection is available.
 */
export async function gate(opts: { baseline?: Baseline | null; promptVersion?: number; binVersion?: number; model?: string; tolerancePts?: number; checkDb?: boolean } = {}): Promise<GateResult> {
  const baseline = opts.baseline === undefined ? readBaseline() : opts.baseline;
  const current = { promptVersion: opts.promptVersion ?? GRADE_PROMPT_VERSION, binVersion: opts.binVersion ?? BIN_VERSION, model: opts.model ?? llmConfig().model };
  const reasons: string[] = [], warnings: string[] = [];
  // No baseline yet is a warning, not a failure: the gate cannot hold a line nobody has drawn.
  if (!baseline) warnings.push(`no accepted baseline at ${path.relative(process.cwd(), BASELINE_PATH)} — run \`npm run eval:model -- --accept\` with the model configured, then commit the file`);
  else {
    if (baseline.promptVersion !== current.promptVersion) reasons.push(`GRADE_PROMPT_VERSION is ${current.promptVersion} but the accepted baseline measured version ${baseline.promptVersion} — measure the new prompt and accept it`);
    if (baseline.binVersion !== current.binVersion) reasons.push(`BIN_VERSION is ${current.binVersion} but the accepted baseline measured version ${baseline.binVersion} — re-measure grading on the new bins and accept it`);
    // The model name is only a fact where a model is configured. In CI (no key) llmConfig().model is
    // the code default, not what anyone runs, so a mismatch there says nothing about the baseline.
    if (baseline.model !== current.model) {
      const configured = opts.model !== undefined || Boolean(process.env.LLM_MODEL?.trim()) || llmConfig().available;
      (configured ? reasons : warnings).push(`LLM_MODEL is ${current.model} but the accepted baseline measured ${baseline.model}${configured ? " — measure the new model and accept it" : " (no model configured here; the versions still match)"}`);
    }
    if (opts.checkDb) {
      const tol = opts.tolerancePts ?? 3;
      const latest = await prisma.modelEval.findFirst({ where: { model: current.model, promptVersion: current.promptVersion, binVersion: current.binVersion, sampleSeed: baseline.sampleSeed }, orderBy: { createdAt: "desc" } }).catch(() => null);
      if (latest && latest.graded > 0 && baseline.graded > 0) {
        const pct = (a: number, b: number) => (a / b) * 100;
        const drop = pct(baseline.top1Agree, baseline.graded) - pct(latest.top1Agree, latest.graded);
        if (drop > tol) reasons.push(`latest measurement (${latest.id}) top-1 agreement ${pct(latest.top1Agree, latest.graded).toFixed(0)}% is ${drop.toFixed(0)} points below the accepted baseline ${pct(baseline.top1Agree, baseline.graded).toFixed(0)}%`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons, warnings, baseline, current };
}

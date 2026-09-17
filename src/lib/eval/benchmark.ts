/**
 * Multi-list accuracy benchmark.
 *
 * One 30-line account list is an anecdote. This runs the whole pipeline over a directory
 * of historical account lists, each with a reference answer (the legacy PACR export, a
 * marketing-validated sheet, or the reps' own confirmed decisions), and reports accuracy
 * per family and per match tier — the number to publish internally before any external
 * claim.
 *
 * Case layout (data/benchmark/<case>/, gitignored — customer lists):
 *   intake.xlsx|csv     competitor code + quantity, any layout the intake parser accepts
 *   reference.xlsx|csv  Competitor Code | Expected SKU (several: A|B) | Match Type | Family | Notes
 *   meta.json           { "account": "...", "source": "PACR export REQ-7604", "note": "..." }
 *
 * `fromRequests` builds cases from completed requests whose lines a rep reviewed
 * (MatchDecision), so the benchmark grows with the learning loop and needs no files.
 *
 * Every run is a BenchmarkRun row: totals, per-family, per-case and the misses, tagged with
 * the model / prompt version / bin version / git ref so runs are comparable over time.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { prisma } from "@/lib/db";
import { parseIntake, parseIntakeCsv, type IntakeResult } from "@/lib/excel/intake";
import { parseCsv } from "@/lib/sheets/csv";
import { normalizeCfn, compactCfn } from "@/lib/cfn";
import { runRequest } from "@/lib/pipeline/run";
import { llmConfig } from "@/lib/llm/client";
import { GRADE_PROMPT_VERSION } from "@/lib/match/grading";
import { BIN_VERSION } from "@/lib/match/bin";
import { getCompany } from "@/lib/settings";
import { log } from "@/lib/log";

export type ReferenceLine = { code: string; norm: string; expected: string[]; matchType: string | null; family: string | null; notes: string | null };
export type BenchmarkCase = { name: string; intake: IntakeResult; reference: ReferenceLine[]; meta: { account?: string; source?: string; note?: string } };

const TIER = (t: string | null) => (t ? t.replace(/\s*match$/i, "").trim().toLowerCase() : null);
const tierGroup = (t: string | null) => { const x = TIER(t); return x === "exact" ? "exact" : x === "close" ? "close" : x === "alternative" || x === "us downsell" ? "alternative" : x === "no" || x === "not found" || x === "none" ? "none" : null; };

export function parseReferenceGrid(grid: (string | number | null | undefined)[][]): ReferenceLine[] {
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cCode = col(/^(competitor\s*)?(code|cfn|catalog|product\s*code|item)/), cSku = col(/^(expected|own|our|mdt|medtronic)?\s*(sku|product|cross|answer)/), cType = col(/^(match\s*type|tier|verdict)/), cFam = col(/^(family|category)/), cNotes = col(/^(notes?|comment)/);
  if (cCode < 0 || cSku < 0) throw new Error("reference needs a competitor code column and an expected SKU column");
  const out: ReferenceLine[] = [];
  for (const row of grid.slice(1)) {
    const code = String(row[cCode] ?? "").trim();
    if (!code) continue;
    const expected = String(row[cSku] ?? "").split(/[|,;/]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    out.push({ code, norm: normalizeCfn(code), expected, matchType: cType >= 0 ? String(row[cType] ?? "").trim() || null : null, family: cFam >= 0 ? String(row[cFam] ?? "").trim() || null : null, notes: cNotes >= 0 ? String(row[cNotes] ?? "").trim() || null : null });
  }
  return out;
}

async function readGrid(file: string): Promise<(string | number | null)[][]> {
  if (/\.csv$/i.test(file)) return parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(file) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const grid: (string | number | null)[][] = [];
  ws.eachRow((row) => { const cells: (string | number | null)[] = []; for (let i = 1; i <= row.cellCount; i++) { const v = row.getCell(i).value; cells.push(v === null || v === undefined ? null : typeof v === "object" && "result" in (v as object) ? ((v as { result?: string | number }).result ?? null) : typeof v === "object" && "text" in (v as object) ? String((v as { text: string }).text) : (v as string | number)); } grid.push(cells); });
  return grid;
}

/** Load every case directory under `dir` that has an intake and a reference. */
export async function loadCases(dir: string, only?: string[]): Promise<BenchmarkCase[]> {
  if (!fs.existsSync(dir)) return [];
  const cases: BenchmarkCase[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (only?.length && !only.includes(name)) continue;
    const d = path.join(dir, name);
    if (!fs.statSync(d).isDirectory()) continue;
    const files = fs.readdirSync(d);
    const intakeFile = files.find((f) => /^intake\.(xlsx|csv)$/i.test(f)), refFile = files.find((f) => /^reference\.(xlsx|csv)$/i.test(f));
    if (!intakeFile || !refFile) continue;
    const intakePath = path.join(d, intakeFile);
    const intake = /\.csv$/i.test(intakeFile) ? parseIntakeCsv(fs.readFileSync(intakePath, "utf8"), intakeFile) : await parseIntake(fs.readFileSync(intakePath), intakeFile);
    const reference = parseReferenceGrid(await readGrid(path.join(d, refFile)));
    const metaFile = path.join(d, "meta.json");
    const meta = fs.existsSync(metaFile) ? (JSON.parse(fs.readFileSync(metaFile, "utf8")) as BenchmarkCase["meta"]) : {};
    cases.push({ name, intake, reference, meta });
  }
  return cases;
}

/** Cases from completed requests with reviewed lines: the rep's confirmed SKU is the answer. */
export async function casesFromRequests(minReviewed = 5): Promise<BenchmarkCase[]> {
  const requests = await prisma.request.findMany({ where: { status: "complete", NOT: { reference: { startsWith: "BENCH-" } } }, include: { lines: { where: { reviewed: true }, include: { candidates: { where: { isSelected: true }, include: { ownProduct: { select: { sku: true, category: true } } } } } } } });
  const out: BenchmarkCase[] = [];
  for (const r of requests) {
    const reviewed = r.lines.filter((l) => l.candidates[0]);
    if (reviewed.length < minReviewed) continue;
    out.push({
      name: `request:${r.reference}`,
      intake: { lines: reviewed.map((l, i) => ({ rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estPrice: l.estCompetitorPrice === null ? null : Number(l.estCompetitorPrice), sourceRows: [i + 2] })), sheet: r.reference, skipped: [], duplicatesMerged: 0, source: { kind: "csv", name: r.reference }, detectedColumns: { code: 0, qty: null, price: null, headerRow: null } },
      reference: reviewed.map((l) => ({ code: l.rawCode, norm: l.cfnNorm, expected: [l.candidates[0].ownProduct.sku.toUpperCase()], matchType: l.candidates[0].matchType, family: l.candidates[0].ownProduct.category, notes: l.overrideNote })),
      meta: { account: r.accountName ?? r.accountNumber ?? undefined, source: "reviewed request lines" },
    });
  }
  return out;
}

export type LineResult = { case: string; code: string; expected: string[]; got: string[]; gotType: string | null; refType: string | null; family: string | null; resolved: boolean; top1: boolean; top3: boolean; tierAgree: boolean | null };
export type FamilyStats = { lines: number; resolved: number; top1: number; top3: number; tierAgree: number; tierCompared: number };
export type BenchmarkResult = { runId: string; cases: number; lines: number; resolved: number; top1: number; top3: number; tierAgree: number; tierCompared: number; byFamily: Record<string, FamilyStats>; byCase: Record<string, FamilyStats & { account?: string; source?: string }>; misses: LineResult[]; durationMs: number; model: string | null };

function gitRef(): string | null {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}

const blank = (): FamilyStats => ({ lines: 0, resolved: 0, top1: 0, top3: 0, tierAgree: 0, tierCompared: 0 });
const add = (s: FamilyStats, r: LineResult) => { s.lines++; if (r.resolved) s.resolved++; if (r.top1) s.top1++; if (r.top3) s.top3++; if (r.tierAgree !== null) { s.tierCompared++; if (r.tierAgree) s.tierAgree++; } };

/**
 * Run every case through the real pipeline (a BENCH-* request each, deleted afterwards
 * unless `keep`) and score it against its reference.
 */
export async function runBenchmark(cases: BenchmarkCase[], opts: { useLlm?: boolean; keep?: boolean; label?: string | null; onProgress?: (m: string) => void } = {}): Promise<BenchmarkResult> {
  if (!cases.length) throw new Error("no benchmark cases");
  const t0 = Date.now();
  const useLlm = Boolean(opts.useLlm) && llmConfig().available;
  const company = await getCompany();
  const results: LineResult[] = [];
  const byCase: BenchmarkResult["byCase"] = {};
  for (const c of cases) {
    opts.onProgress?.(`${c.name}: ${c.intake.lines.length} lines`);
    const request = await prisma.request.create({ data: { companyId: company.id, reference: `BENCH-${c.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}`, accountName: c.meta.account ?? c.name, useLlm, status: "queued", sourceFileName: "benchmark", lines: { create: c.intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estCompetitorPrice: l.estPrice })) } } });
    try {
      await runRequest(request.id);
      const lines = await prisma.requestLine.findMany({ where: { requestId: request.id }, include: { candidates: { orderBy: { rank: "asc" }, take: 3, include: { ownProduct: { select: { sku: true, category: true } } } } } });
      const refByNorm = new Map<string, ReferenceLine>();
      for (const r of c.reference) { refByNorm.set(r.norm, r); refByNorm.set(compactCfn(r.norm), r); }
      const stats = blank();
      for (const l of lines) {
        const ref = refByNorm.get(l.cfnNorm) ?? refByNorm.get(compactCfn(l.cfnNorm));
        if (!ref) continue;
        const got = l.candidates.filter((k) => k.matchType !== "No Match").map((k) => k.ownProduct.sku.toUpperCase());
        const gotType = l.candidates[0]?.matchType ?? null;
        const refNone = ref.expected.length === 0 || tierGroup(ref.matchType) === "none";
        const top1 = refNone ? got.length === 0 : Boolean(got[0] && ref.expected.includes(got[0]));
        const top3 = refNone ? got.length === 0 : got.some((s) => ref.expected.includes(s));
        const rg = tierGroup(ref.matchType), gg = tierGroup(gotType ?? (got.length ? null : "none"));
        const tierAgree = rg && gg ? rg === gg : null;
        const family = ref.family ?? l.candidates[0]?.ownProduct.category ?? "Unknown";
        const res: LineResult = { case: c.name, code: l.rawCode, expected: ref.expected, got, gotType, refType: ref.matchType, family, resolved: l.resolutionStatus === "resolved", top1, top3, tierAgree };
        results.push(res);
        add(stats, res);
      }
      byCase[c.name] = { ...stats, account: c.meta.account, source: c.meta.source };
      opts.onProgress?.(`${c.name}: top-1 ${stats.top1}/${stats.lines}, top-3 ${stats.top3}/${stats.lines}`);
    } finally {
      if (!opts.keep) await prisma.request.delete({ where: { id: request.id } }).catch((e) => log.warn("benchmark.cleanup_failed", { requestId: request.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const byFamily: Record<string, FamilyStats> = {};
  const total = blank();
  for (const r of results) { add(total, r); byFamily[r.family ?? "Unknown"] ??= blank(); add(byFamily[r.family ?? "Unknown"], r); }
  const misses = results.filter((r) => !r.top3);
  const durationMs = Date.now() - t0;
  const run = await prisma.benchmarkRun.create({ data: { label: opts.label ?? null, model: useLlm ? llmConfig().model : null, promptVersion: GRADE_PROMPT_VERSION, binVersion: BIN_VERSION, gitRef: gitRef(), cases: cases.length, lines: total.lines, resolved: total.resolved, top1: total.top1, top3: total.top3, tierAgree: total.tierAgree, byFamilyJson: JSON.stringify(byFamily), byCaseJson: JSON.stringify(byCase), missesJson: JSON.stringify(misses.slice(0, 500)), durationMs } });
  log.info("benchmark.done", { runId: run.id, cases: cases.length, lines: total.lines, top1: total.top1, top3: total.top3, durationMs, model: useLlm ? llmConfig().model : null });
  return { runId: run.id, cases: cases.length, ...total, byFamily, byCase, misses, durationMs, model: useLlm ? llmConfig().model : null };
}

/** Markdown summary for docs/benchmarks. */
export function formatBenchmark(r: BenchmarkResult): string {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const lines = [
    `# Benchmark ${r.runId}`,
    "",
    `${r.cases} case${r.cases === 1 ? "" : "s"}, ${r.lines} lines, ${r.model ?? "heuristic (no model)"}, ${(r.durationMs / 1000).toFixed(0)} s`,
    "",
    "| | Lines | Resolved | Top-1 | Top-3 | Tier agreement |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    `| **All** | ${r.lines} | ${pct(r.resolved, r.lines)} | ${pct(r.top1, r.lines)} | ${pct(r.top3, r.lines)} | ${pct(r.tierAgree, r.tierCompared)} |`,
    ...Object.entries(r.byFamily).sort((a, b) => b[1].lines - a[1].lines).map(([f, s]) => `| ${f} | ${s.lines} | ${pct(s.resolved, s.lines)} | ${pct(s.top1, s.lines)} | ${pct(s.top3, s.lines)} | ${pct(s.tierAgree, s.tierCompared)} |`),
    "",
    "## By case",
    "",
    "| Case | Source | Lines | Top-1 | Top-3 |",
    "| --- | --- | ---: | ---: | ---: |",
    ...Object.entries(r.byCase).map(([c, s]) => `| ${c} | ${s.source ?? ""} | ${s.lines} | ${pct(s.top1, s.lines)} | ${pct(s.top3, s.lines)} |`),
  ];
  if (r.misses.length) {
    lines.push("", `## Misses (${r.misses.length})`, "", "| Case | Code | Expected | Got | Ref tier | Our tier |", "| --- | --- | --- | --- | --- | --- |");
    for (const m of r.misses.slice(0, 200)) lines.push(`| ${m.case} | ${m.code} | ${m.expected.join(" / ") || "(none)"} | ${m.got.join(", ") || "—"} | ${m.refType ?? ""} | ${m.gotType ?? ""} |`);
  }
  return lines.join("\n") + "\n";
}

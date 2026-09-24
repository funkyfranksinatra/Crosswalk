/**
 * PACR-vs-Crosswalk evaluation on a PACR export (REQ-7628 / account 0001583870 by default).
 *
 *   npx tsx scripts/eval-pacr.ts run <PACR export.xlsx> --label baseline [--llm] [--fresh] [--rebin]
 *   npx tsx scripts/eval-pacr.ts report docs/eval/<label>.json [--before docs/eval/baseline.json]
 *   npx tsx scripts/eval-pacr.ts fixture docs/eval/<label>.json [--codes A,B,…]   (offline fixture for the regression suite)
 *
 * `run` seeds the benchmark pricing fixture (account, contracts, price entries from the export),
 * creates a request under that account with the HOSPITAL LIST PRICE book, runs the pipeline and
 * writes one raw record per line: intake accounting, resolution, competitor bin, every candidate
 * with its grade / source / score / price, the PACR pick, and what the contract waterfall resolves
 * for the top pick. `report` computes every metric from those records, so a baseline captured
 * before a matcher change and a run captured after it are measured by the same code:
 *
 *   INPUT          rows, lines, skipped (with reasons), merged, unaccounted (must be 0)
 *   IDENTIFICATION resolved / by source / not found
 *   MATCHING       proposals by grade and source, identity lines, no-match
 *   QUALITY        agreement with PACR (same, next-best, different, only-one-side), curated top-1/top-3,
 *                  diameter mismatches, component (device-type) mismatches, grade calibration
 *   PRICING        lines priced by the run, by book; lines priceable under the account's contracts
 *   PACR wins      the named codes PACR handled better in the REQ-7628 comparison
 *
 * Nothing here changes the matcher; `--fresh` forces the competitor codes to be re-resolved.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { parseIntakeAny } from "../src/lib/excel/intake";
import { runRequest } from "../src/lib/pipeline/run";
import { getCompany } from "../src/lib/settings";
import { nextReference } from "../src/lib/requests";
import { loadPricingContext } from "../src/lib/contracts/context";
import { parseBin } from "../src/lib/match/bin";
import { componentsCompatible } from "../src/lib/match/component";
import { buildAccessProfile, type AccessProfile } from "../src/lib/match/access";
import { readPacrExport, seedSanfordBenchmark, SANFORD, type PacrRow } from "./seed-sanford-benchmark";
import { compactCfn } from "../src/lib/cfn";
import { D } from "../src/lib/money";

type Cand = { rank: number; sku: string; description: string; grade: string; source: string; score: number; scoreBin: number | null; confidence: number | null; priceSource: string | null; rationale: string | null; unitPrice: number | null; productType: string | null; family: string | null; dims: { name: string; value: number; unit: string }[]; features: string[]; selected: boolean };
type Rec = {
  lineNo: number; code: string; cfnNorm: string; quantity: number; intakeDescription: string; competitorName: string;
  pacr: { sku: string | null; grade: string; pricebook: string | null; price: number | null };
  resolution: { status: string; kind: string | null; note: string | null; confidence: number | null; manufacturer: string | null; brand: string | null; description: string | null; gmdn: string | null; sizes: { type?: string; value?: string; unit?: string }[] };
  identity: boolean; matchStatus: string;
  compBin: { productType: string; family: string; dims: { name: string; value: number; unit: string }[]; features: string[] } | null;
  candidates: Cand[];
  waterfall: { price: number | null; source: string | null; contract: string | null; reason: string } | null;
};
type EvalFile = {
  label: string; commit: string; at: string; file: string; requestId: string; reference: string; useLlm: boolean; ms: number;
  intake: { sheetRows: number; pacrLines: number; parsed: number; skipped: { row: number; code: string; reason: string }[]; merged: number; unaccounted: number; codesNotInPacr: string[]; pacrNotParsed: string[] };
  records: Rec[];
};

const num = (v: unknown) => (v == null ? null : Number(v));
const argOf = (name: string, def?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const commit = () => { try { return require("node:child_process").execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; } };

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------
async function run(file: string) {
  const label = argOf("label", "run")!;
  const useLlm = process.argv.includes("--llm");
  const company = await getCompany();
  const seeded = await seedSanfordBenchmark(file);
  const { rows: pacr } = await readPacrExport(file);
  const pacrByCode = new Map(pacr.map((r) => [r.code.toUpperCase(), r]));
  const bytes = fs.readFileSync(file);
  const intake = await parseIntakeAny({ file: new File([bytes], path.basename(file)) });
  const skipped = intake.skipped.map((s) => ({ row: (s as { row?: number }).row ?? 0, code: String((s as { value?: unknown }).value ?? ""), reason: String((s as { reason?: unknown }).reason ?? "") }));
  const parsedCodes = new Set(intake.lines.map((l) => l.cfnNorm));
  const pacrNorm = new Map(pacr.map((r) => [r.code.toUpperCase().replace(/\s+/g, ""), r.code]));
  const codesNotInPacr = intake.lines.map((l) => l.rawCode).filter((c) => !pacrByCode.has(c.toUpperCase()));
  const pacrNotParsed = [...pacrNorm.values()].filter((c) => !intake.lines.some((l) => l.rawCode.toUpperCase() === c.toUpperCase() || l.sourceRows.length > 1));
  if (process.argv.includes("--fresh")) await prisma.competitorProduct.deleteMany({ where: { cfnNorm: { in: intake.lines.map((l) => l.cfnNorm) } } });
  // --rebin: drop cached bins (competitor rows of this list and every own product) so binner changes take effect without a BIN_VERSION bump.
  if (process.argv.includes("--rebin")) {
    await prisma.competitorProduct.updateMany({ where: { cfnNorm: { in: intake.lines.map((l) => l.cfnNorm) } }, data: { binJson: null, binSource: null, binnedAt: null } });
    await prisma.ownProduct.updateMany({ where: { companyId: company.id }, data: { binJson: null, binSource: null, binnedAt: null } });
  }

  const req = await prisma.request.create({
    data: {
      companyId: company.id, reference: await nextReference(), accountNumber: SANFORD.accountNumber, accountName: SANFORD.accountName, accountType: "Sold-To", accountId: seeded.accountId, pricebookId: seeded.pricebookId,
      reportType: `eval:${label}`, sourceFileName: path.basename(file), useLlm, createdBy: "eval-pacr", status: "queued",
      lines: { create: intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estCompetitorPrice: l.estPrice, description: l.description ?? null })) },
    },
  });
  const t0 = Date.now();
  await runRequest(req.id, { attempt: 1, finalAttempt: true });
  const ms = Date.now() - t0;
  const done = await prisma.request.findUniqueOrThrow({ where: { id: req.id }, include: { lines: { orderBy: { lineNo: "asc" }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: { omit: { gudidJson: true }, include: { prices: true } } } } } } } });
  if (done.status !== "complete") throw new Error(`run ${done.reference} ended ${done.status}: ${done.error}`);
  const ctx = await loadPricingContext({ accountId: seeded.accountId });
  const records: Rec[] = done.lines.map((l) => {
    const cp = l.competitorProduct;
    const raw = cp?.gudidJson ? (JSON.parse(cp.gudidJson) as { device_sizes?: { type?: string; value?: string; unit?: string }[] }) : null;
    const bin = cp ? parseBin(cp.binJson, { allowStale: true }) : null;
    const p = pacrByCode.get(l.rawCode.toUpperCase()) ?? pacr.find((r) => r.code.toUpperCase().replace(/\s+/g, "") === l.cfnNorm) ?? null;
    const cands: Cand[] = l.candidates.map((c) => {
      const ob = parseBin(c.ownProduct.binJson, { allowStale: true });
      return { rank: c.rank, sku: c.ownProduct.sku, description: c.ownProduct.description, grade: c.matchType, source: c.source, score: c.score, scoreBin: c.scoreBin, confidence: c.confidence ?? null, priceSource: c.priceSource ?? null, rationale: c.rationale, unitPrice: num(c.unitPrice), productType: ob?.productType ?? null, family: ob?.family ?? null, dims: ob?.dimensions ?? [], features: ob?.features ?? [], selected: c.isSelected };
    });
    const top = l.candidates[0];
    let waterfall: Rec["waterfall"] = null;
    if (top && top.matchType !== "No Match") {
      const r = ctx.resolvePrice({ ...top.ownProduct, prices: top.ownProduct.prices.map((e) => ({ ...e, pricebook: null })) }, D(l.quantity));
      const win = r.steps.find((s) => s.applied);
      waterfall = { price: r.price ? Number(r.price.toString()) : null, source: r.source, contract: win?.contractName ?? (win?.level === "LIST" ? "list" : null), reason: win ? win.reason : r.explanation.slice(0, 300) };
    }
    return {
      lineNo: l.lineNo, code: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, intakeDescription: p?.description ?? "", competitorName: p?.competitor ?? "",
      pacr: { sku: p?.ownSku ?? null, grade: p?.matchType ?? "", pricebook: p?.pricebook ?? null, price: p?.price ?? null },
      resolution: { status: l.resolutionStatus, kind: cp?.resolution ?? null, note: l.resolutionNote ?? cp?.resolutionNote ?? null, confidence: cp?.confidence ?? null, manufacturer: cp?.manufacturer ?? null, brand: cp?.brand ?? null, description: cp?.description ?? null, gmdn: cp?.gmdnName ?? null, sizes: raw?.device_sizes ?? [] },
      identity: Boolean(cp && cp.manufacturer === company.name), matchStatus: l.matchStatus,
      compBin: bin ? { productType: bin.productType, family: bin.family, dims: bin.dimensions, features: bin.features } : null,
      candidates: cands, waterfall,
    };
  });
  const out: EvalFile = {
    label, commit: commit(), at: new Date().toISOString(), file: path.basename(file), requestId: req.id, reference: done.reference, useLlm, ms,
    intake: { sheetRows: pacr.length + 1, pacrLines: pacr.length, parsed: intake.lines.length, skipped, merged: intake.duplicatesMerged, unaccounted: pacr.length - intake.lines.length - intake.duplicatesMerged - skipped.length, codesNotInPacr, pacrNotParsed },
    records,
  };
  fs.mkdirSync("docs/eval", { recursive: true });
  const outFile = argOf("out", `docs/eval/${label}.json`)!;
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`${done.reference} (${req.id}) ${records.length} lines in ${(ms / 1000).toFixed(1)}s → ${outFile}`);
  return outFile;
}

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------
type Metrics = ReturnType<typeof metricsOf> extends Promise<infer T> ? T : never;

/**
 * The measurement profile of a competitor line or an own SKU — built by the same provenance-ordered
 * reader the matcher uses (structured GUDID sizes > SKU convention > GUDID text > intake text), so the
 * report and the rule agree on what "12 mm" or "cannula" means.
 */
function competitorProfile(r: Rec): AccessProfile {
  return buildAccessProfile([
    ...(r.resolution.sizes.length ? [{ text: null, source: "gudid:size" as const, sizes: r.resolution.sizes }] : []),
    { text: r.code, source: "sku", manufacturer: r.resolution.manufacturer ?? r.competitorName },
    { text: [r.resolution.brand, r.resolution.description].filter(Boolean).join(" ; "), source: "gudid:description", gmdn: r.resolution.gmdn },
    { text: r.intakeDescription, source: "intake:description" },
  ]);
}
function ownProfile(sku: string, description: string): AccessProfile {
  return buildAccessProfile([{ text: sku, source: "sku", manufacturer: "Medtronic" }, { text: description, source: "catalog:description" }]);
}
export function diametersOf(texts: (string | null | undefined)[], sizes: { type?: string; value?: string; unit?: string }[] = []): number[] {
  const p = buildAccessProfile([...(sizes.length ? [{ text: null, source: "gudid:size" as const, sizes }] : []), ...texts.filter(Boolean).map((t) => ({ text: t, source: "gudid:description" as const }))]);
  return p.diameters;
}

function diameterAgree(a: number[], b: number[]): boolean | null {
  if (!a.length || !b.length) return null;
  return a.some((x) => b.some((y) => Math.abs(x - y) <= 0.5));
}

/**
 * The REQ-7628 "PACR advantage" lines: codes where the earlier comparison found PACR's answer more
 * useful than Crosswalk's. `pacr` is PACR's actual pick from the export; `expected` is the answer the
 * product evidence supports (optical for OPTIVIEW / Kii Fios, cannula-only for sleeves, the stated
 * size and length, bladeless for dilating tips) — they differ where PACR itself is off.
 */
const PACR_WINS: { code: string; pacr: string; expected: string[]; why: string }[] = [
  { code: "2B5ST", pacr: "ONB5STF", expected: ["ONB5SHF"], why: "OPTIVIEW optical 5 mm × 75 mm → the 70 mm short optical trocar (PACR gives the 100 mm)" },
  { code: "2B5LT", pacr: "ONB5STF", expected: ["ONB5STF"], why: "OPTIVIEW optical 5 × 100" },
  { code: "2B5XT", pacr: "ONB5LGF", expected: ["ONB5LGF"], why: "OPTIVIEW optical 5 × 150 (XT), despite the item master's '100 mm'" },
  { code: "2B12XT", pacr: "ONB12LGF", expected: ["ONB12LGF"], why: "OPTIVIEW optical 12 × 150" },
  { code: "CTF04", pacr: "NONB5LGF", expected: ["ONB5STF"], why: "Kii Fios optical 5 × 100 (PACR: non-optical, 150 mm)" },
  { code: "CTF73", pacr: "NB12STF", expected: ["ONB12STF"], why: "Kii Fios optical 12 × 100 (PACR: non-optical bladeless)" },
  { code: "CTF74", pacr: "NB12STF", expected: ["ONB12STF"], why: "Kii Fios optical 12 × 100" },
  { code: "CTF71", pacr: "NB12LGF", expected: ["ONB12LGF"], why: "Kii Fios optical 12 × 150" },
  { code: "CB5ST", pacr: "ONB5SHF", expected: ["UNVCA5SHF"], why: "universal sleeve 5 × 75 → cannula only (PACR gives a complete trocar)" },
  { code: "CB5LT", pacr: "UNVCA5STF", expected: ["UNVCA5STF"], why: "universal sleeve 5 × 100" },
  { code: "CB11LT", pacr: "UNVCA11STF", expected: ["UNVCA11STF"], why: "universal sleeve 11 × 100" },
  { code: "CB12LT", pacr: "UNVCA12STF", expected: ["UNVCA12STF"], why: "universal sleeve 12 × 100" },
  { code: "2CB5LT", pacr: "UNVCA5STF", expected: ["UNVCA5STF"], why: "OPTIVIEW universal sleeve 5 × 100" },
  { code: "2CB12LT", pacr: "UNVCA12STF", expected: ["UNVCA12STF"], why: "OPTIVIEW universal sleeve 12 × 100" },
  { code: "CTB11LT", pacr: "UNVCA11STF", expected: ["UNVCA11STF"], why: "BASX universal sleeve 11 × 100" },
  { code: "CTB12LT", pacr: "UNVCA11STF", expected: ["UNVCA12STF"], why: "BASX universal sleeve 12 × 100 (PACR gives the 11 mm)" },
  { code: "23NBL", pacr: "MS101003", expected: ["MS101003"], why: "2 mm/3 mm mini trocar → the 2/3 mm Mini Step" },
  { code: "D5LT", pacr: "B5STF", expected: ["NONB5STF", "NB5STF"], why: "dilating tip = bladeless 5 × 100 (PACR: bladed)" },
  { code: "D11LT", pacr: "B11STF", expected: ["NONB11STF", "NB11STF"], why: "dilating tip = bladeless 11 × 100 (PACR: bladed)" },
  { code: "D12LT", pacr: "B12STS", expected: ["NONB12STF", "NB12STF", "NONB12STS", "NB12STS"], why: "dilating tip = bladeless 12 × 100 (PACR: bladed)" },
];

async function curatedExpectations(codes: string[]) {
  const own = await prisma.ownProduct.findMany({ where: { isActive: true }, select: { sku: true } });
  const ownSkus = new Set(own.map((p) => p.sku.toUpperCase()));
  const rows = await prisma.knownCross.findMany({ where: { isActive: true, approvalStatus: "APPROVED", competitorCodeNorm: { in: [...new Set(codes.flatMap((c) => [c, compactCfn(c)]))] } } });
  const byCode = new Map<string, { strong: Set<string>; any: Set<string>; grades: Map<string, string> }>();
  for (const k of rows) {
    const sku = (k.preferredOwnSku ?? k.ownSku).toUpperCase();
    if (!ownSkus.has(sku)) continue;
    for (const key of [k.competitorCodeNorm, compactCfn(k.competitorCodeNorm)]) {
      const e = byCode.get(key) ?? { strong: new Set<string>(), any: new Set<string>(), grades: new Map<string, string>() };
      e.any.add(sku); if (["Exact Match", "Close Match"].includes(k.matchType)) e.strong.add(sku);
      const prev = e.grades.get(sku); if (!prev || (k.matchType === "Exact Match")) e.grades.set(sku, k.matchType);
      byCode.set(key, e);
    }
  }
  return byCode;
}

const GRADES = ["Exact Match", "Close Match", "Alternative Match", "US Downsell Match", "No Match"];
const count = <T extends string>(xs: T[]) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>);

async function metricsOf(f: EvalFile) {
  const curated = await curatedExpectations(f.records.map((r) => r.cfnNorm));
  const R = f.records;
  const top = (r: Rec) => (r.candidates[0] && r.candidates[0].grade !== "No Match" ? r.candidates[0] : null);
  const proposed = R.filter((r) => top(r));
  const pacrProposed = R.filter((r) => r.pacr.sku);
  // agreement
  const agree = { bothNone: 0, same: 0, sameGrade: 0, pacrNextBest: 0, pacrRank4Plus: 0, different: 0, cwOnly: 0, pacrOnly: 0, cwOnlyByConf: {} as Record<string, number> };
  const calib: Record<string, number> = {};
  for (const r of R) {
    const t = top(r), p = r.pacr.sku?.toUpperCase() ?? null;
    if (!t && !p) { agree.bothNone++; continue; }
    if (t && !p) { agree.cwOnly++; const b = t.score >= 0.9 ? "≥0.9" : t.score >= 0.8 ? "0.8–0.9" : t.score >= 0.7 ? "0.7–0.8" : "<0.7"; agree.cwOnlyByConf[b] = (agree.cwOnlyByConf[b] ?? 0) + 1; continue; }
    if (!t && p) { agree.pacrOnly++; continue; }
    if (t!.sku.toUpperCase() === p) { agree.same++; if (t!.grade === r.pacr.grade) agree.sameGrade++; else calib[`PACR ${r.pacr.grade} / CW ${t!.grade}`] = (calib[`PACR ${r.pacr.grade} / CW ${t!.grade}`] ?? 0) + 1; continue; }
    const rank = r.candidates.findIndex((c) => c.sku.toUpperCase() === p);
    if (rank >= 1 && rank <= 2) agree.pacrNextBest++; else if (rank >= 3) agree.pacrRank4Plus++; else agree.different++;
  }
  // curated
  const cur = { lines: 0, top1: 0, top3: 0, contradictedByTop: 0, strongLines: 0, strongTop1: 0, pacrLines: 0, pacrTop1: 0, pacrContradict: 0 };
  for (const r of R) {
    const e = curated.get(r.cfnNorm) ?? curated.get(compactCfn(r.cfnNorm));
    if (!e || !e.any.size) continue;
    const t = top(r);
    cur.lines++;
    if (t && e.any.has(t.sku.toUpperCase())) cur.top1++;
    if (r.candidates.slice(0, 3).some((c) => c.grade !== "No Match" && e.any.has(c.sku.toUpperCase()))) cur.top3++;
    if (t && !e.any.has(t.sku.toUpperCase())) cur.contradictedByTop++;
    if (e.strong.size) { cur.strongLines++; if (t && e.strong.has(t.sku.toUpperCase())) cur.strongTop1++; }
    if (r.pacr.sku) { cur.pacrLines++; if (e.any.has(r.pacr.sku.toUpperCase())) cur.pacrTop1++; else cur.pacrContradict++; }
  }
  // diameter + component mismatches, measured the same way for both systems
  const ownDesc = new Map<string, string>();
  for (const r of R) for (const c of r.candidates) ownDesc.set(c.sku.toUpperCase(), c.description);
  const pacrSkus = [...new Set(R.map((r) => r.pacr.sku?.toUpperCase()).filter((x): x is string => Boolean(x)))].filter((s) => !ownDesc.has(s));
  if (pacrSkus.length) for (const p of await prisma.ownProduct.findMany({ where: { sku: { in: pacrSkus, mode: "insensitive" } }, select: { sku: true, description: true } })) ownDesc.set(p.sku.toUpperCase(), p.description);
  const mism = { cw: { diameter: 0, diameterChecked: 0, component: 0, componentChecked: 0, list: [] as string[], clist: [] as string[] }, pacr: { diameter: 0, diameterChecked: 0, component: 0, componentChecked: 0, list: [] as string[], clist: [] as string[] } };
  for (const r of R) {
    if (r.identity) continue;
    const cpf = competitorProfile(r);
    const cd = cpf.diameters, cc = cpf.component;
    const check = (sku: string | null, side: "cw" | "pacr") => {
      if (!sku) return;
      const desc = ownDesc.get(sku.toUpperCase()) ?? "";
      const opf = ownProfile(sku, desc);
      const od = opf.diameters;
      const ag = diameterAgree(cd, od);
      if (ag !== null) { mism[side].diameterChecked++; if (!ag) { mism[side].diameter++; mism[side].list.push(`${r.code} (${cd.join("/")} mm) → ${sku} (${od.join("/")} mm)`); } }
      const oc = opf.component;
      if (cc !== "unknown" && oc !== "unknown") { mism[side].componentChecked++; if (!componentsCompatible(cc, oc)) { mism[side].component++; mism[side].clist.push(`${r.code} [${cc}] → ${sku} [${oc}]`); } }
    };
    check(top(r)?.sku ?? null, "cw");
    check(r.pacr.sku, "pacr");
  }
  // identity preservation
  const identity = R.filter((r) => r.identity);
  const identityKept = identity.filter((r) => top(r)?.sku.toUpperCase() === r.cfnNorm.toUpperCase() || top(r)?.sku.toUpperCase() === r.code.toUpperCase()).length;
  // pricing
  const priced = proposed.filter((r) => top(r)!.unitPrice != null);
  const priceable = proposed.filter((r) => r.waterfall?.price != null);
  const bySource = count(priceable.map((r) => `${r.waterfall!.source}:${r.waterfall!.contract ?? ""}`));
  const pacrPriced = pacrProposed.filter((r) => r.pacr.price != null);
  // PACR wins
  const wins = PACR_WINS.map((w) => {
    const r = R.find((x) => x.code.toUpperCase() === w.code || x.cfnNorm === w.code);
    const t = r ? top(r) : null;
    const rank = r ? r.candidates.findIndex((c) => c.sku.toUpperCase() === w.pacr.toUpperCase()) : -1;
    const expRank = r ? r.candidates.findIndex((c) => w.expected.some((e) => e.toUpperCase() === c.sku.toUpperCase()) && c.grade !== "No Match") : -1;
    return { ...w, cw: t ? `${t.sku} (${t.grade}, conf ${(t.confidence ?? t.score).toFixed(2)}, ${t.source})` : r ? `— (${r.resolution.status}/${r.matchStatus})` : "line missing", pacrRank: rank >= 0 ? rank + 1 : null, expectedRank: expRank >= 0 ? expRank + 1 : null, hit: expRank === 0, samePacr: rank === 0 };
  });
  // next-best quality: distinct SKUs among the top 3, and the share of lines whose alternatives repeat the top's grade+description
  const nextBest = { linesWithAlt: 0, altDistinct: 0, altSameDiameterAsTop: 0 };
  for (const r of proposed) {
    const alts = r.candidates.slice(1, 3).filter((c) => c.grade !== "No Match");
    if (!alts.length) continue;
    nextBest.linesWithAlt++;
    if (new Set([r.candidates[0].sku, ...alts.map((a) => a.sku)]).size === alts.length + 1) nextBest.altDistinct++;
    const td = diametersOf([r.candidates[0].description]);
    if (alts.every((a) => diameterAgree(td, diametersOf([a.description])) !== false)) nextBest.altSameDiameterAsTop++;
  }
  return {
    label: f.label, commit: f.commit, at: f.at, reference: f.reference, ms: f.ms, useLlm: f.useLlm,
    intake: { ...f.intake, skipped: f.intake.skipped.length, skippedDetail: f.intake.skipped },
    identification: { resolved: R.filter((r) => r.resolution.status === "resolved").length, notFound: R.filter((r) => r.resolution.status === "not-found").length, error: R.filter((r) => r.resolution.status === "error").length, bySource: count(R.map((r) => r.resolution.kind ?? r.resolution.status)), viaLibrary: R.filter((r) => /library/i.test(r.resolution.note ?? "")).length, lowConfidence: R.filter((r) => r.resolution.status === "resolved" && (r.resolution.confidence ?? 1) < 0.75).length },
    confidence: { verify: proposed.filter((r) => top(r)!.confidence != null && top(r)!.confidence! < 0.75).length, byBand: count(proposed.map((r) => { const c = top(r)!.confidence; return c == null ? "n/a" : c >= 0.9 ? "≥0.9" : c >= 0.75 ? "0.75–0.9" : c >= 0.6 ? "0.6–0.75" : "<0.6"; })), meanByGrade: Object.fromEntries(GRADES.map((g) => { const xs = proposed.filter((r) => top(r)!.grade === g && top(r)!.confidence != null).map((r) => top(r)!.confidence!); return [g, xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null]; }).filter(([, v]) => v !== null)) },
    matching: { proposed: proposed.length, pacrProposed: pacrProposed.length, byGrade: count(proposed.map((r) => top(r)!.grade)), pacrByGrade: count(pacrProposed.map((r) => r.pacr.grade)), bySource: count(proposed.map((r) => top(r)!.source)), noMatch: R.filter((r) => r.matchStatus === "no-match").length, notFound: R.filter((r) => r.resolution.status === "not-found").length, identityLines: identity.length, identityKept, meanScoreByGrade: Object.fromEntries(GRADES.map((g) => { const xs = proposed.filter((r) => top(r)!.grade === g).map((r) => top(r)!.score); return [g, xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null]; }).filter(([, v]) => v !== null)) },
    agreement: { ...agree, calibration: calib },
    curated: cur,
    mismatches: { cw: { diameter: mism.cw.diameter, checked: mism.cw.diameterChecked, component: mism.cw.component, componentChecked: mism.cw.componentChecked }, pacr: { diameter: mism.pacr.diameter, checked: mism.pacr.diameterChecked, component: mism.pacr.component, componentChecked: mism.pacr.componentChecked }, cwDiameterList: mism.cw.list, cwComponentList: mism.cw.clist, pacrDiameterList: mism.pacr.list, pacrComponentList: mism.pacr.clist },
    pricing: { pricedByRun: priced.length, priceableUnderContract: priceable.length, bySource, pacrPriced: pacrPriced.length, pacrByBook: count(pacrPriced.map((r) => r.pacr.pricebook!)), samePriceAsPacr: proposed.filter((r) => r.pacr.sku && top(r)!.sku.toUpperCase() === r.pacr.sku.toUpperCase() && r.pacr.price != null && r.waterfall?.price != null && Math.abs(r.waterfall.price - r.pacr.price) < 0.005).length, sameSkuPricedByPacr: proposed.filter((r) => r.pacr.sku && top(r)!.sku.toUpperCase() === r.pacr.sku.toUpperCase() && r.pacr.price != null).length },
    nextBest,
    pacrWins: wins,
  };
}

const pct = (a: number, b: number) => (b ? `${a}/${b} (${((100 * a) / b).toFixed(1)}%)` : `${a}/0`);
const kv = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "—";

function render(m: Metrics, before?: Metrics) {
  const d = (a: number, b?: number) => (before && b !== undefined ? ` (was ${b}, ${a - b >= 0 ? "+" : ""}${a - b})` : "");
  const L: string[] = [];
  L.push(`# Evaluation: ${m.label} @ ${m.commit} — ${m.reference}, ${(m.ms / 1000).toFixed(1)} s, ${m.useLlm ? "LLM" : "heuristic"} mode${before ? ` (vs ${before.label} @ ${before.commit})` : ""}`);
  L.push(``, `## Input`, `- PACR data rows: ${m.intake.pacrLines}; parsed lines: ${m.intake.parsed}${d(m.intake.parsed, before?.intake.parsed)}; skipped: ${m.intake.skipped}; merged duplicates: ${m.intake.merged}; unaccounted: **${m.intake.unaccounted}**`);
  if (m.intake.skippedDetail.length) L.push(`- skipped: ${m.intake.skippedDetail.map((s) => `${s.code} (${s.reason})`).join("; ")}`);
  if (m.intake.pacrNotParsed.length) L.push(`- PACR codes not parsed: ${m.intake.pacrNotParsed.join(", ")}`);
  L.push(``, `## Identification`, `- resolved ${pct(m.identification.resolved, m.intake.parsed)}${d(m.identification.resolved, before?.identification.resolved)}; not found ${m.identification.notFound}; errors ${m.identification.error}; via local GUDID library ${m.identification.viaLibrary}; low-confidence resolutions ${m.identification.lowConfidence}`, `- by source: ${kv(m.identification.bySource)}`);
  L.push(``, `## Matching`, `- Crosswalk proposals: ${pct(m.matching.proposed, m.intake.parsed)}${d(m.matching.proposed, before?.matching.proposed)} — ${kv(m.matching.byGrade)}`, `- PACR proposals: ${pct(m.matching.pacrProposed, m.intake.pacrLines)} — ${kv(m.matching.pacrByGrade)}`, `- by source: ${kv(m.matching.bySource)}; no-match ${m.matching.noMatch}; not found ${m.matching.notFound}`, `- own-SKU (identity) lines: ${m.matching.identityLines}, preserved as SELF ${m.matching.identityKept}${d(m.matching.identityKept, before?.matching.identityKept)}`, `- mean score by grade: ${Object.entries(m.matching.meanScoreByGrade).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push(``, `## Confidence (separate from score and grade)`, `- top picks flagged "verify" (confidence < 0.75): ${m.confidence.verify}/${m.matching.proposed}; bands: ${kv(m.confidence.byBand)}; mean by grade: ${Object.entries(m.confidence.meanByGrade).map(([k, v]) => `${k} ${v}`).join(", ") || "not recorded at this commit"}`);
  L.push(``, `## Agreement with PACR (top pick)`, `- same SKU ${m.agreement.same}${d(m.agreement.same, before?.agreement.same)} (same grade ${m.agreement.sameGrade}); PACR pick is Crosswalk's next-best (rank 2–3) ${m.agreement.pacrNextBest}${d(m.agreement.pacrNextBest, before?.agreement.pacrNextBest)}; rank 4+ ${m.agreement.pacrRank4Plus}; different / not proposed ${m.agreement.different}${d(m.agreement.different, before?.agreement.different)}`, `- Crosswalk-only proposals ${m.agreement.cwOnly}${d(m.agreement.cwOnly, before?.agreement.cwOnly)} (by score: ${kv(m.agreement.cwOnlyByConf)}); PACR-only ${m.agreement.pacrOnly}${d(m.agreement.pacrOnly, before?.agreement.pacrOnly)}; neither ${m.agreement.bothNone}`, `- grade calibration on the same SKU: ${kv(m.agreement.calibration)}`);
  L.push(``, `## Curated cross-reference sheet`, `- lines with a curated cross: ${m.curated.lines}; Crosswalk top-1 ${pct(m.curated.top1, m.curated.lines)}${d(m.curated.top1, before?.curated.top1)}; top-3 ${pct(m.curated.top3, m.curated.lines)}${d(m.curated.top3, before?.curated.top3)}; top pick contradicts the sheet ${m.curated.contradictedByTop}${d(m.curated.contradictedByTop, before?.curated.contradictedByTop)}`, `- Exact/Close curated lines: ${m.curated.strongLines}, top-1 ${pct(m.curated.strongTop1, m.curated.strongLines)}`, `- PACR on the same lines: proposed ${m.curated.pacrLines}, agrees ${m.curated.pacrTop1}, contradicts ${m.curated.pacrContradict}`);
  L.push(``, `## Mismatches (same measurement for both systems; identity lines excluded)`, `- diameter: Crosswalk ${m.mismatches.cw.diameter}/${m.mismatches.cw.checked} checked${d(m.mismatches.cw.diameter, before?.mismatches.cw.diameter)}; PACR ${m.mismatches.pacr.diameter}/${m.mismatches.pacr.checked}`, `- component / device type: Crosswalk ${m.mismatches.cw.component}/${m.mismatches.cw.componentChecked} checked${d(m.mismatches.cw.component, before?.mismatches.cw.component)}; PACR ${m.mismatches.pacr.component}/${m.mismatches.pacr.componentChecked}`);
  if (m.mismatches.cwDiameterList.length) L.push(`- Crosswalk diameter mismatches: ${m.mismatches.cwDiameterList.join("; ")}`);
  if (m.mismatches.cwComponentList.length) L.push(`- Crosswalk component mismatches: ${m.mismatches.cwComponentList.join("; ")}`);
  if (m.mismatches.pacrDiameterList.length) L.push(`- PACR diameter mismatches: ${m.mismatches.pacrDiameterList.join("; ")}`);
  if (m.mismatches.pacrComponentList.length) L.push(`- PACR component mismatches: ${m.mismatches.pacrComponentList.join("; ")}`);
  L.push(``, `## Pricing (account ${SANFORD.accountNumber})`, `- proposals priced by the run: ${pct(m.pricing.pricedByRun, m.matching.proposed)}${d(m.pricing.pricedByRun, before?.pricing.pricedByRun)}; priceable under the account's contracts: ${pct(m.pricing.priceableUnderContract, m.matching.proposed)} — ${kv(m.pricing.bySource)}`, `- PACR priced ${pct(m.pricing.pacrPriced, m.matching.pacrProposed)} — ${kv(m.pricing.pacrByBook)}`, `- same SKU as PACR and PACR priced it: ${m.pricing.sameSkuPricedByPacr}; contract price identical: ${m.pricing.samePriceAsPacr}`);
  L.push(``, `## Next-best`, `- lines with alternatives: ${m.nextBest.linesWithAlt}; all distinct SKUs ${m.nextBest.altDistinct}; alternatives keep the top pick's diameter ${m.nextBest.altSameDiameterAsTop}`);
  L.push(``, `## PACR-win cases (REQ-7628)`, `| code | PACR's pick | evidence-based answer | Crosswalk top | expected rank | PACR pick rank | note |`, `|---|---|---|---|---|---|---|`);
  for (const w of m.pacrWins) L.push(`| ${w.code} | ${w.pacr} | ${w.expected.join(" / ")} | ${w.cw} | ${w.expectedRank ?? "—"} | ${w.pacrRank ?? "—"} | ${w.why} |`);
  L.push(``, `- Crosswalk top pick is the evidence-based answer: ${m.pacrWins.filter((w) => w.hit).length}/${m.pacrWins.length}${before ? ` (was ${before.pacrWins.filter((w) => w.hit).length})` : ""}; in top-3: ${m.pacrWins.filter((w) => w.expectedRank && w.expectedRank <= 3).length}; same SKU as PACR: ${m.pacrWins.filter((w) => w.samePacr).length}; PACR's own pick is the evidence-based answer in ${m.pacrWins.filter((w) => w.expected.some((e) => e.toUpperCase() === w.pacr.toUpperCase())).length}`);
  return L.join("\n");
}

async function report(file: string) {
  const f = JSON.parse(fs.readFileSync(file, "utf8")) as EvalFile;
  const m = await metricsOf(f);
  const beforeFile = argOf("before");
  const before = beforeFile ? await metricsOf(JSON.parse(fs.readFileSync(beforeFile, "utf8")) as EvalFile) : undefined;
  const md = render(m, before);
  const out = argOf("out");
  if (out) fs.writeFileSync(out, md + "\n");
  console.log(md);
  if (process.argv.includes("--json")) fs.writeFileSync(file.replace(/\.json$/, ".metrics.json"), JSON.stringify(m, null, 1));
}

/** Offline fixture for tests/unit/pacr-regression.test.ts: the trocar catalog, the listed codes as resolved, their intake descriptions and curated rows. */
async function fixture(evalFile: string) {
  const { summarizeRecord } = await import("../src/lib/gudid/openfda");
  const f = JSON.parse(fs.readFileSync(evalFile, "utf8")) as EvalFile;
  const codes = (argOf("codes") ?? PACR_WINS.map((w) => w.code).join(",")).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  const own = await prisma.ownProduct.findMany({ where: { isActive: true, category: "Trocar Products" }, select: { sku: true, description: true, brand: true, labeler: true, gmdnName: true, gudidJson: true }, orderBy: { sku: "asc" } });
  const sizesOf = (json: string | null) => { const raw = json ? (JSON.parse(json) as Parameters<typeof summarizeRecord>[0]) : null; return raw ? summarizeRecord(raw).sizes : []; };
  const catalog = own.map((p) => ({ sku: p.sku, description: p.description, brand: p.brand, labeler: p.labeler, gmdnName: p.gmdnName, sizes: sizesOf(p.gudidJson) }));
  const cps = await prisma.competitorProduct.findMany({ where: { cfnNorm: { in: codes } } });
  const intake = new Map(f.records.map((r) => [r.code.toUpperCase(), r.intakeDescription]));
  const competitors = cps.map((cp) => ({ code: cp.cfnNorm, manufacturer: cp.manufacturer, brand: cp.brand, description: cp.description, gmdnName: cp.gmdnName, sizes: sizesOf(cp.gudidJson), intake: intake.get(cp.cfnNorm) ?? null }));
  const crosses = await prisma.knownCross.findMany({ where: { isActive: true, approvalStatus: "APPROVED", competitorCodeNorm: { in: codes } }, select: { competitorCodeNorm: true, ownSku: true, preferredOwnSku: true, matchType: true, source: true, competitorDescription: true } });
  const out = argOf("out", "tests/fixtures/trocar-benchmark.json")!;
  fs.writeFileSync(out, JSON.stringify({ note: "Medtronic trocar-family catalog rows (public GUDID descriptions), the REQ-7628 competitor codes as resolved from GUDID with their intake descriptions, and the curated cross rows for them. Regenerate: npx tsx scripts/eval-pacr.ts fixture docs/eval/after.json [--codes A,B,…]", catalog, competitors, crosses }, null, 1));
  console.log(`${catalog.length} catalog rows, ${competitors.length} competitors, ${crosses.length} curated rows → ${out}`);
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === "run" && file) await run(file);
  else if (mode === "report" && file) await report(file);
  else if (mode === "fixture" && file) await fixture(file);
  else throw new Error("usage: eval-pacr.ts run <pacr.xlsx> --label L | report <eval.json> [--before other.json] [--out file.md] [--json] | fixture <eval.json> [--codes A,B] [--out file]");
}
main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

/**
 * Matcher evaluation against the curated crosses (ground truth).
 *
 *   npx tsx scripts/eval.ts [--n 80] [--seed 7] [--family "Trocar Products"] [--no-crosses]
 *
 * For each sampled curated cross (competitor code -> expected MDT SKU) we
 * resolve the competitor code in GUDID, bin it, and rank our catalog with the
 * *known-cross shortcut disabled* (--no-crosses is the honest number: what the
 * attribute matcher finds on its own). Reports resolution rate, top-1 and
 * top-3 hit rate, and the misses so the heuristics can be tuned.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { resolveCfn } from "../src/lib/pipeline/resolve";
import { parseBin, binSimilarity, heuristicBin, withAccessProfile, type Bin } from "../src/lib/match/bin";
import { mergeProfiles, emptyProfile } from "../src/lib/match/access";
import { scoreCandidates } from "../src/lib/match/score";
import { binProduct } from "../src/lib/ai/gateway";
import { loadSiblingIndex } from "../src/lib/pipeline/siblings-index";
import { summarizeRecord, type OpenFdaRecord } from "../src/lib/gudid/openfda";
import { llmConfig } from "../src/lib/ai/gateway";
import { getCompany } from "../src/lib/settings";

function mergeBins(primary: Bin | null, extra: Bin): Bin {
  if (!primary) return extra;
  // Access products: the curated description is line-level evidence, folded in the way the pipeline folds an intake description.
  if (primary.family === "Trocar Products" && extra.access) return withAccessProfile(primary, mergeProfiles(primary.access ?? emptyProfile(), extra.access));
  const dims = [...primary.dimensions];
  for (const d of extra.dimensions) if (!dims.some((x) => x.name === d.name)) dims.push(d);
  return { ...primary, family: primary.family === "Other" ? extra.family : primary.family, dimensions: dims, features: [...new Set([...primary.features, ...extra.features])], materials: [...new Set([...primary.materials, ...extra.materials])] };
}

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

async function main() {
  const n = Number(arg("n", "60"));
  const family = arg("family", "");
  const useCrosses = !process.argv.includes("--no-crosses");
  const useLlm = llmConfig().available && !process.argv.includes("--no-llm");
  const rand = rng(Number(arg("seed", "7")));

  const all = await prisma.knownCross.findMany({ where: { isActive: true, matchType: { in: ["Exact Match", "Close Match"] }, NOT: { competitorName: "Medtronic" }, ...(family ? { category: family } : {}) } });
  // one expected SKU per competitor code (prefer Exact, then the reviewer's preferred SKU)
  const byCode = new Map<string, { code: string; expected: Set<string>; name: string; desc: string | null }>();
  for (const k of all) {
    const e = byCode.get(k.competitorCodeNorm) ?? { code: k.competitorCodeNorm, expected: new Set<string>(), name: k.competitorName, desc: k.competitorDescription };
    e.expected.add((k.preferredOwnSku ?? k.ownSku).toUpperCase());
    byCode.set(k.competitorCodeNorm, e);
  }
  const own = await prisma.ownProduct.findMany({ where: { isActive: true }, orderBy: { sku: "asc" } });
  const ownSkus = new Set(own.map((p) => p.sku.toUpperCase()));
  // Reviewer columns carry notes (DUPLICATE, DISCONT, HAND…); only real SKUs count as expected answers.
  for (const e of byCode.values()) for (const x of [...e.expected]) if (!ownSkus.has(x)) e.expected.delete(x);
  const pool = [...byCode.values()].filter((e) => e.expected.size > 0).sort(() => rand() - 0.5).slice(0, n);
  const company = await getCompany();
  const ownBins = own.map((p) => ({ p, bin: parseBin(p.binJson) ?? heuristicBin({ sku: p.sku, manufacturer: p.labeler ?? company.name, brand: p.brand, description: p.description, category: p.category, gmdnName: p.gmdnName }) }));
  const crosses = await prisma.knownCross.findMany({ where: { isActive: true } });

  // Sibling-family evidence, as the run pipeline provides it (loaded per labeler on first use).
  const siblingIndex = new Map<string, Awaited<ReturnType<typeof loadSiblingIndex>>>();
  let resolved = 0, top1 = 0, top3 = 0, resolvedTop1 = 0;
  const misses: string[] = [];
  const t0 = Date.now();
  for (const [i, item] of pool.entries()) {
    const cp = await resolveCfn(item.code, { useLlm, strict: false });
    let bin: Bin | null = cp && cp.resolution !== "not-found" ? parseBin(cp.binJson) : null;
    if (cp && cp.resolution !== "not-found" && !bin) {
      const raw = cp.gudidJson ? (JSON.parse(cp.gudidJson) as OpenFdaRecord) : null;
      const s = raw ? summarizeRecord(raw) : null;
      if (cp.manufacturer && !siblingIndex.has(cp.manufacturer)) siblingIndex.set(cp.manufacturer, await loadSiblingIndex([cp.manufacturer]));
      const siblings = cp.manufacturer ? siblingIndex.get(cp.manufacturer)!.get(cp.manufacturer, cp.brand) : null;
      const b = await binProduct({ subject: item.code, code: cp.cfnMatched ?? cp.cfnNorm, brand: cp.brand, description: cp.description, manufacturer: cp.manufacturer, gmdnName: cp.gmdnName, sizes: s?.sizes, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable, siblings, useLlm });
      bin = b.bin;
      await prisma.competitorProduct.update({ where: { id: cp.id }, data: { binJson: JSON.stringify(bin), binSource: b.source, binnedAt: new Date() } });
    }
    const isResolved = Boolean(bin);
    if (isResolved) resolved++;
    // Fall back to the curated description when GUDID has nothing (that's what a rep would read)
    // Curated sheets describe the competitor code better than GUDID often does; use both.
    const compDesc = [cp?.description, item.desc].filter(Boolean).join(" ; ");
    const compBin = mergeBins(bin, heuristicBin({ code: item.code, manufacturer: cp?.manufacturer ?? item.name, description: compDesc }));
    const pool2 = ownBins.filter((o) => compBin.family === "Other" || o.bin.family === "Other" || o.bin.family === compBin.family);
    const ranked = pool2.map((o) => ({ o, s: binSimilarity(compBin, o.bin, compDesc, o.p.description).score })).sort((a, b) => b.s - a.s).slice(0, 8);
    const kc = useCrosses ? crosses.filter((k) => k.competitorCodeNorm === item.code) : [];
    const scored = scoreCandidates({ bin: compBin, description: compDesc, estPrice: null }, ranked.map((r) => ({ ownProductId: r.o.p.id, sku: r.o.p.sku, description: r.o.p.description, bin: r.o.bin, unitPrice: null, cogs: null, knownCross: kc.find((k) => k.ownSku === r.o.p.sku) ? { matchType: "Close Match", source: "eval" } : null })));
    const top = scored.slice(0, 3).map((s) => s.sku.toUpperCase());
    const hit1 = top[0] && item.expected.has(top[0]);
    const hit3 = top.some((s) => item.expected.has(s));
    if (hit1) { top1++; if (isResolved) resolvedTop1++; }
    if (hit3) top3++;
    if (!hit3) misses.push(`${item.code.padEnd(14)} ${item.name.padEnd(18)} expected ${[...item.expected].join("/").padEnd(14)} got ${top.join(", ") || "—"}  | ${(compDesc || "").slice(0, 60)}`);
    process.stdout.write(`\r${i + 1}/${pool.length}  resolved ${resolved}  top1 ${top1}  top3 ${top3}`);
  }
  console.log(`\n\nEvaluated ${pool.length} curated crosses in ${((Date.now() - t0) / 1000).toFixed(0)}s (${useLlm ? llmConfig().model : "heuristic"}, known-cross shortcut ${useCrosses ? "ON" : "OFF"})`);
  console.log(`GUDID resolution : ${resolved}/${pool.length} (${Math.round((resolved / pool.length) * 100)}%)`);
  console.log(`Top-1 hit        : ${top1}/${pool.length} (${Math.round((top1 / pool.length) * 100)}%)  — of resolved: ${resolvedTop1}/${resolved}`);
  console.log(`Top-3 hit        : ${top3}/${pool.length} (${Math.round((top3 / pool.length) * 100)}%)`);
  if (misses.length) { console.log(`\nMisses (${misses.length}):`); for (const m of misses) console.log("  " + m); }
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

import "dotenv/config";
import { prisma } from "@/lib/db";
import { heuristicBin, parseBin, binSimilarity } from "@/lib/match/bin";
import { summarizeRecord } from "@/lib/gudid/openfda";
import { curatedCandidates, competitorBinForLine } from "@/lib/match/line";
import { scoreCandidates } from "@/lib/match/score";
import { crossesForMatching } from "@/lib/xref/learning";
import { describeProfile } from "@/lib/match/access";

async function main() {
  const cp = await prisma.competitorProduct.findUniqueOrThrow({ where: { cfnNorm: "B12LTH" } });
  const raw = JSON.parse(cp.gudidJson!); const s = summarizeRecord(raw);
  const curated = await prisma.knownCross.findFirst({ where: { competitorCodeNorm: "B12LTH", competitorDescription: { not: null } }, orderBy: { id: "asc" } });
  const description = [cp.description, curated?.competitorDescription && !(cp.description ?? "").includes(curated.competitorDescription) ? curated.competitorDescription : null].filter(Boolean).join(" ; ");
  const compBin = heuristicBin({ code: cp.cfnMatched ?? cp.cfnNorm, name: cp.brand, description, brand: cp.brand, manufacturer: cp.manufacturer, gmdnName: cp.gmdnName, category: cp.category, sizes: s.sizes, singleUse: s.singleUse, sterile: s.sterile, implantable: s.implantable });
  console.log("competitor description:", description);
  console.log("competitor profile:", describeProfile(compBin.access!));
  console.log("evidence:", compBin.access!.evidence.map((e) => `${e.field}=${e.value} [${e.source}${e.via ? ":" + e.via : ""}]`).join("; "));
  const own = await prisma.ownProduct.findMany({ where: { isActive: true, category: "Trocar Products" }, omit: { gudidJson: true } });
  const crosses = (await crossesForMatching()).filter((k) => k.competitorCodeNorm === "B12LTH");
  const idBySku = new Map(own.map((o) => [o.sku.toUpperCase(), o.id]));
  const { ids, crossById } = curatedCandidates(crosses, idBySku);
  const withBins = own.map((p) => ({ p, bin: parseBin(p.binJson) ?? heuristicBin({ sku: p.sku, manufacturer: p.labeler ?? "Medtronic", brand: p.brand, description: p.description, category: p.category, gmdnName: p.gmdnName }) }));
  const ranked = withBins.map((o) => ({ o, s: binSimilarity(compBin, o.bin, cp.description ?? "", o.p.description).score })).sort((a, b) => b.s - a.s).slice(0, 5);
  for (const r of ranked) if (r.s >= 0.3) ids.add(r.o.p.id);
  const cands = withBins.filter((o) => ids.has(o.p.id));
  const scored = scoreCandidates({ bin: compBin, description: cp.description ?? "", estPrice: null }, cands.map((c) => { const k = crossById.get(c.p.id); return { ownProductId: c.p.id, sku: c.p.sku, description: c.p.description, bin: c.bin, unitPrice: c.p.listPrice ? Number(c.p.listPrice) : null, cogs: c.p.cogs ? Number(c.p.cogs) : null, provenance: c.p.source, knownCross: k ? { matchType: k.matchType, preferredOwnSku: k.preferredOwnSku, source: k.source, approvalStatus: k.approvalStatus, endorsements: k.endorsements, preferred: k.preferred } : null }; }));
  for (const sc of scored) console.log(`${sc.sku.padEnd(12)} ${sc.matchType.padEnd(18)} ${sc.source.padEnd(12)} score=${sc.score.toFixed(3)} bin=${sc.scoreBin.toFixed(3)} conf=${sc.confidence.toFixed(2)} cap=${sc.factors.cap} | ${describeProfile(sc.bin.access!)} | ${sc.rationale}`);
  await prisma.$disconnect();
}
main();

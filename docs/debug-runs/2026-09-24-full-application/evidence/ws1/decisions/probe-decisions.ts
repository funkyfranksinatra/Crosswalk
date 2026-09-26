import "dotenv/config";
import { prisma } from "@/lib/db";
import { heuristicBin } from "@/lib/match/bin";
import { summarizeRecord } from "@/lib/gudid/openfda";
import { describeProfile } from "@/lib/match/access";
import { loadSiblingIndex } from "@/lib/pipeline/siblings-index";
import { componentOf } from "@/lib/match/component";

async function main() {
  const codes = process.argv.slice(2);
  const cps = await prisma.competitorProduct.findMany({ where: { cfnNorm: { in: codes } } });
  const idx = await loadSiblingIndex(cps.map((c) => c.manufacturer));
  for (const code of codes) {
    const cp = cps.find((c) => c.cfnNorm === code);
    if (!cp) { console.log(`${code}: not in CompetitorProduct`); continue; }
    const s = cp.gudidJson ? summarizeRecord(JSON.parse(cp.gudidJson)) : null;
    const sib = idx.get(cp.manufacturer, cp.brand);
    const bin = heuristicBin({ code: cp.cfnMatched ?? cp.cfnNorm, name: cp.brand, brand: cp.brand, description: cp.description, manufacturer: cp.manufacturer, gmdnName: cp.gmdnName, category: cp.category, sizes: s?.sizes, singleUse: s?.singleUse, sterile: s?.sterile, implantable: s?.implantable, siblings: sib });
    console.log(`\n== ${code} · ${cp.manufacturer} · brand "${cp.brand}" · siblings in line: ${sib?.length ?? 0}`);
    console.log(`   description: ${cp.description}`);
    console.log(`   component: ${componentOf([cp.brand, cp.description].filter(Boolean).join(" ; "))} · profile: ${bin.access ? describeProfile(bin.access) : "-"}`);
    for (const e of bin.access?.evidence ?? []) if (/visual|component/.test(e.field)) console.log(`   evidence ${e.field}=${e.value} [${e.source}${e.via ? " · " + e.via : ""}]`);
  }
  await prisma.$disconnect();
}
main();

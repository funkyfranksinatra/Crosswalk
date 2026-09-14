import { prisma } from "@/lib/db";
import { handle, body, date, str, num } from "@/lib/api";
import { recordObservation, summaryFor, SOURCE_TYPES } from "@/lib/intelligence";
import { compactCfn, normalizeCfn } from "@/lib/cfn";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const sku = u.searchParams.get("sku");
  const accountId = u.searchParams.get("accountId");
  return handle("view_pricing", async () => {
    if (sku) {
      const acc = accountId ? await prisma.account.findUnique({ where: { id: accountId }, include: { memberships: true } }) : null;
      const summary = await summaryFor(sku, { accountId: acc?.id ?? null, gpoId: acc?.memberships.find((m) => !m.effectiveTo)?.gpoId ?? null, region: acc?.region ?? null, asOf: new Date(), currency: acc?.currency ?? "USD" });
      const rows = await prisma.competitorPriceObservation.findMany({ where: { competitorSku: compactCfn(normalizeCfn(sku)) }, include: { competitor: true, account: true, gpo: true, document: true }, orderBy: { observedAt: "desc" } });
      return { summary: { ...summary, observations: summary.observations.map((o) => ({ id: o.id, currentConfidence: o.currentConfidence, relevance: o.relevance, relation: o.relation, ageDays: o.ageDays })) }, rows };
    }
    const recent = await prisma.competitorPriceObservation.findMany({ include: { competitor: true, account: true }, orderBy: { observedAt: "desc" }, take: 200 });
    const bySku = await prisma.competitorPriceObservation.groupBy({ by: ["competitorSku", "competitorId"], _count: { _all: true }, _max: { observedAt: true }, _min: { price: true }, _avg: { price: true }, orderBy: { _count: { competitorSku: "desc" } }, take: 200 });
    const competitors = await prisma.competitor.findMany();
    return { recent, bySku: bySku.map((s) => ({ ...s, competitor: competitors.find((c) => c.id === s.competitorId)?.name ?? "" })), sourceTypes: SOURCE_TYPES };
  });
}
export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    return recordObservation(actor.id, { competitorName: String(b.competitorName), competitorSku: String(b.competitorSku), price: b.price, currency: str(b.currency) ?? "USD", uom: str(b.uom) ?? "EA", accountId: str(b.accountId), gpoId: str(b.gpoId), region: str(b.region), observedAt: date(b.observedAt) ?? new Date(), sourceType: String(b.sourceType ?? "REP_OBSERVED"), sourceRef: str(b.sourceRef), rawConfidence: num(b.rawConfidence), notes: str(b.notes) });
  });
}

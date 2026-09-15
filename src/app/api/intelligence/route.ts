import { prisma } from "@/lib/db";
import { handle, body, date, str, num, requireText, optText, positiveMoney, currencyCode } from "@/lib/api";
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
    const competitorName = requireText(b.competitorName, "competitorName", 120), competitorSku = requireText(b.competitorSku, "competitorSku", 80);
    const observedAt = b.observedAt ? date(b.observedAt) : new Date();
    if (!observedAt) throw new Error("observedAt is not a date");
    if (observedAt.getTime() > Date.now() + 86_400_000) throw new Error("observedAt is in the future");
    const rawConfidence = num(b.rawConfidence);
    if (rawConfidence !== null && (rawConfidence < 0 || rawConfidence > 1)) throw new Error("rawConfidence must be between 0 and 1");
    if (str(b.accountId) && !(await prisma.account.findUnique({ where: { id: String(b.accountId) }, select: { id: true } }))) throw new Error("unknown accountId");
    return recordObservation(actor.id, { competitorName, competitorSku, price: positiveMoney(b.price, "price"), currency: currencyCode(b.currency), uom: (optText(b.uom, "uom", 10) ?? "EA").toUpperCase(), accountId: str(b.accountId), gpoId: str(b.gpoId), region: optText(b.region, "region", 80), observedAt, sourceType: String(b.sourceType ?? "REP_OBSERVED"), sourceRef: optText(b.sourceRef, "sourceRef", 500), rawConfidence, notes: optText(b.notes, "notes", 4000) });
  });
}

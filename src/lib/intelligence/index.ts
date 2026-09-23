/**
 * Competitive intelligence repository: append-only observations + summaries.
 */
import { prisma } from "@/lib/db";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { toDb, money } from "@/lib/money";
import { audit } from "@/lib/audit";
import { defaultRawConfidence, summarize, type Context, type PriceSummary, SOURCE_TYPES } from "./summarize";

export { summarize, SOURCE_TYPES, SOURCE_PROFILE, type PriceSummary } from "./summarize";

export async function competitorByName(name: string) {
  const n = name.trim();
  const all = await prisma.competitor.findMany();
  const hit = all.find((c) => c.name.toLowerCase() === n.toLowerCase() || (JSON.parse(c.aliasesJson) as string[]).some((a) => a.toLowerCase() === n.toLowerCase()));
  return hit ?? prisma.competitor.create({ data: { name: n } });
}

export type NewObservation = {
  competitorName: string;
  competitorSku: string;
  competitorProductId?: string | null;
  price: unknown;
  currency?: string;
  uom?: string;
  accountId?: string | null;
  gpoId?: string | null;
  region?: string | null;
  observedAt: Date;
  effectiveAt?: Date | null;
  sourceType: string;
  sourceRef?: string | null;
  documentId?: string | null;
  rawConfidence?: number | null;
  notes?: string | null;
  proposalLineId?: string | null;
  /** Contract-price provenance (integration imports) */
  tier?: string | null;
  contractRef?: string | null;
  validTo?: Date | null;
  sourceSystem?: string | null;
  sourceOwner?: string | null;
  syncJobId?: string | null;
  competitorDescription?: string | null;
};

export async function recordObservation(actorUserId: string | null, o: NewObservation) {
  if (!SOURCE_TYPES.includes(o.sourceType as never)) throw new Error(`Unknown source type ${o.sourceType}`);
  const price = money(o.price as never);
  if (!price || price.lte(0)) throw new Error("Observed price must be positive");
  const competitor = await competitorByName(o.competitorName);
  const row = await prisma.competitorPriceObservation.create({
    data: {
      competitorId: competitor.id,
      competitorSku: compactCfn(normalizeCfn(o.competitorSku)),
      competitorProductId: o.competitorProductId ?? null,
      price: toDb(price)!,
      currency: o.currency ?? "USD",
      uom: o.uom ?? "EA",
      accountId: o.accountId ?? null,
      gpoId: o.gpoId ?? null,
      region: o.region ?? null,
      observedAt: o.observedAt,
      effectiveAt: o.effectiveAt ?? null,
      sourceType: o.sourceType,
      sourceRef: o.sourceRef ?? null,
      documentId: o.documentId ?? null,
      enteredByUserId: actorUserId,
      rawConfidence: o.rawConfidence ?? defaultRawConfidence(o.sourceType),
      notes: o.notes ?? null,
      proposalLineId: o.proposalLineId ?? null,
      tier: o.tier ?? null,
      contractRef: o.contractRef ?? null,
      validTo: o.validTo ?? null,
      sourceSystem: o.sourceSystem ?? null,
      sourceOwner: o.sourceOwner ?? null,
      syncJobId: o.syncJobId ?? null,
      competitorDescription: o.competitorDescription ?? null,
    },
  });
  await audit({ actorUserId, entityType: "CompetitorPriceObservation", entityId: row.id, action: "RECORDED", after: { competitor: competitor.name, sku: row.competitorSku, price: row.price.toString(), sourceType: row.sourceType } });
  return row;
}

export async function verifyObservation(actorUserId: string, id: string, status: "VERIFIED" | "DISPUTED" | "UNVERIFIED", notes?: string) {
  const before = await prisma.competitorPriceObservation.findUnique({ where: { id } });
  if (!before) throw new Error("observation not found");
  const row = await prisma.competitorPriceObservation.update({ where: { id }, data: { verificationStatus: status, verifiedByUserId: actorUserId, verifiedAt: new Date(), ...(notes ? { notes } : {}) } });
  await audit({ actorUserId, entityType: "CompetitorPriceObservation", entityId: id, action: "VERIFICATION_CHANGED", before: { status: before.verificationStatus }, after: { status } });
  return row;
}

/** Summary for one competitor code in the context of an account (or the market). */
export async function summaryFor(competitorSku: string, ctx: Context): Promise<PriceSummary> {
  const sku = compactCfn(normalizeCfn(competitorSku));
  const rows = await prisma.competitorPriceObservation.findMany({ where: { competitorSku: sku }, orderBy: { observedAt: "desc" } });
  return summarize(rows, ctx);
}

/** Batch: summaries for many codes with one query. */
export async function summariesFor(codes: string[], ctx: Context): Promise<Map<string, PriceSummary>> {
  const skus = [...new Set(codes.map((c) => compactCfn(normalizeCfn(c))))];
  const rows = await prisma.competitorPriceObservation.findMany({ where: { competitorSku: { in: skus } }, orderBy: { observedAt: "desc" } });
  const out = new Map<string, PriceSummary>();
  for (const sku of skus) out.set(sku, summarize(rows.filter((r) => r.competitorSku === sku), ctx));
  return out;
}

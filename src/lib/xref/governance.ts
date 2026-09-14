/**
 * Crosswalk governance. KnownCross rows are the working set (draft → review →
 * approved). Publishing freezes every approved, effective cross into a numbered
 * CrosswalkVersion; proposals pin the version they were built with and never follow
 * later changes. Reps only ever see the current PUBLISHED version.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { compactCfn, normalizeCfn } from "@/lib/cfn";

export const EQUIVALENCE = ["EXACT", "FUNCTIONAL", "CLOSEST_ALTERNATIVE", "PREMIUM_ALTERNATIVE", "PARTIAL_SUBSTITUTE", "NONE"] as const;
export type Equivalence = (typeof EQUIVALENCE)[number];

/** Match type (what the cross-reference engine says) → equivalence level (what may be represented to a customer). */
export function equivalenceFromMatchType(matchType: string): Equivalence {
  switch (matchType) {
    case "Exact Match": return "EXACT";
    case "Close Match": return "FUNCTIONAL";
    case "Alternative Match": return "CLOSEST_ALTERNATIVE";
    case "US Downsell Match": return "PARTIAL_SUBSTITUTE";
    default: return "NONE";
  }
}

export async function currentPublishedVersion() {
  return prisma.crosswalkVersion.findFirst({ where: { status: "PUBLISHED" }, orderBy: { number: "desc" } });
}

/** Approved cross for a competitor code in a given version (or the current published one). */
export async function approvedCross(competitorCode: string, versionId?: string | null) {
  const version = versionId ? await prisma.crosswalkVersion.findUnique({ where: { id: versionId } }) : await currentPublishedVersion();
  if (!version) return { version: null, entries: [] as { ownSku: string; matchType: string; equivalenceLevel: string; knownCrossId: string; approvedUsage: string | null; additionalProducts: string | null }[] };
  const norm = normalizeCfn(competitorCode);
  const entries = await prisma.crosswalkVersionEntry.findMany({ where: { versionId: version.id, competitorCodeNorm: { in: [norm, compactCfn(norm)] } } });
  return { version, entries };
}

export async function setReview(actorUserId: string, id: string, patch: { approvalStatus?: string; clinicalReviewStatus?: string; marketingReviewStatus?: string; equivalenceLevel?: string; approvedUsage?: string | null; justification?: string | null; effectiveFrom?: Date | null; effectiveTo?: Date | null }) {
  const before = await prisma.knownCross.findUnique({ where: { id } });
  if (!before) throw new Error("cross not found");
  const approving = patch.approvalStatus === "APPROVED" && before.approvalStatus !== "APPROVED";
  const row = await prisma.knownCross.update({ where: { id }, data: { ...patch, reviewerUserId: actorUserId, ...(approving ? { approvedByUserId: actorUserId, approvedAt: new Date() } : {}), version: { increment: 1 } } });
  await audit({ actorUserId, entityType: "KnownCross", entityId: id, action: approving ? "APPROVED" : "REVIEWED", before: { approvalStatus: before.approvalStatus, clinical: before.clinicalReviewStatus, marketing: before.marketingReviewStatus, equivalence: before.equivalenceLevel }, after: patch });
  return row;
}

/** Freeze all approved, active, currently effective crosses into a new published version. */
export async function publishVersion(actorUserId: string | null, notes?: string) {
  const asOf = new Date();
  const crosses = await prisma.knownCross.findMany({ where: { isActive: true, approvalStatus: "APPROVED", OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }], AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] }] } });
  const last = await prisma.crosswalkVersion.findFirst({ orderBy: { number: "desc" } });
  const version = await prisma.$transaction(async (tx) => {
    await tx.crosswalkVersion.updateMany({ where: { status: "PUBLISHED" }, data: { status: "SUPERSEDED", supersededAt: asOf } });
    const v = await tx.crosswalkVersion.create({ data: { number: (last?.number ?? 0) + 1, status: "PUBLISHED", notes: notes ?? null, createdByUserId: actorUserId, publishedAt: asOf, publishedByUserId: actorUserId } });
    // createMany in chunks — thousands of rows on the first publish
    for (let i = 0; i < crosses.length; i += 500) {
      await tx.crosswalkVersionEntry.createMany({ data: crosses.slice(i, i + 500).map((c) => ({ versionId: v.id, knownCrossId: c.id, ownSku: (c.preferredOwnSku && /^[A-Z0-9-]{4,}$/i.test(c.preferredOwnSku) ? c.preferredOwnSku : c.ownSku).toUpperCase(), competitorName: c.competitorName, competitorCodeNorm: c.competitorCodeNorm, matchType: c.matchType, equivalenceLevel: c.equivalenceLevel, approvedUsage: c.approvedUsage, additionalProducts: c.additionalProducts })) });
    }
    return v;
  }, { timeout: 120_000 });
  await audit({ actorUserId, entityType: "CrosswalkVersion", entityId: version.id, action: "PUBLISHED", after: { number: version.number, entries: crosses.length } });
  return { version, entries: crosses.length };
}

export async function retireVersion(actorUserId: string | null, id: string) {
  const v = await prisma.crosswalkVersion.update({ where: { id }, data: { status: "RETIRED" } });
  await audit({ actorUserId, entityType: "CrosswalkVersion", entityId: id, action: "RETIRED" });
  return v;
}

/** A rep-sourced cross (from a proposal / request decision): enters as DRAFT, never auto-approved. */
export async function proposeCross(actorUserId: string | null, input: { ownSku: string; competitorName: string; competitorCode: string; matchType: string; competitorDescription?: string | null; ownDescription?: string | null; category?: string | null; accountId?: string | null; justification?: string | null }) {
  const norm = normalizeCfn(input.competitorCode);
  const row = await prisma.knownCross.upsert({
    where: { ownSku_competitorCodeNorm_source: { ownSku: input.ownSku.toUpperCase(), competitorCodeNorm: norm, source: "rep" } },
    create: { ownSku: input.ownSku.toUpperCase(), ownDescription: input.ownDescription ?? null, category: input.category ?? null, competitorName: input.competitorName, competitorCode: input.competitorCode, competitorCodeNorm: norm, competitorDescription: input.competitorDescription ?? null, matchType: input.matchType, source: "rep", approvalStatus: "DRAFT", clinicalReviewStatus: "PENDING", marketingReviewStatus: "PENDING", equivalenceLevel: equivalenceFromMatchType(input.matchType), justification: input.justification ?? null, accountId: input.accountId ?? null, createdByUserId: actorUserId },
    update: { matchType: input.matchType, justification: input.justification ?? undefined },
  });
  await audit({ actorUserId, entityType: "KnownCross", entityId: row.id, action: "PROPOSED_BY_REP", after: { ownSku: row.ownSku, competitorCode: row.competitorCode, matchType: row.matchType } });
  return row;
}

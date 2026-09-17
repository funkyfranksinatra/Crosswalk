/**
 * Crosswalk governance. KnownCross rows are the working set (draft → review →
 * approved). Publishing freezes every approved, effective cross into a numbered
 * CrosswalkVersion; proposals pin the version they were built with and never follow
 * later changes. Reps only ever see the current PUBLISHED version.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { compactCfn, normalizeCfn, isPlaceholderSku } from "@/lib/cfn";

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
  const STATUS = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "RETIRED"], REVIEW = ["PENDING", "APPROVED", "REJECTED", "NOT_REQUIRED"], EQUIV = ["EXACT", "FUNCTIONAL", "CLOSEST_ALTERNATIVE", "PREMIUM_ALTERNATIVE", "PARTIAL_SUBSTITUTE", "NONE"];
  if (patch.approvalStatus !== undefined && !STATUS.includes(patch.approvalStatus)) throw new Error(`approvalStatus must be one of ${STATUS.join(", ")}`);
  if (patch.clinicalReviewStatus !== undefined && !REVIEW.includes(patch.clinicalReviewStatus)) throw new Error(`clinicalReviewStatus must be one of ${REVIEW.join(", ")}`);
  if (patch.marketingReviewStatus !== undefined && !REVIEW.includes(patch.marketingReviewStatus)) throw new Error(`marketingReviewStatus must be one of ${REVIEW.join(", ")}`);
  if (patch.equivalenceLevel !== undefined && !EQUIV.includes(patch.equivalenceLevel)) throw new Error(`equivalenceLevel must be one of ${EQUIV.join(", ")}`);
  if (patch.effectiveFrom && patch.effectiveTo && patch.effectiveTo <= patch.effectiveFrom) throw new Error("effectiveTo must be after effectiveFrom");
  const approving = patch.approvalStatus === "APPROVED" && before.approvalStatus !== "APPROVED";
  if (approving) {
    // Approval requires both reviews (docs/BUSINESS_RULES.md); an "Alternative" must never be published as an equivalent on one signature.
    const clinical = patch.clinicalReviewStatus ?? before.clinicalReviewStatus, marketing = patch.marketingReviewStatus ?? before.marketingReviewStatus;
    if (!["APPROVED", "NOT_REQUIRED"].includes(clinical) || !["APPROVED", "NOT_REQUIRED"].includes(marketing)) throw new Error(`cannot approve: clinical review is ${clinical}, marketing review is ${marketing}; both must be APPROVED`);
    if ((patch.equivalenceLevel ?? before.equivalenceLevel) === "NONE" || !(patch.equivalenceLevel ?? before.equivalenceLevel)) throw new Error("cannot approve a cross with no equivalence level");
  }
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
  if (typeof input.ownSku !== "string" || !input.ownSku.trim() || typeof input.competitorCode !== "string" || !input.competitorCode.trim() || typeof input.competitorName !== "string" || !input.competitorName.trim()) throw new Error("ownSku, competitorName and competitorCode are required");
  const MATCH_TYPES = ["Exact Match", "Close Match", "Alternative Match", "US Downsell Match", "No Match"];
  if (!MATCH_TYPES.includes(input.matchType)) throw new Error(`matchType must be one of ${MATCH_TYPES.join(", ")}`);
  if ((input.justification ?? "").length > 4000) throw new Error("justification is too long");
  const ownSku = input.ownSku.trim().toUpperCase();
  if (isPlaceholderSku(ownSku) || isPlaceholderSku(input.competitorCode)) throw new Error("ownSku and competitorCode must be catalog numbers");
  const own = await prisma.ownProduct.findFirst({ where: { sku: ownSku }, select: { id: true } });
  if (!own) throw new Error(`${input.ownSku} is not in our catalog`);
  const norm = normalizeCfn(input.competitorCode);
  const existing = await prisma.knownCross.findUnique({ where: { ownSku_competitorCodeNorm_source: { ownSku, competitorCodeNorm: norm, source: "rep" } } });
  // A cross that has entered review, or been approved, is only changed by reviewers (setReview):
  // a rep re-proposing it must not rewrite its tier under a signature.
  if (existing && !["DRAFT", "RETIRED", "REJECTED"].includes(existing.approvalStatus)) throw new Error(`${existing.competitorCode} → ${existing.ownSku} is already ${existing.approvalStatus.toLowerCase().replace(/_/g, " ")}; ask a reviewer to change it`);
  const row = existing
    ? await prisma.knownCross.update({ where: { id: existing.id }, data: { matchType: input.matchType, equivalenceLevel: equivalenceFromMatchType(input.matchType), justification: input.justification ?? undefined, isActive: true, ...(existing.approvalStatus !== "DRAFT" ? { approvalStatus: "DRAFT", clinicalReviewStatus: "PENDING", marketingReviewStatus: "PENDING" } : {}) } })
    : await prisma.knownCross.create({ data: { ownSku, ownDescription: input.ownDescription ?? null, category: input.category ?? null, competitorName: input.competitorName, competitorCode: input.competitorCode, competitorCodeNorm: norm, competitorDescription: input.competitorDescription ?? null, matchType: input.matchType, source: "rep", approvalStatus: "DRAFT", clinicalReviewStatus: "PENDING", marketingReviewStatus: "PENDING", equivalenceLevel: equivalenceFromMatchType(input.matchType), justification: input.justification ?? null, accountId: input.accountId ?? null, createdByUserId: actorUserId } });
  await audit({ actorUserId, entityType: "KnownCross", entityId: row.id, action: "PROPOSED_BY_REP", after: { ownSku: row.ownSku, competitorCode: row.competitorCode, matchType: row.matchType } });
  { const { notifyCrossProposed } = await import("@/lib/notifications"); await notifyCrossProposed(row.id).catch(() => undefined); }
  return row;
}

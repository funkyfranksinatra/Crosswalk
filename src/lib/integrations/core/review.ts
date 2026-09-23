/**
 * The review queue: records an integration will not decide about on its own. One OPEN item
 * per dedupe key; resolving records who, when and how. Resolution actions are applied by the
 * owning integration's `resolveReviewItem` handler (link an account, accept a price…).
 */
import { prisma } from "@/lib/db";
import type { IntegrationKey } from "./config";

export const REVIEW_KINDS = ["UNMATCHED_ACCOUNT", "MEMBERSHIP_CONFLICT", "DUPLICATE", "LOW_CONFIDENCE_EXTRACTION", "PRICE_EXCEPTION", "UNKNOWN_COMPETITOR", "MAPPING_ERROR", "OVERLAP"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type NewReviewItem = { kind: ReviewKind; summary: string; payload: unknown; suggestion?: unknown; externalId?: string | null; dedupeKey?: string | null; syncJobId?: string | null };

export async function queueReview(k: IntegrationKey, item: NewReviewItem): Promise<{ id: string; created: boolean }> {
  if (item.dedupeKey) {
    const open = await prisma.integrationReviewItem.findFirst({ where: { integrationKey: k, dedupeKey: item.dedupeKey, status: "OPEN" }, select: { id: true } });
    if (open) { await prisma.integrationReviewItem.update({ where: { id: open.id }, data: { summary: item.summary.slice(0, 500), payloadJson: JSON.stringify(item.payload).slice(0, 20_000), suggestionJson: item.suggestion ? JSON.stringify(item.suggestion).slice(0, 20_000) : null, syncJobId: item.syncJobId ?? undefined } }); return { id: open.id, created: false }; }
  }
  const row = await prisma.integrationReviewItem.create({ data: { integrationKey: k, kind: item.kind, summary: item.summary.slice(0, 500), payloadJson: JSON.stringify(item.payload).slice(0, 20_000), suggestionJson: item.suggestion ? JSON.stringify(item.suggestion).slice(0, 20_000) : null, externalId: item.externalId ?? null, dedupeKey: item.dedupeKey ?? null, syncJobId: item.syncJobId ?? null } });
  return { id: row.id, created: true };
}

export async function resolveReview(id: string, resolution: "LINKED" | "ACCEPTED" | "DISMISSED" | "CORRECTED", actorUserId: string, details: unknown = null): Promise<void> {
  await prisma.integrationReviewItem.update({ where: { id }, data: { status: resolution === "DISMISSED" ? "DISMISSED" : "RESOLVED", resolution, resolutionJson: details ? JSON.stringify(details).slice(0, 20_000) : null, resolvedByUserId: actorUserId, resolvedAt: new Date() } });
}

export async function openReviewCount(k?: IntegrationKey): Promise<number> {
  return prisma.integrationReviewItem.count({ where: { status: "OPEN", ...(k ? { integrationKey: k } : {}) } });
}

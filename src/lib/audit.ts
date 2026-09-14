/**
 * Audit trail. Every commercially significant change writes one event with
 * before/after snapshots and the context needed to reconstruct the decision
 * (recommendation, floor, margin, policy version at the time).
 */
import { prisma } from "@/lib/db";

export type AuditInput = {
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  context?: unknown;
};

export async function audit(e: AuditInput) {
  return prisma.auditEvent.create({
    data: {
      actorUserId: e.actorUserId ?? null,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      beforeJson: e.before === undefined ? null : JSON.stringify(e.before),
      afterJson: e.after === undefined ? null : JSON.stringify(e.after),
      reason: e.reason ?? null,
      contextJson: e.context === undefined ? null : JSON.stringify(e.context),
    },
  });
}

export async function auditTrail(entityType: string, entityId: string, limit = 100) {
  return prisma.auditEvent.findMany({ where: { entityType, entityId }, orderBy: { at: "desc" }, take: limit });
}

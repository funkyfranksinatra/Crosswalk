import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { redactAuditEvent, AuthError } from "@/lib/auth";
import { scopeFor, assertAccountVisible, assertRequestVisible, assertProposalVisible, assertContractVisible } from "@/lib/auth/scope";

/**
 * Audit trail. Unscoped roles may read any entity's events (or the latest 200 overall). A
 * scoped role (rep, regional manager) must name an account, request, proposal or contract in
 * their book of business — anything else is a 404, like the entity itself would be.
 */
export async function GET(req: Request) {
  const u = new URL(req.url); const entityType = u.searchParams.get("entityType"); const entityId = u.searchParams.get("entityId");
  return handle("view_pricing", async (actor) => {
    if ((await scopeFor(actor)).mode === "scoped") {
      if (!entityType || !entityId) throw new AuthError("not found", 404);
      const check = { Account: assertAccountVisible, Request: assertRequestVisible, Proposal: assertProposalVisible, Contract: assertContractVisible }[entityType];
      if (!check) throw new AuthError("not found", 404);
      await check(actor, entityId);
    }
    return (await prisma.auditEvent.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { at: "desc" }, take: 200 })).map((e) => redactAuditEvent(actor, e));
  });
}

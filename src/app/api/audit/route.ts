import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { redactAuditEvent } from "@/lib/auth";
export async function GET(req: Request) {
  const u = new URL(req.url); const entityType = u.searchParams.get("entityType"); const entityId = u.searchParams.get("entityId");
  return handle("view_pricing", async (actor) => (await prisma.auditEvent.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { at: "desc" }, take: 200 })).map((e) => redactAuditEvent(actor, e)));
}

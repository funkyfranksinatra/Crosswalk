import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
export async function GET(req: Request) {
  const u = new URL(req.url); const entityType = u.searchParams.get("entityType"); const entityId = u.searchParams.get("entityId");
  return handle("view_pricing", async () => prisma.auditEvent.findMany({ where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { at: "desc" }, take: 200 }));
}

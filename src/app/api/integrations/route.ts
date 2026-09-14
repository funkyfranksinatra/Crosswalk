import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { integrationStatus } from "@/lib/integrations/sync";
export async function GET() {
  return handle("view_pricing", async () => ({ status: integrationStatus(), recent: await prisma.syncLog.findMany({ orderBy: { at: "desc" }, take: 50 }), counts: await prisma.syncLog.groupBy({ by: ["system", "status"], _count: { _all: true } }) }));
}

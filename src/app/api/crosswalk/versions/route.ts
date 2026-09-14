import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
export async function GET() {
  return handle("view_pricing", async () => {
    const versions = await prisma.crosswalkVersion.findMany({ orderBy: { number: "desc" }, include: { _count: { select: { entries: true, proposals: true } } } });
    const pending = await prisma.knownCross.groupBy({ by: ["approvalStatus"], _count: { _all: true } });
    return { versions, byStatus: pending };
  });
}

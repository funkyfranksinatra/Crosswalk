import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { CROSSWALK_READ } from "@/lib/auth/permissions";

/** Version list for the governance panel: same readers as GET /api/crosses; counts and statuses only, no prices. */
export async function GET() {
  return handle(CROSSWALK_READ, async () => {
    const versions = await prisma.crosswalkVersion.findMany({ orderBy: { number: "desc" }, include: { _count: { select: { entries: true, proposals: true } } } });
    const pending = await prisma.knownCross.groupBy({ by: ["approvalStatus"], _count: { _all: true } });
    return { versions, byStatus: pending };
  });
}

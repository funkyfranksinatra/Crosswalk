import { handle } from "@/lib/api";
import { prisma } from "@/lib/db";
import { cancelRun } from "@/lib/pipeline/run";
import { audit } from "@/lib/audit";

/** Stop a queued or running cross-reference. A running one stops at its next checkpoint. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("run_cross_reference", async (actor) => {
    const r = await prisma.request.findUnique({ where: { id }, select: { id: true } });
    if (!r) throw new Error("Request not found");
    const res = await cancelRun(id);
    await audit({ actorUserId: actor.id, entityType: "Request", entityId: id, action: "RUN_CANCEL_REQUESTED", after: res });
    return res;
  });
}

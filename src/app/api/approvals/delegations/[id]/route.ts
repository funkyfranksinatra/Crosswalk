import { handle } from "@/lib/api";
import { prisma } from "@/lib/db";
import { revokeDelegation } from "@/lib/approvals/delegation";

/**
 * Revoke an out-of-office delegation. Any signed-in approver-side user may call it, so the
 * ownership rule lives here as well as in the service: only the delegating user or an ADMIN.
 * A delegation that is not yours reads as "not found" — the id must not reveal who delegated.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => {
    const row = await prisma.approvalDelegation.findUnique({ where: { id }, select: { fromUserId: true } });
    if (!row || (row.fromUserId !== actor.id && !actor.roles.includes("ADMIN"))) throw new Error("Delegation not found");
    return revokeDelegation(actor, id);
  });
}

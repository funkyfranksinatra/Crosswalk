import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { listDelegations, createDelegation } from "@/lib/approvals/delegation";

/** Out-of-office delegations: mine (given and received), or all for an admin (?all=1). */
export async function GET(req: Request) {
  const all = new URL(req.url).searchParams.get("all") === "1";
  return handle("view_pricing", async (actor) => {
    const [delegations, users] = await Promise.all([
      listDelegations(actor, { all }),
      prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true, roles: { select: { role: true } } }, orderBy: { name: "asc" } }),
    ]);
    const admin = actor.roles.includes("ADMIN");
    const canDelegate = actor.permissions.has("approve_discount") || admin;
    // The directory is only for choosing a delegate; non-admins see approvers by name, never emails.
    return { delegations, users: canDelegate ? users.map((u) => ({ id: u.id, name: u.name, email: admin ? u.email : null, roles: u.roles.map((r) => r.role) })) : [], me: actor.id, admin };
  });
}

export async function POST(req: Request) {
  return handle("approve_discount", async (actor) => {
    const b = await body<{ fromUserId?: string | null; toUserId: string; startsAt?: string | null; endsAt: string; reason?: string | null }>(req);
    return createDelegation(actor, b);
  });
}

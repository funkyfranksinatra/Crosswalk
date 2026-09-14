import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { createFromRequest } from "@/lib/proposals/service";

export async function GET() {
  return handle("view_pricing", async () => prisma.proposal.findMany({ orderBy: { createdAt: "desc" }, include: { account: true, _count: { select: { lines: true, approvals: { where: { status: "PENDING" } } } } }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("edit_proposed_pricing", async (actor) => {
    const b = await body<{ requestId: string; accountId?: string; opportunityId?: string; objectives?: string; validDays?: number }>(req);
    let accountId = b.accountId;
    if (!accountId) {
      const r = await prisma.request.findUniqueOrThrow({ where: { id: b.requestId } });
      if (r.accountId) accountId = r.accountId;
      else if (r.accountNumber) { const acc = await prisma.account.upsert({ where: { accountNumber: r.accountNumber }, create: { accountNumber: r.accountNumber, name: r.accountName ?? r.accountNumber, type: "SOLD_TO" }, update: {} }); await prisma.request.update({ where: { id: r.id }, data: { accountId: acc.id } }); accountId = acc.id; }
      else throw new Error("Choose an account for this proposal");
    }
    return createFromRequest(actor, b.requestId, { accountId, opportunityId: b.opportunityId ?? null, objectives: b.objectives ?? null, validDays: b.validDays });
  });
}

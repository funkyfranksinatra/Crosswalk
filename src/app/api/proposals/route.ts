import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { createFromRequest } from "@/lib/proposals/service";
import { scopeFor, proposalWhere, assertAccountWritable, assertRequestVisible } from "@/lib/auth/scope";

export async function GET() {
  return handle("view_pricing", async (actor) => prisma.proposal.findMany({ where: proposalWhere(await scopeFor(actor)), orderBy: { createdAt: "desc" }, include: { account: true, _count: { select: { lines: true, approvals: { where: { status: "PENDING" } } } } }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("edit_proposed_pricing", async (actor) => {
    const b = await body<{ requestId: string; accountId?: string; opportunityId?: string; objectives?: string; validDays?: number }>(req);
    if (typeof b.requestId !== "string" || !b.requestId) throw new Error("requestId is required");
    await assertRequestVisible(actor, b.requestId);
    if (b.accountId) await assertAccountWritable(actor, b.accountId);
    if (b.validDays !== undefined && (!Number.isInteger(b.validDays) || b.validDays < 1 || b.validDays > 365)) throw new Error("validDays must be a whole number of days between 1 and 365");
    if (b.objectives !== undefined && b.objectives !== null && (typeof b.objectives !== "string" || b.objectives.length > 4000)) throw new Error("objectives must be text (max 4000 characters)");
    if (b.opportunityId && !(await prisma.opportunity.findUnique({ where: { id: String(b.opportunityId) }, select: { id: true } }))) throw new Error("unknown opportunityId");
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

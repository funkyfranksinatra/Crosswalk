import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { proposeCross } from "@/lib/xref/governance";
export async function GET(req: Request) {
  const u = new URL(req.url); const status = u.searchParams.get("status"); const q = u.searchParams.get("q") ?? "";
  return handle("view_pricing", async () => prisma.knownCross.findMany({ where: { ...(status ? { approvalStatus: status } : {}), ...(q ? { OR: [{ ownSku: { contains: q, mode: "insensitive" } }, { competitorCode: { contains: q, mode: "insensitive" } }, { competitorName: { contains: q, mode: "insensitive" } }] } : {}) }, orderBy: { updatedAt: "desc" }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("run_cross_reference", async (actor) => proposeCross(actor.id, await body<Parameters<typeof proposeCross>[1]>(req)));
}

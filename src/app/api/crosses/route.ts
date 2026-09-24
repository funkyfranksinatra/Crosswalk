import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { proposeCross } from "@/lib/xref/governance";
import { CROSSWALK_READ } from "@/lib/auth/permissions";

/**
 * The governance queue is read by pricing roles AND by the reviewers who hold no pricing
 * permission (CLINICAL_REVIEWER: manage_crosswalk + review_crosswalk_clinical) — any of
 * CROSSWALK_READ. KnownCross rows carry no price, cost or margin fields (only codes,
 * descriptions, review state and evidence), so the payload is the same for every caller.
 */

export async function GET(req: Request) {
  const u = new URL(req.url); const status = u.searchParams.get("status"); const q = (u.searchParams.get("q") ?? "").slice(0, 200);
  return handle(CROSSWALK_READ, async () => prisma.knownCross.findMany({ where: { ...(status ? { approvalStatus: status } : {}), ...(q ? { OR: [{ ownSku: { contains: q, mode: "insensitive" } }, { competitorCode: { contains: q, mode: "insensitive" } }, { competitorName: { contains: q, mode: "insensitive" } }] } : {}) }, orderBy: { updatedAt: "desc" }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("run_cross_reference", async (actor) => proposeCross(actor.id, await body<Parameters<typeof proposeCross>[1]>(req)));
}

import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { proposeCross } from "@/lib/xref/governance";
import { openConflicts } from "@/lib/xref/conflicts";
import { CROSSWALK_READ } from "@/lib/auth/permissions";

/**
 * The governance queue is read by pricing roles AND by the reviewers who hold no pricing
 * permission (CLINICAL_REVIEWER: manage_crosswalk + review_crosswalk_clinical) — any of
 * CROSSWALK_READ. KnownCross rows carry no price, cost or margin fields (only codes,
 * descriptions, review state and evidence), so the payload is the same for every caller.
 */

export async function GET(req: Request) {
  const u = new URL(req.url); const status = u.searchParams.get("status"); const q = (u.searchParams.get("q") ?? "").slice(0, 200);
  // ?conflicts=open — curated rows a run's product evidence contradicted, awaiting a decision.
  if (u.searchParams.get("conflicts") === "open") return handle(CROSSWALK_READ, async () => openConflicts());
  return handle(CROSSWALK_READ, async () => prisma.knownCross.findMany({ where: { ...(status ? { approvalStatus: status } : {}), ...(q ? { OR: [{ ownSku: { contains: q, mode: "insensitive" } }, { competitorCode: { contains: q, mode: "insensitive" } }, { competitorName: { contains: q, mode: "insensitive" } }] } : {}) }, orderBy: { updatedAt: "desc" }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("run_cross_reference", async (actor) => proposeCross(actor.id, await body<Parameters<typeof proposeCross>[1]>(req)));
}

import { handle, body, date } from "@/lib/api";
import { setReview } from "@/lib/xref/governance";
import { can } from "@/lib/auth";
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_crosswalk", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    if ("clinicalReviewStatus" in b && !can(actor, "review_crosswalk_clinical") && !actor.roles.includes("ADMIN")) throw new Error("Clinical review requires a clinical reviewer");
    return setReview(actor.id, id, { approvalStatus: b.approvalStatus as string | undefined, clinicalReviewStatus: b.clinicalReviewStatus as string | undefined, marketingReviewStatus: b.marketingReviewStatus as string | undefined, equivalenceLevel: b.equivalenceLevel as string | undefined, approvedUsage: b.approvedUsage as string | undefined, justification: b.justification as string | undefined, effectiveFrom: "effectiveFrom" in b ? date(b.effectiveFrom) : undefined, effectiveTo: "effectiveTo" in b ? date(b.effectiveTo) : undefined });
  });
}

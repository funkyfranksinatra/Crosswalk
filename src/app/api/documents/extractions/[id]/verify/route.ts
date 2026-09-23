import { handle, body } from "@/lib/api";
import { verifyExtraction } from "@/lib/integrations/documents/service";

/** Confirm / correct / reject fields; `finalize: true` marks the extraction VERIFIED. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle("verify_competitor_pricing", async (actor) => {
    const { id } = await ctx.params;
    const b = await body<{ decisions?: unknown; finalize?: unknown }>(req);
    const decisions = Array.isArray(b.decisions) ? b.decisions.filter((d): d is { fieldId: string; status: "VERIFIED" | "CORRECTED" | "REJECTED"; correctedValue?: string | null } => Boolean(d) && typeof d === "object" && typeof (d as { fieldId?: unknown }).fieldId === "string" && ["VERIFIED", "CORRECTED", "REJECTED"].includes(String((d as { status?: unknown }).status))).map((d) => ({ fieldId: d.fieldId, status: d.status, correctedValue: typeof d.correctedValue === "string" ? d.correctedValue.slice(0, 2000) : null })) : [];
    return verifyExtraction(id, actor.id, decisions, b.finalize === true);
  });
}

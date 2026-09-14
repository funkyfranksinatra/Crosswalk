import { handle, body, num, str } from "@/lib/api";
import { rerecommendLine } from "@/lib/proposals/service";
import type { Strategy } from "@/lib/pricing/policy-model";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { lineId } = await params;
  return handle("edit_proposed_pricing", async (actor) => {
    const b = await body<{ strategy?: Strategy; adjustmentPct?: number; adjustmentAmount?: number; justification?: string; apply?: boolean }>(req);
    return rerecommendLine(actor, lineId, { strategy: b.strategy ?? null, adjustmentPct: num(b.adjustmentPct), adjustmentAmount: num(b.adjustmentAmount), justification: str(b.justification), apply: Boolean(b.apply) });
  });
}

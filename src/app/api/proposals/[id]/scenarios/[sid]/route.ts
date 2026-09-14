import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { money } from "@/lib/money";
import { scenarioEconomics, setScenarioPrice } from "@/lib/proposals/service";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { sid } = await params;
  return handle("view_pricing", async () => scenarioEconomics(sid));
}
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { sid } = await params;
  return handle("edit_proposed_pricing", async (actor) => { const b = await body<{ lineId: string; proposedPrice?: string | number | null; included?: boolean }>(req); await setScenarioPrice(actor, sid, b.lineId, b.proposedPrice == null || b.proposedPrice === "" ? null : money(b.proposedPrice as never), b.included); return scenarioEconomics(sid); });
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { sid } = await params;
  return handle("edit_proposed_pricing", async () => { await prisma.scenario.delete({ where: { id: sid } }); });
}

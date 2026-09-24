import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { redactJsonForActor } from "@/lib/auth";
import { money } from "@/lib/money";
import { scenarioEconomics, setScenarioPrice } from "@/lib/proposals/service";
async function scoped(id: string, sid: string) {
  const s = await prisma.scenario.findFirst({ where: { id: sid, proposalId: id }, select: { id: true } });
  if (!s) throw new Error("scenario not found on this proposal");
}
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params;
  return handle("view_pricing", async (actor) => { await scoped(id, sid); return redactJsonForActor(actor, await scenarioEconomics(sid)); });
}
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params;
  return handle("edit_proposed_pricing", async (actor) => {
    await scoped(id, sid);
    const b = await body<{ lineId: string; proposedPrice?: string | number | null; included?: boolean }>(req);
    const clear = b.proposedPrice == null || b.proposedPrice === "";
    const price = clear ? null : money(b.proposedPrice as never);
    if (!clear && price === null) throw new Error("proposedPrice is not a number");
    if (price !== null && price.lte(0)) throw new Error("price must be positive");
    await setScenarioPrice(actor, sid, b.lineId, price, b.included);
    return redactJsonForActor(actor, await scenarioEconomics(sid));
  });
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params;
  return handle("edit_proposed_pricing", async () => { await scoped(id, sid); await prisma.scenario.delete({ where: { id: sid } }); });
}

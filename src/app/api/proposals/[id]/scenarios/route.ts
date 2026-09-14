import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { createScenario, scenarioEconomics } from "@/lib/proposals/service";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async () => { const ss = await prisma.scenario.findMany({ where: { proposalId: id }, orderBy: { createdAt: "asc" } }); return Promise.all(ss.map((s) => scenarioEconomics(s.id))); });
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => { const b = await body<{ kind: string; name?: string }>(req); const s = await createScenario(actor, id, b.kind ?? "CUSTOM", b.name); return scenarioEconomics(s.id); });
}

import { prisma } from "@/lib/db";
import { handle, body, oneOf } from "@/lib/api";
import { redactJsonForActor } from "@/lib/auth";
import { createScenario, scenarioEconomics, SCENARIO_KINDS } from "@/lib/proposals/service";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Scenario economics carry COGS, gross profit and margin: redacted per role like the proposal itself.
  return handle("view_pricing", async (actor) => { const ss = await prisma.scenario.findMany({ where: { proposalId: id }, orderBy: { createdAt: "asc" } }); return redactJsonForActor(actor, await Promise.all(ss.map((s) => scenarioEconomics(s.id)))); });
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => { const b = await body<{ kind?: unknown; name?: string }>(req); const s = await createScenario(actor, id, oneOf(b.kind, SCENARIO_KINDS, "kind", "CUSTOM"), b.name); return redactJsonForActor(actor, await scenarioEconomics(s.id)); });
}

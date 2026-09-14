import { handle } from "@/lib/api";
import { activatePolicy } from "@/lib/pricing/policy";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("configure_pricing_rules", async (actor) => activatePolicy(actor.id, id));
}

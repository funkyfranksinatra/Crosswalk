import { handle } from "@/lib/api";
import { newVersion } from "@/lib/proposals/service";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => newVersion(actor, id));
}

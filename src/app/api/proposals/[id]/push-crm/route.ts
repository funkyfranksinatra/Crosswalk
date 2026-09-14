import { handle } from "@/lib/api";
import { pushQuote } from "@/lib/integrations/sync";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("export_proposals", async (actor) => pushQuote(actor.id, id));
}

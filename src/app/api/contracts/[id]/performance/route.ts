import { handle } from "@/lib/api";
import { contractPerformance } from "@/lib/compliance";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async () => contractPerformance(id));
}

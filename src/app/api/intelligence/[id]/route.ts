import { handle, body } from "@/lib/api";
import { verifyObservation } from "@/lib/intelligence";
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("verify_competitor_pricing", async (actor) => { const b = await body<{ status: "VERIFIED" | "DISPUTED" | "UNVERIFIED"; notes?: string }>(req); return verifyObservation(actor.id, id, b.status, b.notes); });
}

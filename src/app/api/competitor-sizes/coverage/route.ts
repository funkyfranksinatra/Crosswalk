import { handle } from "@/lib/api";
import { sizeCoverage } from "@/lib/catalog/size-coverage";

/** The competitor-size worklist: codes ranked by estimated spend, sized or not, and from where. */
export async function GET(req: Request) {
  return handle("manage_catalog", async () => {
    const url = new URL(req.url);
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
    return sizeCoverage({ limit });
  });
}

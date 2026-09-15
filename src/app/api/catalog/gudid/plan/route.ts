import { handle, body } from "@/lib/api";
import { planImport } from "@/lib/gudid/library";

/** Preview what an import would pull: totals, matching labeler names, product codes. */
export async function POST(req: Request) {
  return handle("manage_catalog", async () => {
    const b = await body<{ query?: string; inDistributionOnly?: boolean; productCodes?: string[] }>(req);
    const query = (b.query ?? "").trim();
    if (query.length < 3) throw new Error("Enter a labeler name of at least 3 characters");
    return planImport({ query, inDistributionOnly: b.inDistributionOnly !== false, productCodes: b.productCodes?.filter(Boolean) ?? null });
  });
}

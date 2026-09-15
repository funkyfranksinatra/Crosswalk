import { handle, body } from "@/lib/api";
import { libraryStats, startImport, type ImportKind } from "@/lib/gudid/library";
import type { Family } from "@/lib/match/bin";

/** Library status + recent imports (anyone signed in). */
export async function GET() {
  return handle(null, () => libraryStats());
}

/** Start a bulk import of a labeler's GUDID catalog. */
export async function POST(req: Request) {
  return handle("manage_catalog", async (actor) => {
    const b = await body<{ query?: string; kind?: ImportKind; addToOwnCatalog?: boolean; families?: Family[]; productCodes?: string[]; inDistributionOnly?: boolean }>(req);
    const query = (b.query ?? "").trim();
    if (query.length < 3) throw new Error("Enter a labeler name of at least 3 characters (as it appears in GUDID, e.g. Ethicon, Covidien, Applied Medical)");
    const job = await startImport({
      query,
      kind: b.kind === "OWN" ? "OWN" : "COMPETITOR",
      addToOwnCatalog: b.kind === "OWN" && b.addToOwnCatalog !== false,
      families: b.families?.length ? b.families : null,
      productCodes: b.productCodes?.map((c) => c.trim().toUpperCase()).filter(Boolean) ?? null,
      inDistributionOnly: b.inDistributionOnly !== false,
      startedById: actor.id,
    });
    return { job };
  });
}

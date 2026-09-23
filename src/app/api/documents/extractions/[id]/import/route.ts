import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { verifiedLinesGrid } from "@/lib/integrations/documents/service";
import { importObservationRows } from "@/lib/intelligence/import";

/** Import the VERIFIED lines as competitor price observations (source type by document type; extraction confidence is not used as commercial confidence). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle("import_competitor_pricing", async (actor) => {
    const { id } = await ctx.params;
    const x = await prisma.documentExtraction.findUnique({ where: { id }, select: { documentId: true, status: true } });
    if (!x) throw new Error("not found");
    if (x.status !== "VERIFIED") throw new Error("only verified extractions can be imported");
    const grid = await verifiedLinesGrid(id);
    if (grid.length < 2) throw new Error("no verified lines to import");
    return importObservationRows(actor.id, grid, x.documentId);
  });
}

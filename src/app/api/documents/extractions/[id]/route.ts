import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";

/** An extraction with its fields (for the review screen). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle("view_pricing", async () => {
    const { id } = await ctx.params;
    const x = await prisma.documentExtraction.findUnique({ where: { id }, include: { fields: { orderBy: [{ scope: "asc" }, { lineNo: "asc" }, { field: "asc" }] } } });
    if (!x) throw new Error("not found");
    const document = await prisma.document.findUnique({ where: { id: x.documentId }, select: { id: true, filename: true, kind: true, uploadedAt: true } });
    return { ...x, document, rawJson: undefined };
  });
}

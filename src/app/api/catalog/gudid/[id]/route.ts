import { handle } from "@/lib/api";
import { prisma } from "@/lib/db";
import { cancelImport } from "@/lib/gudid/library";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(null, async () => {
    const job = await prisma.gudidImport.findUnique({ where: { id }, include: { startedBy: { select: { name: true } } } });
    if (!job) throw new Error("Import not found");
    return { job };
  });
}

/** Cancel a running import (its rows stay; the run is marked CANCELLED). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("manage_catalog", async () => {
    const job = await prisma.gudidImport.findUnique({ where: { id } });
    if (!job) throw new Error("Import not found");
    if (!["QUEUED", "RUNNING"].includes(job.status)) throw new Error("Import is not running");
    cancelImport(id);
    return { ok: true };
  });
}

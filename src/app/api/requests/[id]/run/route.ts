import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueRun } from "@/lib/pipeline/run";
import { authorize } from "@/lib/api";

/** (Re)run a cross-reference. Queued, not executed here: the job survives a server restart. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { freshGrades?: unknown; useLlm?: unknown };
  const r = await prisma.request.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (["queued", "running"].includes(r.status)) return NextResponse.json({ ok: true, alreadyRunning: true });
  const { jobId, alreadyQueued } = await enqueueRun(id, { freshGrades: Boolean(body.freshGrades), useLlm: typeof body.useLlm === "boolean" ? body.useLlm : undefined });
  return NextResponse.json({ ok: true, jobId, alreadyRunning: alreadyQueued });
}

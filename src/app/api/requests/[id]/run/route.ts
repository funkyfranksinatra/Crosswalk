import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { startRun, isRunning } from "@/lib/pipeline/run";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const r = await prisma.request.findUnique({ where: { id } });
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (isRunning(id)) return NextResponse.json({ ok: true, alreadyRunning: true });
  const options = r.optionsJson ? JSON.parse(r.optionsJson) : {};
  await prisma.request.update({ where: { id }, data: { status: "queued", progress: 0, stage: "Queued", error: null, optionsJson: JSON.stringify({ ...options, freshGrades: Boolean(body.freshGrades) }), ...(typeof body.useLlm === "boolean" ? { useLlm: body.useLlm } : {}) } });
  startRun(id);
  return NextResponse.json({ ok: true });
}

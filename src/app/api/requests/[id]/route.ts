import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { summarizeLines } from "@/lib/requests";
import { llmConfig } from "@/lib/llm/client";
import { googleStatus } from "@/lib/sheets/google";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await prisma.request.findUnique({
    where: { id },
    include: {
      company: true,
      pricebook: true,
      lines: { orderBy: { lineNo: "asc" }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } },
    },
  });
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  let modelStatus: unknown = null;
  try { modelStatus = request.optionsJson ? (JSON.parse(request.optionsJson).model ?? null) : null; } catch {}
  return NextResponse.json({ ...request, summary: summarizeLines(request.lines), log: JSON.parse(request.logJson), llmAvailable: llmConfig().available, google: googleStatus(), modelStatus });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.request.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

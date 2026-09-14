import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Rep decisions on one line: pick a candidate, mark reviewed, note an override, set competitor price. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  const body = (await req.json()) as { selectedCandidateId?: string | null; reviewed?: boolean; overrideNote?: string | null; estCompetitorPrice?: number | null };
  const line = await prisma.requestLine.findFirst({ where: { id: lineId, requestId: id } });
  if (!line) return NextResponse.json({ error: "not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if ("selectedCandidateId" in body) {
    data.selectedCandidateId = body.selectedCandidateId;
    await prisma.matchCandidate.updateMany({ where: { lineId }, data: { isSelected: false } });
    if (body.selectedCandidateId) await prisma.matchCandidate.update({ where: { id: body.selectedCandidateId }, data: { isSelected: true } });
    data.matchStatus = body.selectedCandidateId ? "matched" : "no-match";
  }
  if ("reviewed" in body) data.reviewed = Boolean(body.reviewed);
  if ("overrideNote" in body) data.overrideNote = body.overrideNote;
  if ("estCompetitorPrice" in body) data.estCompetitorPrice = body.estCompetitorPrice;
  const updated = await prisma.requestLine.update({ where: { id: lineId }, data, include: { candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } }, competitorProduct: true } });
  return NextResponse.json(updated);
}

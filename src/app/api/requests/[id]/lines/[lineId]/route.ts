import { NextResponse } from "next/server";
import { plain } from "@/lib/serialize";
import { prisma } from "@/lib/db";
import { authorize } from "@/lib/api";
import { can } from "@/lib/auth";

/** Rep decisions on one line: pick a candidate, mark reviewed, note an override, set competitor price. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const body = (await req.json().catch(() => ({}))) as { selectedCandidateId?: string | null; reviewed?: boolean; overrideNote?: string | null; estCompetitorPrice?: number | null };
  const line = await prisma.requestLine.findFirst({ where: { id: lineId, requestId: id } });
  if (!line) return NextResponse.json({ error: "not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if ("selectedCandidateId" in body) {
    data.selectedCandidateId = body.selectedCandidateId;
    // The candidate must belong to this line — an id from another request must not be selectable.
    if (body.selectedCandidateId && !(await prisma.matchCandidate.findFirst({ where: { id: body.selectedCandidateId, lineId }, select: { id: true } }))) return NextResponse.json({ error: "candidate does not belong to this line" }, { status: 400 });
    await prisma.matchCandidate.updateMany({ where: { lineId }, data: { isSelected: false } });
    if (body.selectedCandidateId) await prisma.matchCandidate.update({ where: { id: body.selectedCandidateId }, data: { isSelected: true } });
    data.matchStatus = body.selectedCandidateId ? "matched" : "no-match";
  }
  if ("reviewed" in body) data.reviewed = Boolean(body.reviewed);
  if ("overrideNote" in body) data.overrideNote = body.overrideNote;
  if ("estCompetitorPrice" in body) {
    const v = body.estCompetitorPrice;
    if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e9)) return NextResponse.json({ error: "estCompetitorPrice must be a non-negative number" }, { status: 400 });
    data.estCompetitorPrice = v ?? null;
  }
  if ("overrideNote" in body && body.overrideNote != null && String(body.overrideNote).length > 2000) return NextResponse.json({ error: "overrideNote is too long" }, { status: 400 });
  const updated = await prisma.requestLine.update({ where: { id: lineId }, data, include: { candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } }, competitorProduct: true } });
  if (!can(actor, "view_cost") || !can(actor, "view_margin")) for (const c of updated.candidates) { if (!can(actor, "view_cost")) { c.ownProduct.cogs = null; c.scoreCogs = null; } if (!can(actor, "view_margin")) c.scoreMargin = null; }
  return NextResponse.json(plain(updated));
}

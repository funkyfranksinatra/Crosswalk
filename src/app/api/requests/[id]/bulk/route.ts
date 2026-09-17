import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorize } from "@/lib/api";
import { audit } from "@/lib/audit";
import { recordLineDecision } from "@/lib/xref/learning";

/**
 * Bulk actions on a cross-reference run (Tier 3.1). Each one is the same per-line change the
 * rep could make by hand — same learning-loop recording, same audit — applied to every line
 * the scope selects. Scopes are computed server-side from the run's current state so a stale
 * page cannot act on lines that changed.
 *
 *   review_exact       mark reviewed every line whose selected candidate is an Exact Match
 *   review_matched     mark reviewed every line with a selected (non-No-Match) candidate
 *   select_top         select the top-ranked candidate on lines that have candidates but no selection
 *   flag_verify        flag every line needing attention (unresolved, low-confidence resolution, no selection, or selected Alternative)
 *   clear_flags        remove the verify flag from every line
 *   unreview_all       clear the reviewed mark on every line
 */
const ACTIONS = ["review_exact", "review_matched", "select_top", "flag_verify", "clear_flags", "unreview_all"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const body = (await req.json().catch(() => ({}))) as { action?: string; lineIds?: string[] };
  const action = body.action as Action;
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
  const request = await prisma.request.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (["running", "queued"].includes(request.status)) return NextResponse.json({ error: "The run is in progress; wait for it to finish" }, { status: 409 });
  const only = Array.isArray(body.lineIds) && body.lineIds.length ? new Set(body.lineIds.map(String)) : null;
  const lines = await prisma.requestLine.findMany({ where: { requestId: id, ...(only ? { id: { in: [...only] } } : {}) }, include: { competitorProduct: { select: { resolution: true, confidence: true } }, candidates: { orderBy: { rank: "asc" }, select: { id: true, matchType: true, rank: true } } }, orderBy: { lineNo: "asc" } });
  const sel = (l: (typeof lines)[number]) => l.candidates.find((c) => c.id === l.selectedCandidateId) ?? null;
  let changed = 0;
  const touched: string[] = [];
  for (const l of lines) {
    const s = sel(l);
    switch (action) {
      case "review_exact":
      case "review_matched": {
        if (l.reviewed || !s || s.matchType === "No Match") break;
        if (action === "review_exact" && s.matchType !== "Exact Match") break;
        await prisma.requestLine.update({ where: { id: l.id }, data: { reviewed: true, flag: null } });
        await recordLineDecision(actor, l.id, { reviewed: true }).catch((e) => console.error("[learning]", e));
        changed++; touched.push(l.id); break;
      }
      case "select_top": {
        if (s) break;
        const top = l.candidates.find((c) => c.matchType !== "No Match");
        if (!top) break;
        await prisma.matchCandidate.updateMany({ where: { lineId: l.id }, data: { isSelected: false } });
        await prisma.matchCandidate.update({ where: { id: top.id }, data: { isSelected: true } });
        await prisma.requestLine.update({ where: { id: l.id }, data: { selectedCandidateId: top.id, matchStatus: "matched" } });
        await recordLineDecision(actor, l.id, { selectedCandidateId: top.id }).catch((e) => console.error("[learning]", e));
        changed++; touched.push(l.id); break;
      }
      case "flag_verify": {
        const cp = l.competitorProduct;
        const attention = !cp || cp.resolution === "not-found" || (cp.confidence ?? 1) < 0.75 || !s || s.matchType === "Alternative Match";
        if (!attention || l.flag === "verify") break;
        await prisma.requestLine.update({ where: { id: l.id }, data: { flag: "verify", reviewed: false } });
        changed++; touched.push(l.id); break;
      }
      case "clear_flags": {
        if (!l.flag) break;
        await prisma.requestLine.update({ where: { id: l.id }, data: { flag: null } });
        changed++; touched.push(l.id); break;
      }
      case "unreview_all": {
        if (!l.reviewed) break;
        await prisma.requestLine.update({ where: { id: l.id }, data: { reviewed: false } });
        changed++; touched.push(l.id); break;
      }
    }
  }
  await audit({ actorUserId: actor.id, entityType: "Request", entityId: id, action: `BULK_${action.toUpperCase()}`, after: { changed, scoped: only ? only.size : null, lines: touched.slice(0, 200) } });
  return NextResponse.json({ action, changed, considered: lines.length });
}

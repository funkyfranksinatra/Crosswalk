import { NextResponse } from "next/server";
import { authorize } from "@/lib/api";
import { prisma } from "@/lib/db";
import { redactRecord } from "@/lib/observability/redact";

export const dynamic = "force-dynamic";

/**
 * NDJSON export of the operational tables for a log/metrics stack that pulls rather than
 * tails stdout: model calls, cross-reference runs, integration syncs, feed runs, job
 * failures, alerts. `since` (ISO) and `limit` (≤ 10,000) bound the window. ADMIN only.
 */
export async function GET(req: Request) {
  const { actor, deny } = await authorize(null);
  if (deny) return deny;
  if (!actor.roles.includes("ADMIN")) return NextResponse.json({ error: "ADMIN only" }, { status: 403 });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "llm";
  const since = url.searchParams.get("since") ? new Date(url.searchParams.get("since")!) : new Date(Date.now() - 86_400_000);
  if (Number.isNaN(since.getTime())) return NextResponse.json({ error: "since must be an ISO date" }, { status: 400 });
  const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
  let rows: unknown[];
  switch (kind) {
    case "llm": rows = await prisma.llmCall.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, take: limit }); break;
    case "runs": rows = (await prisma.request.findMany({ where: { updatedAt: { gte: since } }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true, reference: true, status: true, stage: true, progress: true, error: true, attempt: true, checkpoint: true, startedAt: true, completedAt: true, updatedAt: true, logJson: true, _count: { select: { lines: true } } } })).map((r) => { let log: unknown = []; try { log = JSON.parse(r.logJson); } catch { log = [{ m: "(log unreadable)" }]; } return { ...r, lines: r._count.lines, _count: undefined, log, logJson: undefined }; }); break;
    case "sync": rows = await prisma.syncLog.findMany({ where: { at: { gte: since } }, orderBy: { at: "asc" }, take: limit }); break;
    case "feeds": rows = await prisma.feedRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "asc" }, take: limit }); break;
    case "alerts": rows = await prisma.alert.findMany({ where: { lastFiredAt: { gte: since } }, orderBy: { lastFiredAt: "asc" }, take: limit }); break;
    case "jobs": { const { recentFailures } = await import("@/lib/jobs/boss"); rows = await recentFailures(limit); break; }
    default: return NextResponse.json({ error: "kind must be llm, runs, sync, feeds, alerts or jobs" }, { status: 400 });
  }
  const body = rows.map((r) => JSON.stringify(redactRecord(r as Record<string, unknown>), (_k, v) => (typeof v === "bigint" ? Number(v) : v))).join("\n") + (rows.length ? "\n" : "");
  return new NextResponse(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="crosswalk-${kind}-${since.toISOString().slice(0, 10)}.ndjson"` } });
}

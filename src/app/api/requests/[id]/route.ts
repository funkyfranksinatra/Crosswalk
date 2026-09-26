import { NextResponse } from "next/server";
import { plain } from "@/lib/serialize";
import { prisma } from "@/lib/db";
import { summarizeLines } from "@/lib/requests";
import { llmConfig } from "@/lib/ai/gateway";
import { googleStatus } from "@/lib/sheets/google";
import { authorize } from "@/lib/api";
import { redactCandidateForActor } from "@/lib/auth";
import { audit } from "@/lib/audit";

const safeLog = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return [{ m: "(log unreadable)" }]; } };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
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
  // Cost and margin never leave the server for roles without the permission — candidates carry
  // the SKU's COGS and the cost/margin fit scores.
  for (const l of request.lines) for (const c of l.candidates) redactCandidateForActor(actor, c);
  return NextResponse.json(plain({ ...request, summary: summarizeLines(request.lines), log: safeLog(request.logJson), llmAvailable: llmConfig().available, google: googleStatus(), modelStatus }));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const request = await prisma.request.findUnique({ where: { id }, include: { _count: { select: { proposals: true } } } });
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A proposal is a commercial artefact built on this cross-reference; the request must outlive it.
  if (request._count.proposals > 0) return NextResponse.json({ error: `This request has ${request._count.proposals} proposal${request._count.proposals === 1 ? "" : "s"} built on it and cannot be deleted` }, { status: 409 });
  await prisma.request.delete({ where: { id } });
  await audit({ actorUserId: actor.id, entityType: "Request", entityId: id, action: "DELETE", before: { reference: request.reference, accountNumber: request.accountNumber, sourceFileName: request.sourceFileName } });
  return NextResponse.json({ ok: true });
}

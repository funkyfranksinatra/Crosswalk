import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseIntakeAny } from "@/lib/excel/intake";
import { SheetAccessError } from "@/lib/sheets/google";
import { getCompany } from "@/lib/settings";
import { nextReference } from "@/lib/requests";
import { startRun } from "@/lib/pipeline/run";
import { authorize } from "@/lib/api";

export async function GET() {
  const { deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const requests = await prisma.request.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { lines: true } }, pricebook: true } });
  return NextResponse.json(requests);
}

export async function POST(req: Request) {
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const form = await req.formData();
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "");
  const csvText = String(form.get("csvText") ?? "");
  const csvName = String(form.get("csvName") ?? "");
  let intake;
  try {
    intake = await parseIntakeAny({ file: file instanceof File ? file : null, sheetUrl, csvText, csvName });
  } catch (e) {
    if (e instanceof SheetAccessError) return NextResponse.json({ error: e.message, hint: e.hint }, { status: 400 });
    return NextResponse.json({ error: `Could not read the intake: ${e instanceof Error ? e.message : e}` }, { status: 400 });
  }
  if (intake.lines.length === 0) return NextResponse.json({ error: "No catalog numbers found in the first sheet" }, { status: 400 });

  const company = await getCompany();
  const pricebookId = String(form.get("pricebookId") ?? "") || null;
  const request = await prisma.request.create({
    data: {
      companyId: company.id,
      reference: await nextReference(),
      accountNumber: String(form.get("accountNumber") ?? "") || null,
      accountName: String(form.get("accountName") ?? "") || null,
      accountType: String(form.get("accountType") ?? "Sold-To"),
      reportType: String(form.get("reportType") ?? "Competitive Cross Reference with Pricebook"),
      pricebookId,
      sourceFileName: intake.source.kind === "google-sheet" ? `${intake.source.name} (Google Sheet)` : intake.source.name,
      sourceUrl: intake.source.url ?? null,
      useLlm: form.get("useLlm") !== "false",
      createdBy: actor.name,
      status: "queued",
      lines: { create: intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estCompetitorPrice: l.estPrice })) },
    },
  });
  startRun(request.id);
  return NextResponse.json({ id: request.id, reference: request.reference, lines: intake.lines.length, skipped: intake.skipped.length, duplicatesMerged: intake.duplicatesMerged });
}

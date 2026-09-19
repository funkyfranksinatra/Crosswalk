import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseIntakeAny } from "@/lib/excel/intake";
import { SheetAccessError } from "@/lib/sheets/google";
import { getCompany } from "@/lib/settings";
import { nextReference } from "@/lib/requests";
import { enqueueRun } from "@/lib/pipeline/run";
import { authorize } from "@/lib/api";
import { scopeFor, requestWhere, assertAccountWritable } from "@/lib/auth/scope";

export async function GET() {
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const requests = await prisma.request.findMany({ where: { AND: [requestWhere(await scopeFor(actor)), { NOT: { reference: { startsWith: "BENCH-" } } }] }, orderBy: { createdAt: "desc" }, include: { _count: { select: { lines: true } }, pricebook: true } });
  return NextResponse.json(requests);
}

export async function POST(req: Request) {
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const form = await req.formData();
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "");
  const csvText = String(form.get("csvText") ?? "");
  if (file instanceof File && file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File is larger than 20 MB" }, { status: 400 });
  if (csvText.length > 5 * 1024 * 1024) return NextResponse.json({ error: "Pasted text is larger than 5 MB" }, { status: 400 });
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
  if (pricebookId && !(await prisma.pricebook.findUnique({ where: { id: pricebookId }, select: { id: true } }))) return NextResponse.json({ error: "unknown pricebook" }, { status: 400 });
  const text = (k: string, max: number) => { const v = String(form.get(k) ?? "").trim(); return v.length > max ? v.slice(0, max) : v || null; };
  for (const [k, max] of [["accountNumber", 40], ["accountName", 200], ["accountType", 40], ["reportType", 120]] as const) if (String(form.get(k) ?? "").length > max) return NextResponse.json({ error: `${k} is too long (max ${max})` }, { status: 400 });
  if (intake.lines.length > 5000) return NextResponse.json({ error: `The intake has ${intake.lines.length} lines; the limit is 5,000 per request` }, { status: 400 });
  // Ownership scoping: an account number that names an existing account must be one the actor may see.
  const accNo = text("accountNumber", 40);
  const known = accNo ? await prisma.account.findUnique({ where: { accountNumber: accNo }, select: { id: true } }) : null;
  if (known) { try { await assertAccountWritable(actor, known.id); } catch { return NextResponse.json({ error: "That account is not in your book of business" }, { status: 403 }); } }
  const request = await prisma.request.create({
    data: {
      companyId: company.id,
      reference: await nextReference(),
      accountNumber: text("accountNumber", 40),
      accountName: text("accountName", 200),
      accountType: text("accountType", 40) ?? "Sold-To",
      accountId: known?.id ?? null,
      reportType: text("reportType", 120) ?? "Competitive Cross Reference with Pricebook",
      pricebookId,
      sourceFileName: intake.source.kind === "google-sheet" ? `${intake.source.name} (Google Sheet)` : intake.source.name,
      sourceUrl: intake.source.url ?? null,
      useLlm: form.get("useLlm") !== "false",
      createdBy: actor.name,
      createdByUserId: actor.id,
      status: "queued",
      lines: { create: intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estCompetitorPrice: l.estPrice })) },
    },
  });
  let jobId: string | null = null;
  try {
    ({ jobId } = await enqueueRun(request.id));
  } catch (e) {
    // The request is kept (marked failed with the reason) so the upload is not lost; the client gets a 503.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), id: request.id, reference: request.reference }, { status: 503 });
  }
  return NextResponse.json({ id: request.id, reference: request.reference, jobId, lines: intake.lines.length, skipped: intake.skipped.length, duplicatesMerged: intake.duplicatesMerged });
}

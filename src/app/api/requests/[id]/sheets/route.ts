import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildCrossReferenceWorkbook, buildContractOfferWorkbook } from "@/lib/excel/export";
import { googleStatus, uploadXlsxAsGoogleSheet } from "@/lib/sheets/google";

/** Write both exports into the configured Google Drive folder as native Google Sheets. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const status = googleStatus();
  if (!status.canWrite) return NextResponse.json({ error: "Google Drive write-back is not configured", status }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const which: ("xref" | "offer")[] = body.which ?? ["xref", "offer"];
  const anyoneWithLink = Boolean(body.anyoneWithLink);
  const out: Record<string, string> = {};
  try {
    if (which.includes("xref")) {
      const x = await buildCrossReferenceWorkbook(id);
      out.xrefSheetUrl = (await uploadXlsxAsGoogleSheet(x.buffer, x.filename, { anyoneWithLink })).url;
    }
    if (which.includes("offer")) {
      const o = await buildContractOfferWorkbook(id);
      out.offerSheetUrl = (await uploadXlsxAsGoogleSheet(o.buffer, o.filename, { anyoneWithLink })).url;
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const updated = await prisma.request.update({ where: { id }, data: out, select: { xrefSheetUrl: true, offerSheetUrl: true } });
  return NextResponse.json(updated);
}

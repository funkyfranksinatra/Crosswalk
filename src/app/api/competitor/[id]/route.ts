import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { lookupByDi, summarizeRecord, displayManufacturer } from "@/lib/gudid/openfda";
import { authorize } from "@/lib/api";

/** Manual correction of a competitor product: pick one of the alternates (by GUDID DI) or type a description. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const body = (await req.json().catch(() => ({}))) as { di?: string; manufacturer?: string; description?: string };
  if ((body.manufacturer && body.manufacturer.length > 200) || (body.description && body.description.length > 2000)) return NextResponse.json({ error: "text too long" }, { status: 400 });
  const cp = await prisma.competitorProduct.findUnique({ where: { id } });
  if (!cp) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (body.di) {
    const rec = await lookupByDi(body.di);
    if (!rec) return NextResponse.json({ error: "DI not found in GUDID" }, { status: 404 });
    const s = summarizeRecord(rec);
    const updated = await prisma.competitorProduct.update({
      where: { id },
      data: { manufacturer: displayManufacturer(s.manufacturer), labeler: s.manufacturer, brand: s.brand, description: s.description, gudidDi: s.gudidDi, gmdnName: s.gmdnName, gmdnCode: s.gmdnCode, fdaProductCode: s.fdaProductCode, status: s.status, gudidJson: JSON.stringify(rec), resolution: "manual", resolutionNote: "Chosen by rep from GUDID alternates", confidence: 1, binJson: null, binSource: null },
    });
    return NextResponse.json(updated);
  }
  const updated = await prisma.competitorProduct.update({
    where: { id },
    data: { manufacturer: body.manufacturer ?? cp.manufacturer, description: body.description ?? cp.description, resolution: "manual", resolutionNote: "Entered by rep", confidence: 1, binJson: null, binSource: null },
  });
  return NextResponse.json(updated);
}

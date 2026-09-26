import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { lookupByDi, summarizeRecord, displayManufacturer } from "@/lib/gudid/openfda";
import { authorize } from "@/lib/api";
import { audit } from "@/lib/audit";
import { can, type Actor } from "@/lib/auth";
import { scopeFor, requestWhere } from "@/lib/auth/scope";

/**
 * Who may correct a competitor product (docs/DATA_ACCESS_POLICY.md "Shared competitor cache"):
 * the cache row is shared by every request that resolved the same code, so a correction is
 * visible company-wide. manage_catalog (marketing, analysts, contracting, admin) may correct
 * any row; a run_cross_reference user may correct a row only when one of the requests they can
 * see (ownership scope) has a line resolved to it — otherwise the row does not exist for them
 * (404, never 403: the id must not enumerate the cache).
 */
async function assertCorrectable(actor: Actor, competitorProductId: string): Promise<boolean> {
  if (can(actor, "manage_catalog")) return true;
  const scope = await scopeFor(actor);
  const line = await prisma.requestLine.findFirst({ where: { competitorProductId, request: requestWhere(scope) }, select: { id: true } });
  return Boolean(line);
}

/** Manual correction of a competitor product: pick one of the alternates (by GUDID DI) or type a description. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, deny } = await authorize(["manage_catalog", "run_cross_reference"]);
  if (deny) return deny;
  const body = (await req.json().catch(() => ({}))) as { di?: unknown; manufacturer?: unknown; description?: unknown };
  for (const k of ["di", "manufacturer", "description"] as const) if (body[k] !== undefined && body[k] !== null && typeof body[k] !== "string") return NextResponse.json({ error: `${k} must be text` }, { status: 400 });
  const di = typeof body.di === "string" ? body.di.trim() : "";
  const manufacturer = typeof body.manufacturer === "string" ? body.manufacturer : undefined;
  const description = typeof body.description === "string" ? body.description : undefined;
  if ((manufacturer && manufacturer.length > 200) || (description && description.length > 2000) || di.length > 64) return NextResponse.json({ error: "text too long" }, { status: 400 });
  if (!di && manufacturer === undefined && description === undefined) return NextResponse.json({ error: "nothing to correct: send di, manufacturer or description" }, { status: 400 });
  const cp = await prisma.competitorProduct.findUnique({ where: { id } });
  if (!cp || !(await assertCorrectable(actor, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A corrected row is re-binned and re-embedded on its next use: the bin is cleared here, the
  // embedding hash too (src/lib/match/embeddings.ts also re-hashes the text, belt and braces).
  const invalidate = { binJson: null, binSource: null, binnedAt: null, embeddingHash: null, embeddedAt: null } as const;
  if (di) {
    // GS1 (8–14 digits), HIBCC (+…) or ICCBBA (=…) device identifiers; anything else never reaches openFDA.
    if (!/^(\d{8,14}|\+[A-Z0-9/+]{4,40}|=[A-Z0-9/=#+]{4,40})$/i.test(di)) return NextResponse.json({ error: "di is not a GUDID device identifier" }, { status: 400 });
    let rec: Awaited<ReturnType<typeof lookupByDi>>;
    try { rec = await lookupByDi(di); } catch (e) { console.error("[competitor] GUDID lookup failed", e); return NextResponse.json({ error: "GUDID lookup failed; try again later" }, { status: 502 }); }
    if (!rec) return NextResponse.json({ error: "DI not found in GUDID" }, { status: 404 });
    const s = summarizeRecord(rec);
    const updated = await prisma.competitorProduct.update({
      where: { id },
      data: { manufacturer: displayManufacturer(s.manufacturer), labeler: s.manufacturer, brand: s.brand, description: s.description, gudidDi: s.gudidDi, gmdnName: s.gmdnName, gmdnCode: s.gmdnCode, fdaProductCode: s.fdaProductCode, status: s.status, gudidJson: JSON.stringify(rec), resolution: "manual", resolutionNote: "Chosen by rep from GUDID alternates", confidence: 1, ...invalidate },
    });
    await audit({ actorUserId: actor.id, entityType: "CompetitorProduct", entityId: id, action: "CORRECTED", before: { manufacturer: cp.manufacturer, description: cp.description, gudidDi: cp.gudidDi }, after: { manufacturer: updated.manufacturer, description: updated.description, gudidDi: updated.gudidDi } });
    return NextResponse.json(updated);
  }
  const updated = await prisma.competitorProduct.update({
    where: { id },
    data: { manufacturer: manufacturer ?? cp.manufacturer, description: description ?? cp.description, resolution: "manual", resolutionNote: "Entered by rep", confidence: 1, ...invalidate },
  });
  await audit({ actorUserId: actor.id, entityType: "CompetitorProduct", entityId: id, action: "CORRECTED", before: { manufacturer: cp.manufacturer, description: cp.description }, after: { manufacturer: updated.manufacturer, description: updated.description } });
  return NextResponse.json(updated);
}

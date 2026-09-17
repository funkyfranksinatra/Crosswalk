import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorize } from "@/lib/api";
import { can } from "@/lib/auth";
import { summarizeRecord, type OpenFdaRecord } from "@/lib/gudid/openfda";
import { parseBin, binSimilarity } from "@/lib/match/bin";

/**
 * Side-by-side (Tier 3.2): the competitor's GUDID record and our candidate's, attribute by
 * attribute, with the bins the matcher compared. Pure read; the same data the run used.
 */
type Side = { sku: string; brand: string | null; manufacturer: string | null; description: string | null; gudidDi: string | null; gmdnName: string | null; gmdnCode: string | null; fdaProductCode: string | null; status: string | null; sizes: { type?: string | null; value?: string | null; unit?: string | null; text?: string | null }[]; singleUse: boolean | null; sterile: boolean | null; implantable: boolean | null; specialties: string[]; bin: ReturnType<typeof parseBin>; binSource: string | null; listPrice: number | null; gudidUrl: string | null };

function side(p: { sku: string; brand: string | null; manufacturer?: string | null; labeler?: string | null; description: string | null; gudidDi: string | null; gmdnName: string | null; gmdnCode: string | null; fdaProductCode: string | null; status: string | null; gudidJson: string | null; binJson: string | null; binSource: string | null; listPrice?: unknown }): Side {
  const raw = p.gudidJson ? (JSON.parse(p.gudidJson) as OpenFdaRecord) : null;
  const s = raw ? summarizeRecord(raw) : null;
  return { sku: p.sku, brand: p.brand ?? s?.brand ?? null, manufacturer: p.manufacturer ?? p.labeler ?? s?.manufacturer ?? null, description: p.description ?? s?.description ?? null, gudidDi: p.gudidDi ?? s?.gudidDi ?? null, gmdnName: p.gmdnName ?? s?.gmdnName ?? null, gmdnCode: p.gmdnCode ?? s?.gmdnCode ?? null, fdaProductCode: p.fdaProductCode ?? s?.fdaProductCode ?? null, status: p.status ?? s?.status ?? null, sizes: (s?.sizes ?? []) as Side["sizes"], singleUse: s?.singleUse ?? null, sterile: s?.sterile ?? null, implantable: s?.implantable ?? null, specialties: s?.specialties ?? [], bin: parseBin(p.binJson, { allowStale: true }), binSource: p.binSource, listPrice: p.listPrice == null ? null : Number(p.listPrice), gudidUrl: (p.gudidDi ?? s?.gudidDi) ? `https://accessgudid.nlm.nih.gov/devices/${p.gudidDi ?? s?.gudidDi}` : null };
}

const fmtSizes = (s: Side["sizes"]) => s.map((z) => [z.type, z.value, z.unit].filter(Boolean).join(" ") || z.text || "").filter(Boolean).join(" · ") || null;
const yn = (v: boolean | null) => (v === null ? null : v ? "yes" : "no");

export async function GET(req: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const candidateId = new URL(req.url).searchParams.get("candidateId");
  const line = await prisma.requestLine.findFirst({ where: { id: lineId, requestId: id }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } });
  if (!line) return NextResponse.json({ error: "not found" }, { status: 404 });
  const cand = (candidateId ? line.candidates.find((c) => c.id === candidateId) : null) ?? line.candidates.find((c) => c.id === line.selectedCandidateId) ?? line.candidates[0] ?? null;
  if (!line.competitorProduct || !cand) return NextResponse.json({ error: "Nothing to compare: the line needs a resolved competitor product and a candidate" }, { status: 400 });
  const cp = line.competitorProduct;
  const a = side({ sku: cp.cfnMatched ?? cp.cfnNorm, brand: cp.brand, manufacturer: cp.manufacturer, description: cp.description, gudidDi: cp.gudidDi, gmdnName: cp.gmdnName, gmdnCode: cp.gmdnCode, fdaProductCode: cp.fdaProductCode, status: cp.status, gudidJson: cp.gudidJson, binJson: cp.binJson, binSource: cp.binSource });
  const o = cand.ownProduct;
  const b = side({ sku: o.sku, brand: o.brand, labeler: o.labeler, description: o.description, gudidDi: o.gudidDi, gmdnName: o.gmdnName, gmdnCode: o.gmdnCode, fdaProductCode: o.fdaProductCode, status: o.status, gudidJson: o.gudidJson, binJson: o.binJson, binSource: o.binSource, listPrice: can(actor, "view_pricing") ? o.listPrice : null });
  const row = (attribute: string, x: string | null, y: string | null, group: string) => ({ attribute, competitor: x, ours: y, same: x != null && y != null ? x.toLowerCase() === y.toLowerCase() : null, group });
  const rows = [
    row("Brand", a.brand, b.brand, "GUDID"), row("Manufacturer", a.manufacturer, b.manufacturer, "GUDID"), row("Description", a.description, b.description, "GUDID"),
    row("GMDN term", a.gmdnName, b.gmdnName, "GUDID"), row("FDA product code", a.fdaProductCode, b.fdaProductCode, "GUDID"), row("Sizes (GUDID)", fmtSizes(a.sizes), fmtSizes(b.sizes), "GUDID"),
    row("Single use", yn(a.singleUse), yn(b.singleUse), "GUDID"), row("Sterile", yn(a.sterile), yn(b.sterile), "GUDID"), row("Implantable", yn(a.implantable), yn(b.implantable), "GUDID"),
    row("Specialties", a.specialties.join(", ") || null, b.specialties.join(", ") || null, "GUDID"), row("Distribution status", a.status, b.status, "GUDID"),
    row("Family", a.bin?.family ?? null, b.bin?.family ?? null, "Bin"), row("Product type", a.bin?.productType ?? null, b.bin?.productType ?? null, "Bin"),
    row("Dimensions", a.bin?.dimensions.map((d) => `${d.name} ${d.value} ${d.unit}`).join(" · ") || null, b.bin?.dimensions.map((d) => `${d.name} ${d.value} ${d.unit}`).join(" · ") || null, "Bin"),
    row("Materials", a.bin?.materials.join(", ") || null, b.bin?.materials.join(", ") || null, "Bin"), row("Features", a.bin?.features.join(", ") || null, b.bin?.features.join(", ") || null, "Bin"),
    row("Platform / compatibility", a.bin?.compatibility.join(", ") || null, b.bin?.compatibility.join(", ") || null, "Bin"), row("Function", a.bin?.function ?? null, b.bin?.function ?? null, "Bin"),
  ];
  const sim = a.bin && b.bin ? binSimilarity(a.bin, b.bin, a.description ?? "", b.description ?? "") : null;
  return NextResponse.json({ line: { id: line.id, rawCode: line.rawCode, quantity: line.quantity }, candidate: { id: cand.id, rank: cand.rank, matchType: cand.matchType, score: cand.score, rationale: cand.rationale, additionalProducts: cand.additionalProducts, unitPrice: cand.unitPrice == null ? null : Number(cand.unitPrice) }, competitor: { ...a, bin: undefined, binSource: a.binSource }, ours: { ...b, bin: undefined, binSource: b.binSource }, rows, similarity: sim ? { score: sim.score, breakdown: sim } : null, candidates: line.candidates.map((c) => ({ id: c.id, sku: c.ownProduct.sku, rank: c.rank, matchType: c.matchType })) });
}

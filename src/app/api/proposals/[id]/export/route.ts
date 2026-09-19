import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { authorize } from "@/lib/api";
import { buildQuote } from "@/lib/proposals/export";
import { buildQuotePdf } from "@/lib/pdf";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fmt = new URL(req.url).searchParams.get("format");
  const format = fmt === "csv" ? "csv" : fmt === "pdf" ? "pdf" : "xlsx";
  try {
    // authorize() also applies the ownership scope to /api/proposals/<id> (Tier 0.2).
    const { actor, deny } = await authorize("export_proposals");
    if (deny) return deny;
    const { filename, buffer, contentType } = format === "pdf" ? await buildQuotePdf(actor, id) : await buildQuote(actor, id, format);
    return new Response(new Uint8Array(buffer), { headers: { "content-type": contentType, "content-disposition": `attachment; filename="${filename}"` } });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

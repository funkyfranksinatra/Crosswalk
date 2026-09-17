import { buildCrossReferenceWorkbook, buildContractOfferWorkbook, buildCrossReferenceRows, buildContractOfferRows } from "@/lib/excel/export";
import { toCsv } from "@/lib/sheets/csv";
import { authorize } from "@/lib/api";
import { can, AuthError } from "@/lib/auth";
import { buildOfferPdf } from "@/lib/pdf";

/**
 * ?type=xref|offer&format=xlsx|csv
 *  xlsx — full workbook (legacy BAT layout + candidates + unresolved tabs)
 *  csv  — the main sheet only; opens straight in Google Sheets / anything
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const hide = { cost: !can(actor, "view_cost"), margin: !can(actor, "view_margin") };
  const sp = new URL(req.url).searchParams;
  const type = sp.get("type") ?? "xref";
  const format = sp.get("format") ?? "xlsx";
  if (format === "pdf") {
    if (type !== "offer") return new Response(JSON.stringify({ error: "PDF is available for the contract offer (type=offer)" }), { status: 400, headers: { "content-type": "application/json" } });
    try {
      const { buffer, filename, contentType } = await buildOfferPdf(actor, id);
      return new Response(new Uint8Array(buffer), { headers: { "content-type": contentType, "content-disposition": `attachment; filename="${filename}"` } });
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 400;
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status, headers: { "content-type": "application/json" } });
    }
  }
  if (format === "csv") {
    const { rows, filename } = type === "offer" ? await buildContractOfferRows(id) : await buildCrossReferenceRows(id, hide);
    return new Response(toCsv(rows), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename.replace(/\.xlsx$/, ".csv")}"` },
    });
  }
  const { buffer, filename } = type === "offer" ? await buildContractOfferWorkbook(id) : await buildCrossReferenceWorkbook(id, hide);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

import { buildCrossReferenceWorkbook, buildContractOfferWorkbook, buildCrossReferenceRows, buildContractOfferRows } from "@/lib/excel/export";
import { toCsv } from "@/lib/sheets/csv";

/**
 * ?type=xref|offer&format=xlsx|csv
 *  xlsx — full workbook (legacy BAT layout + candidates + unresolved tabs)
 *  csv  — the main sheet only; opens straight in Google Sheets / anything
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const type = sp.get("type") ?? "xref";
  const format = sp.get("format") ?? "xlsx";
  if (format === "csv") {
    const { rows, filename } = type === "offer" ? await buildContractOfferRows(id) : await buildCrossReferenceRows(id);
    return new Response(toCsv(rows), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename.replace(/\.xlsx$/, ".csv")}"` },
    });
  }
  const { buffer, filename } = type === "offer" ? await buildContractOfferWorkbook(id) : await buildCrossReferenceWorkbook(id);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

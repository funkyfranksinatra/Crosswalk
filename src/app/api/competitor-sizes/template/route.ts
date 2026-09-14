import { competitorSizesTemplate, competitorSizesTemplateRows } from "@/lib/excel/sizes";
import { toCsv } from "@/lib/sheets/csv";

export async function GET(req: Request) {
  const format = new URL(req.url).searchParams.get("format") ?? "xlsx";
  if (format === "csv") {
    const { rows } = await competitorSizesTemplateRows();
    return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="Crosswalk_Competitor_Sizes.csv"` } });
  }
  const buffer = await competitorSizesTemplate();
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="Crosswalk_Competitor_Sizes.xlsx"`,
    },
  });
}

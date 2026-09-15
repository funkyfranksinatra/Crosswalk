import { competitorSizesTemplate, competitorSizesTemplateRows } from "@/lib/excel/sizes";
import { toCsv } from "@/lib/sheets/csv";
import { authorize } from "@/lib/api";

export async function GET(req: Request) {
  const { deny } = await authorize("manage_catalog");
  if (deny) return deny;
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

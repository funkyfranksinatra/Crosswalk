import { getCompany } from "@/lib/settings";
import { pricingTemplate, pricingTemplateRows } from "@/lib/excel/pricing";
import { toCsv } from "@/lib/sheets/csv";
import { authorize } from "@/lib/api";

export async function GET(req: Request) {
  const { deny } = await authorize("import_cost_data");
  if (deny) return deny;
  const company = await getCompany();
  const format = new URL(req.url).searchParams.get("format") ?? "xlsx";
  if (format === "csv") {
    const rows = await pricingTemplateRows(company.id);
    return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="Crosswalk_Pricing_${company.name}.csv"` } });
  }
  const buffer = await pricingTemplate(company.id);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="Crosswalk_Pricing_${company.name}.xlsx"`,
    },
  });
}

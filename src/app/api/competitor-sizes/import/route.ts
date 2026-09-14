import { NextResponse } from "next/server";
import { importCompetitorSizes, importCompetitorSizesRows } from "@/lib/excel/sizes";
import { fetchSheetRows, parseSheetLink, SheetAccessError } from "@/lib/sheets/google";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "").trim();
  try {
    if (sheetUrl) {
      const ref = parseSheetLink(sheetUrl);
      if (!ref) return NextResponse.json({ error: "That doesn't look like a Google Sheets link" }, { status: 400 });
      const { rows } = await fetchSheetRows(ref);
      return NextResponse.json(await importCompetitorSizesRows(rows));
    }
    if (!(file instanceof File)) return NextResponse.json({ error: "Attach a file or paste a Google Sheets link" }, { status: 400 });
    if (/\.csv$/i.test(file.name)) {
      const { parseCsv } = await import("@/lib/sheets/csv");
      return NextResponse.json(await importCompetitorSizesRows(parseCsv(await file.text())));
    }
    return NextResponse.json(await importCompetitorSizes(Buffer.from(await file.arrayBuffer())));
  } catch (e) {
    if (e instanceof SheetAccessError) return NextResponse.json({ error: `${e.message} ${e.hint}` }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

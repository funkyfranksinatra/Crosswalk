import { assertSafeArchive } from "@/lib/security/archive";
import { NextResponse } from "next/server";
import { importCompetitorSizes, importCompetitorSizesRows } from "@/lib/excel/sizes";
import { fetchSheetRows, parseSheetLink, SheetAccessError } from "@/lib/sheets/google";
import { authorize, formBody, badRequest } from "@/lib/api";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  const { actor, deny } = await authorize("manage_catalog");
  if (deny) return deny;
  const form = await formBody(req);
  if (!form) return badRequest("Expected a multipart/form-data body");
  const done = async (r: { upserted?: number; rows?: number }) => { await audit({ actorUserId: actor.id, entityType: "CompetitorSpec", entityId: "import", action: "IMPORTED", after: { upserted: r.upserted ?? null, rows: r.rows ?? null } }); return NextResponse.json(r); };
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "").trim();
  if (file instanceof File && file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File is larger than 20 MB" }, { status: 400 });
  try {
    if (sheetUrl) {
      const ref = parseSheetLink(sheetUrl);
      if (!ref) return NextResponse.json({ error: "That doesn't look like a Google Sheets link" }, { status: 400 });
      const { rows } = await fetchSheetRows(ref);
      return done(await importCompetitorSizesRows(rows));
    }
    if (!(file instanceof File)) return NextResponse.json({ error: "Attach a file or paste a Google Sheets link" }, { status: 400 });
    if (/\.csv$/i.test(file.name)) {
      const { parseCsv } = await import("@/lib/sheets/csv");
      return done(await importCompetitorSizesRows(parseCsv(await file.text())));
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    try { assertSafeArchive(bytes, file.name || "file"); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    return done(await importCompetitorSizes(bytes));
  } catch (e) {
    if (e instanceof SheetAccessError) return NextResponse.json({ error: `${e.message} ${e.hint}` }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

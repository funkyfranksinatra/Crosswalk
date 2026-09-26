import { assertSafeArchive } from "@/lib/security/archive";
import { NextResponse } from "next/server";
import { parseIntakeAny } from "@/lib/excel/intake";
import { SheetAccessError } from "@/lib/sheets/google";
import { authorize, formBody, badRequest } from "@/lib/api";

export async function POST(req: Request) {
  const { deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const form = await formBody(req);
  if (!form) return badRequest("Expected a multipart/form-data body");
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "");
  const csvText = String(form.get("csvText") ?? "");
  if (file instanceof File && file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File is larger than 20 MB" }, { status: 400 });
  if (file instanceof File) { try { assertSafeArchive(Buffer.from(await file.arrayBuffer()), file.name || "file"); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); } }
  if (csvText.length > 5 * 1024 * 1024) return NextResponse.json({ error: "Pasted text is larger than 5 MB" }, { status: 400 });
  const csvName = String(form.get("csvName") ?? "");
  try {
    const intake = await parseIntakeAny({ file: file instanceof File ? file : null, sheetUrl, csvText, csvName });
    return NextResponse.json(intake);
  } catch (e) {
    if (e instanceof SheetAccessError) return NextResponse.json({ error: e.message, hint: e.hint }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { parseIntakeAny } from "@/lib/excel/intake";
import { SheetAccessError } from "@/lib/sheets/google";
import { authorize } from "@/lib/api";

export async function POST(req: Request) {
  const { deny } = await authorize("run_cross_reference");
  if (deny) return deny;
  const form = await req.formData();
  const file = form.get("file");
  const sheetUrl = String(form.get("sheetUrl") ?? "");
  const csvText = String(form.get("csvText") ?? "");
  const csvName = String(form.get("csvName") ?? "");
  try {
    const intake = await parseIntakeAny({ file: file instanceof File ? file : null, sheetUrl, csvText, csvName });
    return NextResponse.json(intake);
  } catch (e) {
    if (e instanceof SheetAccessError) return NextResponse.json({ error: e.message, hint: e.hint }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

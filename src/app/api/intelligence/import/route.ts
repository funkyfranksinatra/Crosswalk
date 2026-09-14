import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { importObservationsXlsx, importObservationRows } from "@/lib/intelligence/import";
import { fetchSheetRows, parseSheetLink } from "@/lib/sheets/google";
import { parseCsv } from "@/lib/sheets/csv";

export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const form = await req.formData();
    const file = form.get("file"); const sheetUrl = String(form.get("sheetUrl") ?? "").trim(); const kind = String(form.get("kind") ?? "COMPETITOR_LIST");
    if (sheetUrl) { const ref = parseSheetLink(sheetUrl); if (!ref) throw new Error("Not a Google Sheets link"); const { rows } = await fetchSheetRows(ref); return importObservationRows(actor.id, rows); }
    if (!(file instanceof File)) throw new Error("Attach a file or paste a Google Sheets link");
    // Provenance: the uploaded file is registered as a Document and every observation links to it.
    const doc = await prisma.document.create({ data: { kind, filename: file.name, mimeType: file.type || null, uploadedByUserId: actor.id, notes: `${file.size} bytes` } });
    if (/\.csv$/i.test(file.name)) return importObservationRows(actor.id, parseCsv(await file.text()), doc.id);
    return importObservationsXlsx(actor.id, Buffer.from(await file.arrayBuffer()), doc.id);
  });
}

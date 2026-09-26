import { assertSafeArchive } from "@/lib/security/archive";
import { prisma } from "@/lib/db";
import { handle, formBody } from "@/lib/api";
import { importObservationsXlsx, importObservationRows } from "@/lib/intelligence/import";
import { fetchSheetRows, parseSheetLink } from "@/lib/sheets/google";
import { parseCsv } from "@/lib/sheets/csv";

export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const form = await formBody(req); if (!form) throw new Error("Expected a multipart/form-data body");
    const file = form.get("file"); const sheetUrl = String(form.get("sheetUrl") ?? "").trim(); const kind = String(form.get("kind") ?? "COMPETITOR_LIST");
    if (sheetUrl) { const ref = parseSheetLink(sheetUrl); if (!ref) throw new Error("Not a Google Sheets link"); const { rows } = await fetchSheetRows(ref); return importObservationRows(actor.id, rows); }
    if (!(file instanceof File)) throw new Error("Attach a file or paste a Google Sheets link");
    if (file.size > 20 * 1024 * 1024) throw new Error("File is too large (max 20 MB)");
    const bytes = Buffer.from(await file.arrayBuffer()); assertSafeArchive(bytes, file.name || "file");
    // Provenance: the uploaded file is registered as a Document and every observation links to it.
    const doc = await prisma.document.create({ data: { kind, filename: file.name, mimeType: file.type || null, uploadedByUserId: actor.id, notes: `${file.size} bytes` } });
    if (/\.csv$/i.test(file.name)) return importObservationRows(actor.id, parseCsv(await file.text()), doc.id);
    return importObservationsXlsx(actor.id, bytes, doc.id);
  });
}

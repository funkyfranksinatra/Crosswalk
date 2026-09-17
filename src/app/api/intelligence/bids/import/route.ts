import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { importBidFileXlsx, importBidFileRows } from "@/lib/intelligence/bids";
import { fetchSheetRows, parseSheetLink } from "@/lib/sheets/google";
import { parseCsv } from "@/lib/sheets/csv";

/** A bid tabulation saved from a procurement portal (CSV / XLSX / Google Sheet) → awards + price observations. */
export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const form = await req.formData();
    const file = form.get("file"); const sheetUrl = String(form.get("sheetUrl") ?? "").trim(); const portal = String(form.get("portal") ?? "").trim() || null;
    if (sheetUrl) { const ref = parseSheetLink(sheetUrl); if (!ref) throw new Error("Not a Google Sheets link"); const { rows } = await fetchSheetRows(ref); return importBidFileRows(actor.id, rows, portal ?? "google sheet"); }
    if (!(file instanceof File)) throw new Error("Attach a file or paste a Google Sheets link");
    await prisma.document.create({ data: { kind: "BID_FILE", filename: file.name, mimeType: file.type || null, uploadedByUserId: actor.id, notes: `${file.size} bytes · public bid import` } });
    if (/\.csv$/i.test(file.name)) return importBidFileRows(actor.id, parseCsv(await file.text()), portal ?? file.name);
    return importBidFileXlsx(actor.id, Buffer.from(await file.arrayBuffer()), portal ?? file.name);
  });
}

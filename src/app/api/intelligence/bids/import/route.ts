import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { audit } from "@/lib/audit";
import { importBidFileXlsx, importBidFileRows } from "@/lib/intelligence/bids";
import { fetchSheetRows, parseSheetLink } from "@/lib/sheets/google";
import { parseCsv } from "@/lib/sheets/csv";

/** A bid tabulation saved from a procurement portal (CSV / XLSX / Google Sheet) → awards + price observations. */
export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const form = await req.formData();
    const file = form.get("file"); const sheetUrl = String(form.get("sheetUrl") ?? "").trim(); const portal = String(form.get("portal") ?? "").trim().slice(0, 80) || null;
    const done = async (source: string, r: Awaited<ReturnType<typeof importBidFileRows>>) => { await audit({ actorUserId: actor.id, entityType: "PublicAward", entityId: source.slice(0, 120), action: "IMPORTED", after: { awards: r.awards, observations: r.observations, rows: r.rows, skipped: r.skipped.length } }); return r; };
    if (sheetUrl) { const ref = parseSheetLink(sheetUrl); if (!ref) throw new Error("Not a Google Sheets link"); const { rows } = await fetchSheetRows(ref); return done(sheetUrl, await importBidFileRows(actor.id, rows, portal ?? "google sheet")); }
    if (!(file instanceof File)) throw new Error("Attach a file or paste a Google Sheets link");
    if (file.size > 20 * 1024 * 1024) throw new Error("File is too large (max 20 MB)");
    // Provenance: the file is registered as a Document and every observation links to it.
    const doc = await prisma.document.create({ data: { kind: "BID_FILE", filename: file.name, mimeType: file.type || null, uploadedByUserId: actor.id, notes: `${file.size} bytes · public bid import` } });
    if (/\.csv$/i.test(file.name)) return done(file.name, await importBidFileRows(actor.id, parseCsv(await file.text()), portal ?? file.name, doc.id));
    return done(file.name, await importBidFileXlsx(actor.id, Buffer.from(await file.arrayBuffer()), portal ?? file.name, doc.id));
  });
}

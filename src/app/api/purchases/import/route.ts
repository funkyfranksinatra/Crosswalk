import { prisma } from "@/lib/db";
import { handle, formBody } from "@/lib/api";
import { parseCsv } from "@/lib/sheets/csv";
import { audit } from "@/lib/audit";
import { importPurchasesGrid } from "@/lib/imports/purchases";
/** Purchase history import (CSV): Account Number, SKU, Quantity, Net Price, Currency, Invoice Date, Contract Number, Invoice Number. */
export async function POST(req: Request) {
  return handle("import_purchases", async (actor) => {
    const form = await formBody(req); if (!form) throw new Error("Expected a multipart/form-data body"); const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Attach a .csv");
    if (file.size > 20 * 1024 * 1024) throw new Error("File is larger than 20 MB");
    const doc = await prisma.document.create({ data: { kind: "INVOICE", filename: file.name.slice(0, 255), uploadedByUserId: actor.id } });
    const company = await prisma.company.findFirstOrThrow();
    const report = await importPurchasesGrid(parseCsv(await file.text()), company.id, doc.id);
    await audit({ actorUserId: actor.id, entityType: "Document", entityId: doc.id, action: "PURCHASES_IMPORTED", after: { created: report.created, updated: report.updated, skipped: report.skipped.length } });
    return report;
  });
}

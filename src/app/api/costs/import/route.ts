import { prisma } from "@/lib/db";
import { handle, formBody } from "@/lib/api";
import { parseCsv } from "@/lib/sheets/csv";
import { audit } from "@/lib/audit";
import { importCostsGrid } from "@/lib/imports/costs";
/** Standard cost import (CSV): SKU, Cost, Currency, Plant, Region, Cost Type, Effective From, Effective To. */
export async function POST(req: Request) {
  return handle("import_cost_data", async (actor) => {
    const form = await formBody(req); if (!form) throw new Error("Expected a multipart/form-data body"); const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Attach a .csv");
    if (file.size > 20 * 1024 * 1024) throw new Error("File is larger than 20 MB");
    const company = await prisma.company.findFirstOrThrow();
    const report = await importCostsGrid(parseCsv(await file.text()), company.id);
    await audit({ actorUserId: actor.id, entityType: "StandardCost", entityId: "import", action: "IMPORTED", after: { file: file.name, ...report, unknown: report.unknown.length, invalid: report.invalid.length } });
    return report;
  });
}

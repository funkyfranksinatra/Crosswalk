import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { parseCsv } from "@/lib/sheets/csv";
import { toDb } from "@/lib/money";
import { audit } from "@/lib/audit";
/** Standard cost import (CSV): SKU, Cost, Currency, Plant, Region, Cost Type, Effective From, Effective To. */
export async function POST(req: Request) {
  return handle("configure_pricing_rules", async (actor) => {
    const form = await req.formData(); const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Attach a .csv");
    const grid = parseCsv(await file.text()); const h = (grid[0] ?? []).map((c) => String(c ?? "").toLowerCase());
    const ix = (re: RegExp) => h.findIndex((x) => re.test(x));
    const cSku = ix(/sku|product/), cCost = ix(/cost$|standard cost|^cost/), cCcy = ix(/currency/), cPlant = ix(/plant/), cRegion = ix(/region/), cType = ix(/type/), cFrom = ix(/from|effective/), cTo = ix(/to$|expir/);
    if (cSku < 0 || cCost < 0) throw new Error("Need SKU and Cost columns");
    const company = await prisma.company.findFirstOrThrow();
    let created = 0; const unknown: string[] = [];
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r]; if (!row?.[cSku]) continue;
      const product = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku: String(row[cSku]).toUpperCase() } } });
      if (!product) { unknown.push(String(row[cSku])); continue; }
      await prisma.standardCost.create({ data: { productId: product.id, cost: toDb(row[cCost] as never)!, currency: cCcy >= 0 && row[cCcy] ? String(row[cCcy]) : "USD", plant: cPlant >= 0 && row[cPlant] ? String(row[cPlant]) : null, region: cRegion >= 0 && row[cRegion] ? String(row[cRegion]) : null, costType: cType >= 0 && row[cType] ? String(row[cType]).toUpperCase() : "STANDARD", effectiveFrom: cFrom >= 0 && row[cFrom] ? new Date(String(row[cFrom])) : new Date(), effectiveTo: cTo >= 0 && row[cTo] ? new Date(String(row[cTo])) : null, source: "import" } });
      created++;
    }
    await audit({ actorUserId: actor.id, entityType: "StandardCost", entityId: "import", action: "IMPORTED", after: { created, unknown } });
    return { created, unknown };
  });
}

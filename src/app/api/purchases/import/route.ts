import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { parseCsv } from "@/lib/sheets/csv";
import { toDb } from "@/lib/money";
import { normalizeCfn } from "@/lib/cfn";
import { audit } from "@/lib/audit";
/** Purchase history import (CSV): Account Number, SKU, Quantity, Net Price, Currency, Invoice Date, Contract Number, Invoice Number. */
export async function POST(req: Request) {
  return handle("import_purchases", async (actor) => {
    const form = await req.formData(); const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Attach a .csv");
    const grid = parseCsv(await file.text()); const h = (grid[0] ?? []).map((c) => String(c ?? "").toLowerCase());
    const ix = (re: RegExp) => h.findIndex((x) => re.test(x));
    const cAcc = ix(/account/), cSku = ix(/sku|product|item/), cQty = ix(/qty|quantity/), cPrice = ix(/price/), cCcy = ix(/currency/), cDate = ix(/date/), cContract = ix(/contract/), cInv = ix(/invoice|external/);
    if (cAcc < 0 || cSku < 0 || cQty < 0 || cPrice < 0 || cDate < 0) throw new Error("Need Account, SKU, Quantity, Net Price and Invoice Date columns");
    const doc = await prisma.document.create({ data: { kind: "INVOICE", filename: file.name, uploadedByUserId: actor.id } });
    const company = await prisma.company.findFirstOrThrow();
    let created = 0; const skipped: string[] = [];
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r]; if (!row?.[cSku]) continue;
      const account = await prisma.account.findFirst({ where: { OR: [{ accountNumber: String(row[cAcc]) }, { name: String(row[cAcc]) }] } });
      if (!account) { skipped.push(`row ${r + 1}: unknown account ${row[cAcc]}`); continue; }
      const sku = normalizeCfn(row[cSku]); const product = await prisma.ownProduct.findUnique({ where: { companyId_sku: { companyId: company.id, sku } } });
      const contract = cContract >= 0 && row[cContract] ? await prisma.contract.findUnique({ where: { contractNumber: String(row[cContract]) } }) : null;
      const won = await prisma.proposal.findFirst({ where: { accountId: account.id, status: "WON" }, orderBy: { decidedAt: "desc" } });
      await prisma.purchaseRecord.create({ data: { accountId: account.id, productId: product?.id ?? null, sku, quantity: toDb(row[cQty] as never)!, netPrice: toDb(row[cPrice] as never)!, currency: cCcy >= 0 && row[cCcy] ? String(row[cCcy]) : "USD", invoiceDate: new Date(String(row[cDate])), contractId: contract?.id ?? null, proposalId: won?.id ?? null, source: "import", externalId: cInv >= 0 && row[cInv] ? String(row[cInv]) : null, documentId: doc.id } });
      created++;
    }
    await audit({ actorUserId: actor.id, entityType: "Document", entityId: doc.id, action: "PURCHASES_IMPORTED", after: { created, skipped: skipped.length } });
    return { created, skipped };
  });
}

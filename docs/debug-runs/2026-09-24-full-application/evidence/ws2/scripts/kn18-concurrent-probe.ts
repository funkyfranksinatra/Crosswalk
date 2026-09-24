/** KN-18 concurrency probe: two simultaneous batches for the same band through the current route → duplicate ACTIVE bands. */
import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { setActorForTests } from "../../../../../../src/lib/auth";
import { permissionsFor } from "../../../../../../src/lib/auth/permissions";
import { getCompany } from "../../../../../../src/lib/settings";
import { POST } from "../../../../../../src/app/api/contracts/[id]/entries/route";

async function main() {
  const RUN = `kn18c${Date.now().toString(36)}`;
  const company = await getCompany();
  const u = await prisma.user.create({ data: { email: `${RUN}@test.local`, name: RUN, roles: { create: [{ role: "CONTRACTING_MANAGER" }] } } });
  setActorForTests({ id: u.id, email: u.email, name: u.name, roles: ["CONTRACTING_MANAGER"], permissions: permissionsFor(["CONTRACTING_MANAGER"]), isDev: true });
  const acct = await prisma.account.create({ data: { name: `${RUN} acct` } });
  const sku = `${RUN}-A`.toUpperCase();
  const p = await prisma.ownProduct.create({ data: { companyId: company.id, sku, description: sku, listPrice: "100", source: "manual" } });
  const c = await prisma.contract.create({ data: { contractNumber: `${RUN}-LOC`, name: RUN, type: "LOCAL", status: "ACTIVE", accountId: acct.id, effectiveFrom: new Date("2025-01-01"), entries: { create: [{ productId: p.id, price: "90", status: "ACTIVE", approvalState: "APPROVED", effectiveFrom: new Date("2025-01-01") }] } } });
  const mk = (price: string) => new Request("http://x/api/contracts/x/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [{ sku, price }] }) });
  const res = await Promise.all([POST(mk("81"), { params: Promise.resolve({ id: c.id }) }), POST(mk("82"), { params: Promise.resolve({ id: c.id }) })]);
  console.log("statuses:", res.map((r) => r.status).join(","), await Promise.all(res.map((r) => r.text())));
  const rows = await prisma.priceEntry.findMany({ where: { contractId: c.id } });
  console.log("rows:", rows.map((e) => `${e.status}:${e.price}`).sort().join(", "));
  console.log(`ACTIVE entries for one SKU/band: ${rows.filter((e) => e.status === "ACTIVE").length} (must be 1)`);
  await prisma.contract.delete({ where: { id: c.id } });
  await prisma.ownProduct.delete({ where: { id: p.id } });
  await prisma.account.delete({ where: { id: acct.id } });
  await prisma.user.delete({ where: { id: u.id } });
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

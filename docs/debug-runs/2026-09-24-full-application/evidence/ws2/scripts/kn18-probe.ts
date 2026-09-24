/**
 * KN-18 probe: POST /api/contracts/{id}/entries in-process, with the 2nd priceEntry.create failing.
 * Shows partial supersession/creation and no audit event. Run: VITEST=1 npx tsx <this file>
 */
import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { setActorForTests } from "../../../../../../src/lib/auth";
import { permissionsFor } from "../../../../../../src/lib/auth/permissions";
import { getCompany } from "../../../../../../src/lib/settings";
import { POST } from "../../../../../../src/app/api/contracts/[id]/entries/route";

async function main() {
  const RUN = `kn18${Date.now().toString(36)}`;
  const company = await getCompany();
  const u = await prisma.user.create({ data: { email: `${RUN}@test.local`, name: RUN, roles: { create: [{ role: "CONTRACTING_MANAGER" }] } } });
  setActorForTests({ id: u.id, email: u.email, name: u.name, roles: ["CONTRACTING_MANAGER"], permissions: permissionsFor(["CONTRACTING_MANAGER"]), isDev: true });
  const acct = await prisma.account.create({ data: { name: `${RUN} acct` } });
  const skus = ["A", "B", "C"].map((s) => `${RUN}-${s}`.toUpperCase());
  const products = [] as { id: string; sku: string }[];
  for (const sku of skus) products.push(await prisma.ownProduct.create({ data: { companyId: company.id, sku, description: sku, listPrice: "100", source: "manual" } }));
  const c = await prisma.contract.create({ data: { contractNumber: `${RUN}-LOC`, name: RUN, type: "LOCAL", status: "ACTIVE", accountId: acct.id, effectiveFrom: new Date("2025-01-01"), entries: { create: products.map((p) => ({ productId: p.id, price: "90", status: "ACTIVE", approvalState: "APPROVED", effectiveFrom: new Date("2025-01-01") })) } } });
  const before = await prisma.priceEntry.findMany({ where: { contractId: c.id }, orderBy: { createdAt: "asc" } });
  console.log("before:", before.map((e) => `${e.status}:${e.price}`).join(", "));
  // Failure injection: the 2nd create throws (as a DB error mid-batch would).
  const orig = prisma.priceEntry.create.bind(prisma.priceEntry);
  let n = 0;
  (prisma.priceEntry as unknown as { create: unknown }).create = (args: unknown) => { n++; if (n === 2) throw new Error("injected failure on entry 2"); return orig(args as never); };
  const req = new Request("http://x/api/contracts/x/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: skus.map((sku) => ({ sku, price: "80" })) }) });
  const res = await POST(req, { params: Promise.resolve({ id: c.id }) });
  console.log("status:", res.status, await res.text());
  (prisma.priceEntry as unknown as { create: unknown }).create = orig;
  const after = await prisma.priceEntry.findMany({ where: { contractId: c.id }, orderBy: [{ productId: "asc" }, { createdAt: "asc" }] });
  for (const p of products) console.log(p.sku, "→", after.filter((e) => e.productId === p.id).map((e) => `${e.status}:${e.price}`).join(", "));
  const audits = await prisma.auditEvent.count({ where: { entityType: "Contract", entityId: c.id } });
  console.log("audit events:", audits);
  const activeCount = after.filter((e) => e.status === "ACTIVE").length;
  console.log(`ACTIVE entries after failed batch: ${activeCount} (expected 3 if atomic — A has a new ACTIVE 80 while B and C still have the old 90 → partial write)`);
  await prisma.contract.delete({ where: { id: c.id } });
  await prisma.ownProduct.deleteMany({ where: { sku: { in: skus } } });
  await prisma.account.delete({ where: { id: acct.id } });
  await prisma.user.delete({ where: { id: u.id } });
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

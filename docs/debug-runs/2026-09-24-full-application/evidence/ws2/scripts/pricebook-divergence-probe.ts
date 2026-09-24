/** Run `priceOf` (no pricebook selected → no `prices`) vs proposal snapshot (all pricebook entries) for a SKU without a catalog list price. */
import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { getCompany } from "../../../../../../src/lib/settings";
import { loadPricingContext } from "../../../../../../src/lib/contracts/context";
import { createFromRequest } from "../../../../../../src/lib/proposals/service";
import { permissionsFor } from "../../../../../../src/lib/auth/permissions";
import { D } from "../../../../../../src/lib/money";

async function main() {
  const RUN = `pbd${Date.now().toString(36)}`;
  const company = await getCompany();
  const u = await prisma.user.create({ data: { email: `${RUN}@test.local`, name: RUN, roles: { create: [{ role: "SALES_REP" }] } } });
  const actor = { id: u.id, email: u.email, name: u.name, roles: ["SALES_REP"], permissions: permissionsFor(["SALES_REP"]), isDev: true };
  const acct = await prisma.account.create({ data: { name: `${RUN} acct` } });
  const pb = await prisma.pricebook.create({ data: { name: `${RUN} Pricebook` } });
  const p = await prisma.ownProduct.create({ data: { companyId: company.id, sku: `${RUN}-X`.toUpperCase(), description: "no catalog list price", listPrice: null, cogs: "10", source: "manual", prices: { create: [{ pricebookId: pb.id, price: "77", status: "ACTIVE", approvalState: "APPROVED", effectiveFrom: new Date("2025-01-01") }] } } });
  const ctx = await loadPricingContext({ accountId: acct.id });
  const run = ctx.resolvePrice({ id: p.id, sku: p.sku, category: p.category, listPrice: p.listPrice, currency: "USD", prices: [] }, D(1)); // request without a selected pricebook → run.ts passes no prices
  console.log("run priceOf (no pricebook selected):", run.price?.toString() ?? null, "|", run.explanation);
  const req = await prisma.request.create({ data: { companyId: company.id, reference: `${RUN}-REQ`, accountId: acct.id, status: "complete", useLlm: false, lines: { create: [{ lineNo: 1, rawCode: "X1", cfnNorm: "X1", quantity: 1, resolutionStatus: "resolved", matchStatus: "matched" }] } }, include: { lines: true } });
  const cand = await prisma.matchCandidate.create({ data: { lineId: req.lines[0].id, ownProductId: p.id, rank: 1, matchType: "Close Match", source: "attribute", score: 0.8, isSelected: true } });
  await prisma.requestLine.update({ where: { id: req.lines[0].id }, data: { selectedCandidateId: cand.id } });
  const prop = await createFromRequest(actor, req.id, { accountId: acct.id });
  const line = await prisma.proposalLine.findFirstOrThrow({ where: { proposalId: prop.id } });
  console.log("proposal snapshot listPrice:", line.listPrice?.toString() ?? null, "| proposedPrice:", line.proposedPrice?.toString() ?? null, "|", JSON.parse(line.waterfallJson!).explanation);
  await prisma.matchDecision.deleteMany({ where: { proposalLineId: line.id } });
  await prisma.proposal.delete({ where: { id: prop.id } });
  await prisma.request.delete({ where: { id: req.id } });
  await prisma.ownProduct.delete({ where: { id: p.id } });
  await prisma.pricebook.delete({ where: { id: pb.id } });
  await prisma.account.delete({ where: { id: acct.id } });
  await prisma.user.delete({ where: { id: u.id } });
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

/** After submitForApproval routes lines to PENDING, economicsJson.approvalsPending still says 0. */
import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { getCompany } from "../../../../../../src/lib/settings";
import { createFromRequest, setProposedPrice } from "../../../../../../src/lib/proposals/service";
import { submitForApproval } from "../../../../../../src/lib/approvals/service";
import { permissionsFor } from "../../../../../../src/lib/auth/permissions";
import { D } from "../../../../../../src/lib/money";

async function main() {
  const RUN = `ecs${Date.now().toString(36)}`;
  const company = await getCompany();
  const u = await prisma.user.create({ data: { email: `${RUN}@test.local`, name: RUN, roles: { create: [{ role: "SALES_REP" }] } } });
  const actor = { id: u.id, email: u.email, name: u.name, roles: ["SALES_REP"], permissions: permissionsFor(["SALES_REP"]), isDev: true };
  const acct = await prisma.account.create({ data: { name: `${RUN} acct` } });
  const p = await prisma.ownProduct.create({ data: { companyId: company.id, sku: `${RUN}-X`.toUpperCase(), description: "x", listPrice: "1000", cogs: "400", category: `${RUN} fam`, source: "manual" } });
  const req = await prisma.request.create({ data: { companyId: company.id, reference: `${RUN}-REQ`, accountId: acct.id, status: "complete", useLlm: false, lines: { create: [{ lineNo: 1, rawCode: "X1", cfnNorm: "X1", quantity: 1, resolutionStatus: "resolved", matchStatus: "matched" }] } }, include: { lines: true } });
  const cand = await prisma.matchCandidate.create({ data: { lineId: req.lines[0].id, ownProductId: p.id, rank: 1, matchType: "Close Match", source: "attribute", score: 0.8, isSelected: true } });
  await prisma.requestLine.update({ where: { id: req.lines[0].id }, data: { selectedCandidateId: cand.id } });
  const prop = await createFromRequest(actor, req.id, { accountId: acct.id });
  const line = await prisma.proposalLine.findFirstOrThrow({ where: { proposalId: prop.id } });
  await setProposedPrice(actor, line.id, D("600")); // 40 % off list → PRICING_DIRECTOR
  const r = await submitForApproval(actor, prop.id);
  const after = await prisma.proposal.findUniqueOrThrow({ where: { id: prop.id }, include: { lines: true } });
  const econ = JSON.parse(after.economicsJson!);
  console.log("submit:", JSON.stringify(r), "| line approvalState:", after.lines[0].approvalState, "| economicsJson.approvalsPending:", econ.approvalsPending, "approvalsRequired:", econ.approvalsRequired);
  await prisma.matchDecision.deleteMany({ where: { proposalLineId: line.id } });
  await prisma.proposal.delete({ where: { id: prop.id } });
  await prisma.request.delete({ where: { id: req.id } });
  await prisma.ownProduct.delete({ where: { id: p.id } });
  await prisma.account.delete({ where: { id: acct.id } });
  await prisma.user.delete({ where: { id: u.id } });
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

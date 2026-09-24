import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { tenancyStatus, checkTenancy } from "../../../../../../src/lib/tenancy";
async function main() {
  const t = await tenancyStatus();
  console.log(JSON.stringify({ ok: t.ok, company: t.company, companies: t.companies.length, note: t.note }));
  try { await checkTenancy(); console.log("checkTenancy(strict): passed"); } catch (e) { console.log("checkTenancy(strict): " + (e as Error).message); }
  await prisma.$disconnect();
}
main();

/**
 * CLI smoke test / headless runner:
 *   npx tsx scripts/run-sample.ts [path/to/intake.xlsx] [--account 0001880967 --name "Memorial Sloan Kettering"]
 * Creates a request, runs the pipeline in-process, prints the result table and writes both exports to ./out.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { parseIntake } from "../src/lib/excel/intake";
import { runRequest } from "../src/lib/pipeline/run";
import { buildCrossReferenceWorkbook, buildContractOfferWorkbook } from "../src/lib/excel/export";
import { getCompany } from "../src/lib/settings";
import { nextReference } from "../src/lib/requests";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) ?? "data/reference/CrossReference_0001880967.xlsx";
  const account = args.includes("--account") ? args[args.indexOf("--account") + 1] : "0001880967";
  const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : "Memorial Sloan Kettering";
  const company = await getCompany();
  const intake = await parseIntake(fs.readFileSync(file));
  console.log(`Parsed ${intake.lines.length} lines from ${file} (sheet ${intake.sheet}, ${intake.duplicatesMerged} duplicates merged, ${intake.skipped.length} skipped)`);
  const pricebook = await prisma.pricebook.findFirst();
  const req = await prisma.request.create({
    data: {
      companyId: company.id,
      reference: await nextReference(),
      accountNumber: account,
      accountName: name,
      accountType: "Sold-To",
      pricebookId: pricebook?.id,
      sourceFileName: path.basename(file),
      status: "queued",
      lines: { create: intake.lines.map((l, i) => ({ lineNo: i + 1, rawCode: l.rawCode, cfnNorm: l.cfnNorm, quantity: l.quantity, estCompetitorPrice: l.estPrice })) },
    },
  });
  console.log(`Created ${req.reference} (${req.id})`);
  const t = Date.now();
  await runRequest(req.id);
  console.log(`Run finished in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  const lines = await prisma.requestLine.findMany({ where: { requestId: req.id }, orderBy: { lineNo: "asc" }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } });
  for (const l of lines) {
    const cp = l.competitorProduct;
    const best = l.candidates[0];
    console.log(`${String(l.rawCode).padEnd(14)} q${String(l.quantity).padStart(3)}  ${(cp?.manufacturer ?? "?").padEnd(16)} ${(cp?.description ?? l.resolutionNote ?? "").slice(0, 55).padEnd(56)} → ${best ? `${best.ownProduct.sku.padEnd(12)} ${best.matchType.padEnd(17)} ${(best.score * 100).toFixed(0)}% [${best.source}] ${best.ownProduct.description.slice(0, 45)}` : "NO MATCH"}`);
  }
  fs.mkdirSync("out", { recursive: true });
  const x = await buildCrossReferenceWorkbook(req.id);
  fs.writeFileSync(path.join("out", x.filename), x.buffer);
  const o = await buildContractOfferWorkbook(req.id);
  fs.writeFileSync(path.join("out", o.filename), o.buffer);
  console.log(`Wrote out/${x.filename} and out/${o.filename}`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });

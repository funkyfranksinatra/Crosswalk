import { prisma } from "@/lib/db";
import { PageHeader, Empty } from "@/components/ui";
import { NewRequestForm } from "./form";
import { llmConfig } from "@/lib/llm/client";
import { getActor, can } from "@/lib/auth";

export default async function NewRequestPage() {
  // The wizard's APIs (intake preview, create request) need run_cross_reference; without it the
  // page would only be a dead end that also lists the pricebook names.
  const actor = await getActor();
  if (!can(actor, "run_cross_reference")) return <Empty title="Cross-reference requests need the run cross reference permission">Your role can review results shared with you but cannot start a request.</Empty>;
  const pricebooks = await prisma.pricebook.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { entries: true } } } });
  return (
    <>
      <PageHeader eyebrow="New request" title="Competitive cross reference" description="Point Crosswalk at the prospect's competitor usage — a Google Sheet, pasted cells, or a file with catalog numbers and quantities — and tell us who the account is." />
      <NewRequestForm pricebooks={pricebooks.map((p) => ({ id: p.id, name: p.name, entries: p._count.entries }))} llmAvailable={llmConfig().available} />
    </>
  );
}

import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { NewRequestForm } from "./form";
import { llmConfig } from "@/lib/llm/client";

export default async function NewRequestPage() {
  const pricebooks = await prisma.pricebook.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { entries: true } } } });
  return (
    <>
      <PageHeader eyebrow="New request" title="Competitive cross reference" description="Point CRACR at the prospect's competitor usage — a Google Sheet, pasted cells, or a file with catalog numbers and quantities — and tell us who the account is." />
      <NewRequestForm pricebooks={pricebooks.map((p) => ({ id: p.id, name: p.name, entries: p._count.entries }))} llmAvailable={llmConfig().available} />
    </>
  );
}

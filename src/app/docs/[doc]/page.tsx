import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActor, can } from "@/lib/auth";
import { PageHeader, Card, Empty } from "@/components/ui";
import { renderMarkdown } from "./markdown";

/**
 * Serves a handful of operator documents from docs/ inside the app (Settings links to them).
 *
 * Security: the URL segment is only ever used as a key into this fixed allowlist — it is never
 * joined into a filesystem path — so `..`, encoded slashes, absolute paths or any other name
 * resolve to a 404 before the filesystem is touched. The files are read at request time so a
 * doc edit shows without a rebuild; a missing file (a standalone deploy without docs/) is a 404.
 */
const DOCS: Record<string, { file: string; title: string }> = {
  "INTEGRATIONS.md": { file: "INTEGRATIONS.md", title: "Integrations" },
  "INTEGRATION_SETUP.md": { file: "INTEGRATION_SETUP.md", title: "Integration setup" },
};

export default async function DocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const entry = Object.prototype.hasOwnProperty.call(DOCS, doc) ? DOCS[doc] : null;
  if (!entry) notFound();
  const actor = await getActor();
  if (!can(actor, "configure_settings")) return <Empty title="Operator documentation is available to people who configure the system">Ask an administrator or pricing director for the integration credentials list.</Empty>;
  let text: string;
  try { text = await readFile(path.join(process.cwd(), "docs", entry.file), "utf8"); } catch { notFound(); }
  return (
    <>
      <PageHeader eyebrow={<Link href="/settings" className="hover:underline">Settings</Link>} title={entry.title} description={<span className="mono text-[12px]">docs/{entry.file}</span>} />
      <Card>
        <article className="doc">{renderMarkdown(text)}</article>
      </Card>
    </>
  );
}

import { prisma } from "@/lib/db";
import { handle } from "@/lib/api";
import { parseCsv } from "@/lib/sheets/csv";
import { readConfig } from "@/lib/integrations/core/config";
import { buildExtraction, cfgRead } from "@/lib/integrations/core/registry";
import { runExtraction } from "@/lib/integrations/documents/service";
import { DOCUMENT_TYPES, type DocumentType } from "@/lib/integrations/documents/fields";
import { storeDocumentBytes } from "@/lib/documents/storage";
import { gridFromXlsx } from "@/lib/integrations/core/tabular";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Upload a document and extract it with the configured provider (manual when none is
 * configured — the app never depends on an OCR vendor). Result: an extraction in REVIEW or
 * EXTRACTED; nothing enters the intelligence model until a person verifies and imports it.
 */
export async function POST(req: Request) {
  return handle("import_competitor_pricing", async (actor) => {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("attach a file");
    if (file.size > MAX_BYTES) throw new Error("file is larger than 25 MB");
    const documentType = String(form.get("documentType") ?? "INVOICE") as DocumentType;
    if (!DOCUMENT_TYPES.includes(documentType)) throw new Error(`documentType must be one of ${DOCUMENT_TYPES.join(", ")}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const doc = await prisma.document.create({ data: { kind: documentType === "PO" ? "PO" : documentType === "BID_LIST" ? "BID_FILE" : documentType === "CONTRACT_TABLE" ? "CONTRACT" : "INVOICE", filename: file.name, mimeType: file.type || null, uploadedByUserId: actor.id, notes: `${file.size} bytes` } });
    const storagePath = await storeDocumentBytes(doc.id, bytes);
    await prisma.document.update({ where: { id: doc.id }, data: { storagePath } });
    const cfg = await readConfig("documents").catch(() => null);
    const provider = cfg?.enabled ? await buildExtraction(cfg) : await buildExtraction({ key: "documents", provider: "manual", enabled: true, config: {}, secrets: {}, mapping: {}, scheduleCron: null, configVersion: 0, status: "CONFIGURED" });
    const tabular = /\.csv$/i.test(file.name) ? parseCsv(bytes.toString("utf8")) : /\.xlsx$/i.test(file.name) ? await gridFromXlsx(bytes) : null;
    if (provider.provider === "manual" && !tabular) throw new Error("no extraction provider is configured: upload a CSV/XLSX to map the columns manually, or configure Document extraction under Settings → Integrations");
    const threshold = cfg ? cfgRead.num(cfg.config, "threshold", 0.85) : 0.85;
    const alwaysReview = cfg ? cfgRead.bool(cfg.config, "alwaysReview", true) : true;
    return runExtraction(provider, doc.id, documentType, { bytes, grid: tabular }, { threshold, actorUserId: actor.id, alwaysReview });
  });
}

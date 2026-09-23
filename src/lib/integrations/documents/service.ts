/**
 * Extraction lifecycle: run a provider over a Document, persist every field with provenance,
 * route the result to human review when confidence is below the threshold (or a required
 * line field is missing), and only on verification hand the lines to the importers. Nothing
 * extracted becomes an observation or a purchase until a person has verified it — extraction
 * confidence is about reading the page; commercial confidence is decided later.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { audit } from "@/lib/audit";
import type { DocumentExtractionProvider } from "../core/contracts";
import type { ExtractedDocument } from "../types";
import { queueReview } from "../core/review";
import { asIntegrationError } from "../core/errors";
import { REQUIRED_LINE_FIELDS, type DocumentType } from "./fields";

export type ExtractionOutcome = { extractionId: string; status: "EXTRACTED" | "REVIEW" | "FAILED"; overallConfidence: number | null; lines: number; lowConfidenceLines: number; reviewItemId: string | null };

export async function runExtraction(provider: DocumentExtractionProvider, documentId: string, documentType: DocumentType, input: { bytes: Buffer | null; grid?: (string | number | null)[][] | null }, opts: { threshold: number; actorUserId: string | null; syncJobId?: string | null; alwaysReview?: boolean }): Promise<ExtractionOutcome> {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const row = await prisma.documentExtraction.create({ data: { documentId, provider: provider.provider, documentType, threshold: opts.threshold, requestedByUserId: opts.actorUserId, syncJobId: opts.syncJobId ?? null } });
  const t0 = Date.now();
  let out: ExtractedDocument;
  try {
    out = await provider.extract({ documentId, documentType, filename: doc.filename, mimeType: doc.mimeType, bytes: input.bytes, grid: input.grid ?? null });
  } catch (e) {
    const err = asIntegrationError(e);
    await prisma.documentExtraction.update({ where: { id: row.id }, data: { status: "FAILED", error: err.message.slice(0, 1000), completedAt: new Date() } });
    log.warn("documents.extraction_failed", { documentId, provider: provider.provider, category: err.category, ms: Date.now() - t0 });
    throw err;
  }
  const lines = new Map<number, Set<string>>();
  let low = 0;
  for (const f of out.fields) {
    if (f.scope === "LINE" && f.lineNo) { if (!lines.has(f.lineNo)) lines.set(f.lineNo, new Set()); lines.get(f.lineNo)!.add(f.field); }
  }
  const lowLines = new Set<number>();
  for (const f of out.fields) if (f.scope === "LINE" && f.lineNo && (f.confidence === null || f.confidence < opts.threshold)) lowLines.add(f.lineNo);
  for (const [no, fields] of lines) if (REQUIRED_LINE_FIELDS[documentType].some((r) => !fields.has(r))) lowLines.add(no);
  low = lowLines.size;
  const needsReview = opts.alwaysReview || low > 0 || out.overallConfidence === null || out.overallConfidence < opts.threshold || !lines.size;
  await prisma.extractedField.createMany({ data: out.fields.map((f) => ({ extractionId: row.id, scope: f.scope, lineNo: f.lineNo ?? null, field: f.field, rawValue: f.rawValue?.slice(0, 2000) ?? null, normalizedValue: f.normalizedValue?.slice(0, 2000) ?? null, confidence: f.confidence ?? null, page: f.page ?? null, section: f.section?.slice(0, 200) ?? null })) });
  await prisma.documentExtraction.update({ where: { id: row.id }, data: { status: needsReview ? "REVIEW" : "EXTRACTED", model: out.model ?? null, overallConfidence: out.overallConfidence, completedAt: new Date(), rawJson: out.raw ? JSON.stringify(out.raw).slice(0, 50_000) : null } });
  await prisma.document.update({ where: { id: documentId }, data: { extractionConfidence: out.overallConfidence ?? undefined } });
  let reviewItemId: string | null = null;
  if (needsReview) {
    const r = await queueReview("documents", { kind: "LOW_CONFIDENCE_EXTRACTION", summary: `${doc.filename}: ${lines.size} lines extracted by ${provider.provider}${low ? `, ${low} below the ${Math.round(opts.threshold * 100)}% threshold or missing a required field` : ""}${!lines.size ? " — no lines found" : ""}`, payload: { documentId, extractionId: row.id, documentType, overallConfidence: out.overallConfidence, lines: lines.size, lowConfidenceLines: [...lowLines] }, dedupeKey: `extraction:${row.id}`, syncJobId: opts.syncJobId ?? null, externalId: documentId });
    reviewItemId = r.id;
  }
  await audit({ actorUserId: opts.actorUserId, entityType: "Document", entityId: documentId, action: "EXTRACTED", context: { provider: provider.provider, model: out.model ?? null, extractionId: row.id, lines: lines.size, lowConfidenceLines: low, overallConfidence: out.overallConfidence, status: needsReview ? "REVIEW" : "EXTRACTED" } });
  log.info("documents.extracted", { documentId, provider: provider.provider, lines: lines.size, low, overall: out.overallConfidence, ms: Date.now() - t0, review: needsReview });
  return { extractionId: row.id, status: needsReview ? "REVIEW" : "EXTRACTED", overallConfidence: out.overallConfidence, lines: lines.size, lowConfidenceLines: low, reviewItemId };
}

/** A reviewer confirms / corrects fields; when every low line is settled the extraction is VERIFIED. */
export async function verifyExtraction(extractionId: string, actorUserId: string, decisions: { fieldId: string; status: "VERIFIED" | "CORRECTED" | "REJECTED"; correctedValue?: string | null }[], finalize: boolean): Promise<{ status: string; verifiedFields: number }> {
  for (const d of decisions) await prisma.extractedField.update({ where: { id: d.fieldId }, data: { verificationStatus: d.status, correctedValue: d.status === "CORRECTED" ? d.correctedValue ?? null : null, verifiedByUserId: actorUserId, verifiedAt: new Date() } });
  const verified = await prisma.extractedField.count({ where: { extractionId, verificationStatus: { in: ["VERIFIED", "CORRECTED"] } } });
  if (finalize) {
    await prisma.documentExtraction.update({ where: { id: extractionId }, data: { status: "VERIFIED", verifiedByUserId: actorUserId, verifiedAt: new Date() } });
    const open = await prisma.integrationReviewItem.findFirst({ where: { integrationKey: "documents", dedupeKey: `extraction:${extractionId}`, status: "OPEN" } });
    if (open) { const { resolveReview } = await import("../core/review"); await resolveReview(open.id, "ACCEPTED", actorUserId, { verifiedFields: verified }); }
    await audit({ actorUserId, entityType: "DocumentExtraction", entityId: extractionId, action: "VERIFIED", context: { verifiedFields: verified } });
  }
  return { status: finalize ? "VERIFIED" : "REVIEW", verifiedFields: verified };
}

/** The verified lines as a grid the existing importers (observations, purchases) accept. Unverified extractions yield nothing. */
export async function verifiedLinesGrid(extractionId: string): Promise<(string | number | null)[][]> {
  const x = await prisma.documentExtraction.findUniqueOrThrow({ where: { id: extractionId }, include: { fields: true } });
  if (x.status !== "VERIFIED") return [];
  const value = (f: { verificationStatus: string; correctedValue: string | null; normalizedValue: string | null }) => (f.verificationStatus === "REJECTED" ? null : f.verificationStatus === "CORRECTED" ? f.correctedValue : f.normalizedValue);
  const header = Object.fromEntries(x.fields.filter((f) => f.scope === "HEADER").map((f) => [f.field, value(f)]));
  const byLine = new Map<number, Record<string, string | null>>();
  for (const f of x.fields.filter((f) => f.scope === "LINE" && f.lineNo)) { if (!byLine.has(f.lineNo!)) byLine.set(f.lineNo!, {}); byLine.get(f.lineNo!)![f.field] = value(f); }
  const cols = ["Competitor", "Competitor Code", "Description", "Quantity", "UOM", "Unit Price", "Account Number", "GPO", "Observed Date", "Source Type", "Source Reference", "Tier"];
  const rows: (string | number | null)[][] = [cols];
  for (const [, l] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    if (!l.competitorSku) continue;
    rows.push([l.manufacturer ?? header.vendorName ?? null, l.competitorSku, l.description ?? null, l.quantity ?? null, l.uom ?? "EA", l.unitPrice ?? null, header.accountNumber ?? header.accountName ?? null, header.gpoName ?? null, l.lineDate ?? header.documentDate ?? null, x.documentType === "INVOICE" ? "CUSTOMER_INVOICE" : x.documentType === "PO" ? "CUSTOMER_PO" : x.documentType === "BID_LIST" ? "CUSTOMER_BID_FILE" : x.documentType === "CONTRACT_TABLE" ? "GPO_CONTRACT_FILE" : "REP_OBSERVED", header.documentNumber ?? null, l.tier ?? null]);
  }
  return rows;
}

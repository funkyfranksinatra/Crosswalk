/**
 * The application side of the model boundary (docs/AI_BOUNDARY.md).
 *
 *   application reads the DB → builds the input → gateway → src/lib/llm (model call)
 *   → schema-validated answer → gateway → application validates against the hard
 *   constraints → application writes the DB
 *
 * This module is the only importer of src/lib/llm/* (enforced by tests/unit/llm-boundary.test.ts):
 * every model call enters and leaves the application here. The model layer below never sees the
 * database; the record of each call (purpose, model, outcome, latency, tokens — never prompt or
 * answer text) is written by this application module, not by the model layer.
 */
import { prisma } from "@/lib/db";
import { onModelCall, type ModelCallRecord } from "@/lib/llm/client";

async function recordCall(r: ModelCallRecord): Promise<void> {
  // Embedding calls have their own metrics (src/lib/match/embeddings.ts); LlmCall keeps the
  // structured calls the Settings page, the alerting and retention already reason about.
  if (r.kind !== "structured") return;
  await prisma.llmCall.create({
    data: { purpose: r.purpose, subject: r.subject ?? null, model: r.model, ok: r.ok, durationMs: r.durationMs, inputTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null, error: r.error ?? null },
  }).catch(() => {});
}
onModelCall(recordCall);

export { llmConfig, llmPreflight, structured, embedTexts, type StructuredResult, type ModelCallRecord } from "@/lib/llm/client";
export { binProduct, cfnHints, type CfnHints } from "@/lib/llm/tasks";

/**
 * The model boundary (docs/AI_BOUNDARY.md). Everything under src/lib/llm/ talks to the model
 * provider and nothing else: it receives the data the application chose to send, builds the
 * request, and returns the schema-validated answer TO THE APPLICATION. It never imports the
 * database, the job queue or any module that does — tests/unit/llm-boundary.test.ts walks the
 * import graph and fails the build if that ever changes.
 *
 * Application code reaches this layer only through src/lib/ai/gateway.ts, which records each
 * call (LlmCall) and is the one place a model result enters the application; the application
 * then validates it further and persists it. The model has no tools, no credentials beyond
 * the provider key and no way to reach anything but the text in its request.
 *
 * OpenAI Responses API with structured outputs (zod). The model ID comes from LLM_MODEL so
 * any deployment name drops in without a code change; without an API key the adapter reports
 * unavailable and callers use heuristics.
 */
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";

/** What the boundary reports about one model call — no prompt text, no answer text. */
export type ModelCallRecord = {
  kind: "structured" | "embedding";
  purpose: string;
  subject?: string | null;
  model: string;
  ok: boolean;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
};
type CallObserver = (record: ModelCallRecord) => void | Promise<void>;
let observer: CallObserver | null = null;
/**
 * The application registers where call records go (src/lib/ai/gateway.ts writes LlmCall).
 * The boundary only hands the record over; an observer failure never fails the call.
 */
export function onModelCall(fn: CallObserver | null) { observer = fn; }
async function report(record: ModelCallRecord) {
  if (!observer) return;
  try { await observer(record); } catch { /* telemetry must never break a model call */ }
}

let client: OpenAI | null = null;

export function llmConfig() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return {
    available: Boolean(apiKey),
    model: process.env.LLM_MODEL?.trim() || "gpt-5.6-astra",
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
  };
}

function getClient(): OpenAI | null {
  const cfg = llmConfig();
  if (!cfg.available) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: cfg.baseURL });
  return client;
}

/** One tiny call to prove the key + model ID actually work before a run relies on them. */
export async function llmPreflight(): Promise<{ ok: boolean; model: string; error?: string }> {
  const cfg = llmConfig();
  if (!cfg.available) return { ok: false, model: cfg.model, error: "OPENAI_API_KEY is not set" };
  const { z } = await import("zod");
  const res = await structured({ purpose: "preflight", system: "Reply with ok=true.", user: "ping", schema: z.object({ ok: z.boolean() }), schemaName: "preflight", maxOutputTokens: 50 });
  return res.ok ? { ok: true, model: cfg.model } : { ok: false, model: cfg.model, error: res.error };
}

export type StructuredResult<T> = { ok: true; data: T; model: string } | { ok: false; error: string; model: string };

/**
 * Run one structured-output call. Never throws: every outcome is reported to the application's
 * observer and a failure is returned as { ok:false } so the pipeline can degrade gracefully.
 * The request carries exactly two messages built by the caller and a response schema — no
 * tools, no function definitions, nothing the model could use to reach further.
 */
export async function structured<T>(opts: {
  purpose: string;
  subject?: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
}): Promise<StructuredResult<T>> {
  const cfg = llmConfig();
  const c = getClient();
  if (!c) return { ok: false, error: "LLM not configured (OPENAI_API_KEY missing)", model: cfg.model };
  const started = Date.now();
  try {
    const res = await c.responses.parse({
      model: cfg.model,
      input: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      text: { format: zodTextFormat(opts.schema, opts.schemaName) },
      max_output_tokens: opts.maxOutputTokens ?? 1500,
    });
    const parsed = res.output_parsed as T | null;
    if (!parsed) throw new Error("empty structured output");
    await report({ kind: "structured", purpose: opts.purpose, subject: opts.subject ?? null, model: cfg.model, ok: true, durationMs: Date.now() - started, inputTokens: res.usage?.input_tokens ?? null, outputTokens: res.usage?.output_tokens ?? null });
    return { ok: true, data: parsed, model: cfg.model };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await report({ kind: "structured", purpose: opts.purpose, subject: opts.subject ?? null, model: cfg.model, ok: false, durationMs: Date.now() - started, error: error.slice(0, 500) });
    return { ok: false, error, model: cfg.model };
  }
}

let embedClient: OpenAI | null = null;
/**
 * Embed texts with the provider's embedding model. The application decides what text to send
 * (src/lib/match/embeddings.ts builds it from product attributes) and stores the vectors itself.
 * Throws on failure — the caller decides whether that is fatal.
 */
export async function embedTexts(texts: string[], opts: { model: string; dimensions: number; timeoutMs: number }): Promise<number[][]> {
  if (!texts.length) return [];
  const cfg = llmConfig();
  if (!cfg.available) throw new Error("OPENAI_API_KEY is not set — embeddings need the model key");
  if (!embedClient) embedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: cfg.baseURL, timeout: opts.timeoutMs, maxRetries: 1 });
  const started = Date.now();
  try {
    const res = await embedClient.embeddings.create({ model: opts.model, input: texts, dimensions: opts.dimensions });
    // The API returns in index order, but say so explicitly.
    const out = new Array<number[]>(texts.length);
    for (const d of res.data) out[d.index] = d.embedding;
    if (out.some((v) => !v || v.length !== opts.dimensions)) throw new Error("embedding response was incomplete");
    await report({ kind: "embedding", purpose: "embedding", model: opts.model, ok: true, durationMs: Date.now() - started, inputTokens: res.usage?.prompt_tokens ?? null });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await report({ kind: "embedding", purpose: "embedding", model: opts.model, ok: false, durationMs: Date.now() - started, error: error.slice(0, 500) });
    throw e;
  }
}

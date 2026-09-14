/**
 * Thin LLM adapter. OpenAI Responses API with structured outputs (zod).
 * The model ID comes from LLM_MODEL in .env so "gpt 5.6 astra" or any other
 * deployment name can be dropped in without a code change. If there is no
 * API key the adapter reports unavailable and callers use heuristics.
 */
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";
import { prisma } from "@/lib/db";

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
 * Run one structured-output call. Never throws: every failure is logged to
 * LlmCall and returned as { ok:false } so the pipeline can degrade gracefully.
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
    await prisma.llmCall.create({
      data: {
        purpose: opts.purpose,
        subject: opts.subject,
        model: cfg.model,
        ok: true,
        durationMs: Date.now() - started,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
      },
    }).catch(() => {});
    return { ok: true, data: parsed, model: cfg.model };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.llmCall.create({
      data: { purpose: opts.purpose, subject: opts.subject, model: cfg.model, ok: false, durationMs: Date.now() - started, error: error.slice(0, 500) },
    }).catch(() => {});
    return { ok: false, error, model: cfg.model };
  }
}

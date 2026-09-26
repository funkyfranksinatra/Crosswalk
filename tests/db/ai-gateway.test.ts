/**
 * The application side of the model boundary (docs/AI_BOUNDARY.md): a model call made through
 * the gateway is recorded in LlmCall by the application — outcome, model, tokens — with no prompt
 * or answer text; the model layer itself writes nothing. Stand-in provider, local database.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { prisma } from "@/lib/db";

const hasDb = Boolean(process.env.DATABASE_URL);
const PURPOSE = `gateway-test-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("model gateway records calls; the model layer does not", () => {
  let server: http.Server;
  const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "r", object: "response", created_at: 0, status: "completed", model: "stand-in", output: [{ type: "message", id: "m", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ answer: "SECRET-ANSWER" }), annotations: [] }] }], usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 } }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.OPENAI_API_KEY = "test-key-not-real";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await prisma.llmCall.deleteMany({ where: { purpose: PURPOSE } });
    await new Promise<void>((ok) => server.close(() => ok()));
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved.base;
  });

  test("a call through the gateway returns the validated answer and leaves one LlmCall row without prompt or answer text", async () => {
    const { structured } = await import("@/lib/ai/gateway");
    const res = await structured({ purpose: PURPOSE, subject: "TT012", system: "SECRET-SYSTEM", user: "SECRET-USER", schema: z.object({ answer: z.string() }), schemaName: "t" });
    expect(res).toMatchObject({ ok: true, data: { answer: "SECRET-ANSWER" } });
    const rows = await prisma.llmCall.findMany({ where: { purpose: PURPOSE } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "TT012", ok: true, inputTokens: 21, outputTokens: 4 });
    expect(JSON.stringify(rows[0])).not.toMatch(/SECRET-/);
  });
});

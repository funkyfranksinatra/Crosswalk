/**
 * The model boundary (docs/AI_BOUNDARY.md): the model layer (src/lib/llm) can reach the model
 * provider and nothing else. It is handed data by the application and hands results back to the
 * application; it never imports the database — directly or through any module it imports — and
 * the application reaches it only through src/lib/ai/gateway.ts.
 *
 * Structural half: walk the real import graph. Behavioural half: drive the client against a
 * local stand-in for the provider and check exactly what leaves the process and what comes back.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/** Packages that are, or open, a database / queue connection. */
const FORBIDDEN_PACKAGES = [/^pg$/, /^pg-boss$/, /^@prisma\//, /^@neondatabase\//, /^postgres$/];
const FORBIDDEN_FILES = [path.join(SRC, "lib/db.ts"), path.join(SRC, "generated/prisma")];

function specifiers(file: string): string[] {
  const src = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out: string[] = [];
  // Runtime imports and re-exports; `import type` / `export type` are erased and cannot open anything.
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;'"]*?from\s*["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]); // dynamic (and inline type) imports, conservatively
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  if (FORBIDDEN_FILES.some((f) => base.startsWith(f))) return base; // generated client: report by path
  return null;
}

/** Every module reachable from `entry`, with the chain that reached it. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    for (const spec of specifiers(file)) {
      const local = resolveLocal(file, spec);
      const key = local ?? `pkg:${spec}`;
      if (seen.has(key)) continue;
      seen.set(key, [...seen.get(file)!, key]);
      if (local) queue.push(local);
    }
  }
  return seen;
}

const rel = (p: string) => (p.startsWith("pkg:") ? p : path.relative(ROOT, p));
const llmFiles = fs.readdirSync(path.join(SRC, "lib/llm")).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(SRC, "lib/llm", f));

describe("model boundary — structure", () => {
  test("the model layer exists and is what we think it is", () => {
    expect(llmFiles.map((f) => path.basename(f)).sort()).toEqual(["client.ts", "tasks.ts"]);
  });

  test.each(llmFiles.map((f) => [path.basename(f), f]))("%s cannot reach the database, the job queue or any module that does", (_name, file) => {
    const violations: string[] = [];
    for (const [key, chain] of reachable(file)) {
      const hit = key.startsWith("pkg:") ? FORBIDDEN_PACKAGES.some((re) => re.test(key.slice(4))) : FORBIDDEN_FILES.some((f) => key.startsWith(f));
      if (hit) violations.push(chain.map(rel).join(" → "));
    }
    expect(violations).toEqual([]);
  });

  test("the application reaches the model layer only through src/lib/ai/gateway.ts", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!["generated", "node_modules"].includes(e.name)) walk(p); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        if (p.startsWith(path.join(SRC, "lib/llm")) || p === path.join(SRC, "lib/ai/gateway.ts")) continue;
        for (const spec of specifiers(p)) {
          const local = resolveLocal(p, spec);
          if (local && local.startsWith(path.join(SRC, "lib/llm"))) offenders.push(`${rel(p)} imports ${spec}`);
        }
      }
    };
    walk(SRC);
    walk(path.join(ROOT, "scripts"));
    expect(offenders).toEqual([]);
  });

  test("the gateway, not the model layer, is where call records are written", () => {
    const gateway = fs.readFileSync(path.join(SRC, "lib/ai/gateway.ts"), "utf8");
    expect(gateway).toMatch(/onModelCall\(/);
    expect(gateway).toMatch(/prisma\.llmCall\.create/);
    for (const f of llmFiles) expect(fs.readFileSync(f, "utf8")).not.toMatch(/\bprisma\b/);
  });
});

describe("model boundary — behaviour against a stand-in provider", () => {
  let server: http.Server;
  let requests: { url: string; body: Record<string, unknown> }[] = [];
  let reply: (url: string) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
  const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        requests.push({ url: req.url ?? "", body: data ? JSON.parse(data) : {} });
        const r = reply(req.url ?? "");
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.OPENAI_API_KEY = "test-key-not-real";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved.base;
  });

  const responseBody = (text: string) => ({
    id: "resp_test", object: "response", created_at: 0, status: "completed", model: "stand-in",
    output: [{ type: "message", id: "msg_test", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
  });

  test("a structured call sends only the two messages it was given and a response schema — no tools — and returns the validated answer to the caller", async () => {
    const { structured, onModelCall } = await import("@/lib/llm/client");
    const records: unknown[] = [];
    onModelCall((r) => { records.push(r); });
    requests = [];
    reply = () => ({ status: 200, body: responseBody(JSON.stringify({ family: "Trocar Products", confident: true })) });
    const res = await structured({ purpose: "boundary-test", subject: "B12LTH", system: "SYSTEM TEXT", user: "USER TEXT", schema: z.object({ family: z.string(), confident: z.boolean() }), schemaName: "t" });
    onModelCall(null);

    expect(res).toMatchObject({ ok: true, data: { family: "Trocar Products", confident: true } });
    expect(requests).toHaveLength(1);
    const body = requests[0].body;
    expect(requests[0].url).toBe("/v1/responses");
    expect(Object.keys(body).sort()).toEqual(["input", "max_output_tokens", "model", "text"]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.input).toEqual([{ role: "system", content: "SYSTEM TEXT" }, { role: "user", content: "USER TEXT" }]);
    expect((body.text as { format: { type: string } }).format.type).toBe("json_schema");
    // The record the application receives carries no prompt or answer text.
    expect(records).toEqual([expect.objectContaining({ kind: "structured", purpose: "boundary-test", subject: "B12LTH", ok: true, inputTokens: 11, outputTokens: 3 })]);
    expect(JSON.stringify(records)).not.toMatch(/SYSTEM TEXT|USER TEXT|Trocar Products/);
  });

  test("an answer that fails the schema never reaches the caller as data; a provider error is returned, not thrown; a broken observer changes nothing", async () => {
    const { structured, onModelCall } = await import("@/lib/llm/client");
    onModelCall(() => { throw new Error("observer down"); });
    reply = () => ({ status: 200, body: responseBody(JSON.stringify({ family: 42 })) });
    const bad = await structured({ purpose: "boundary-test", system: "s", user: "u", schema: z.object({ family: z.string() }), schemaName: "t" });
    expect(bad.ok).toBe(false);
    reply = () => ({ status: 400, body: { error: { message: "bad request", type: "invalid_request_error" } } });
    const err = await structured({ purpose: "boundary-test", system: "s", user: "u", schema: z.object({ family: z.string() }), schemaName: "t" });
    expect(err).toMatchObject({ ok: false });
    onModelCall(null);
  });

  test("embeddings: texts out, vectors back to the caller; the boundary stores nothing", async () => {
    const { embedTexts, onModelCall } = await import("@/lib/llm/client");
    const records: { kind: string; ok: boolean }[] = [];
    onModelCall((r) => { records.push(r); });
    requests = [];
    reply = () => ({ status: 200, body: { object: "list", model: "e", data: [{ object: "embedding", index: 1, embedding: [0, 1] }, { object: "embedding", index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } } });
    const v = await embedTexts(["a", "b"], { model: "e", dimensions: 2, timeoutMs: 5000 });
    onModelCall(null);
    expect(v).toEqual([[1, 0], [0, 1]]);
    expect(requests[0].url).toBe("/v1/embeddings");
    expect(requests[0].body).toMatchObject({ model: "e", input: ["a", "b"], dimensions: 2 });
    expect(records).toEqual([expect.objectContaining({ kind: "embedding", ok: true })]);
  });
});

/**
 * Embedding retrieval (Tier 3.5). Before attribute scoring, the shortlist for a competitor
 * product is the nearest own products by embedding — so a line costs one ANN query instead
 * of an O(catalog) attribute scan. The scan is still the fallback whenever a vector is
 * missing (no key, a product not yet embedded, pgvector absent), and the attribute scorer
 * still ranks whatever retrieval returns: embeddings choose WHO is compared, never HOW.
 *
 * What is embedded is deterministic text built from the bin plus description
 * (`embeddingText`), hashed so unchanged products are never re-embedded. Vectors live in
 * pgvector columns (`OwnProduct.embedding`, `CompetitorProduct.embedding`), written and
 * queried with raw SQL because Prisma has no vector type.
 */
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { prisma } from "@/lib/db";
import { llmConfig } from "@/lib/llm/client";
import { log } from "@/lib/log";
import { counter, histogram } from "@/lib/observability/metrics";
import { parseBin, type Bin } from "./bin";

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;
/** Nearest neighbours fetched per line before attribute scoring (the scorer trims to maxCandidates). */
export const RETRIEVAL_K = Math.max(5, Math.min(200, Number(process.env.EMBEDDING_RETRIEVAL_K ?? 40) || 40));

export const embeddingCalls = counter("crosswalk_embedding_calls_total", "Embedding API calls by outcome");
export const embeddingLatency = histogram("crosswalk_embedding_seconds", "Embedding API latency", [0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

export function embeddingsEnabled(): boolean {
  return (process.env.EMBEDDINGS ?? "on").toLowerCase() !== "off" && llmConfig().available;
}

/** The text a product is embedded as. Stable across runs so the hash is meaningful. */
export function embeddingText(p: { sku?: string | null; brand?: string | null; description?: string | null; category?: string | null; gmdnName?: string | null; binJson?: string | null; bin?: Bin | null }): string {
  const bin = p.bin ?? parseBin(p.binJson, { allowStale: true });
  const parts = [
    p.brand ? `Brand: ${p.brand}` : null,
    p.description ? `Description: ${p.description}` : null,
    p.gmdnName ? `GMDN: ${p.gmdnName}` : null,
    p.category ? `Category: ${p.category}` : null,
    bin ? `Family: ${bin.family}; Type: ${bin.productType}` : null,
    bin?.function ? `Function: ${bin.function}` : null,
    bin && bin.materials.length ? `Materials: ${bin.materials.join(", ")}` : null,
    bin && bin.features.length ? `Features: ${bin.features.join(", ")}` : null,
    bin && bin.dimensions.length ? `Sizes: ${bin.dimensions.map((d) => `${d.name} ${d.value} ${d.unit}`).join("; ")}` : null,
    bin && bin.compatibility.length ? `Platform: ${bin.compatibility.join(", ")}` : null,
  ].filter(Boolean);
  // The SKU last and only as a weak signal: catalog numbers encode sizes/platforms but are not language.
  if (p.sku) parts.push(`Catalog number: ${p.sku}`);
  return parts.join("\n").slice(0, 6000);
}

export const embeddingHash = (text: string) => createHash("sha256").update(`${EMBEDDING_MODEL}\n${text}`).digest("hex");

let client: OpenAI | null = null;
type Embedder = (texts: string[]) => Promise<number[][]>;
let testEmbedder: Embedder | null = null;
/** Tests inject a deterministic embedder; nothing else ever calls the API without a key. */
export function setEmbedderForTests(fn: Embedder | null) { testEmbedder = fn; }

/** Embed a batch of texts. Throws on API failure (callers decide whether that is fatal). */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (testEmbedder) return testEmbedder(texts);
  const cfg = llmConfig();
  if (!cfg.available) throw new Error("OPENAI_API_KEY is not set — embeddings need the model key");
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: cfg.baseURL });
  const t0 = Date.now();
  try {
    const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMS });
    embeddingCalls.inc({ outcome: "ok" });
    embeddingLatency.observe({}, (Date.now() - t0) / 1000);
    // The API returns in index order, but say so explicitly.
    const out = new Array<number[]>(texts.length);
    for (const d of res.data) out[d.index] = d.embedding;
    if (out.some((v) => !v || v.length !== EMBEDDING_DIMS)) throw new Error("embedding response was incomplete");
    return out;
  } catch (e) {
    embeddingCalls.inc({ outcome: "error" });
    embeddingLatency.observe({}, (Date.now() - t0) / 1000);
    throw e;
  }
}

const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(7) : "0")).join(",")}]`;

/** True when the vector extension is installed in this database (checked once per process). */
let vectorAvailable: Promise<boolean> | null = null;
export function pgvectorAvailable(): Promise<boolean> {
  if (!vectorAvailable) {
    vectorAvailable = prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'`).then((r) => (r[0]?.n ?? 0) > 0).catch(() => false);
  }
  return vectorAvailable;
}

type Table = "OwnProduct" | "CompetitorProduct";

/**
 * Embed every row of `table` whose text changed (or that has no vector), in batches.
 * Idempotent and resumable: each batch is written before the next is requested.
 */
export async function refreshEmbeddings(table: Table, opts: { ids?: string[]; limit?: number; batch?: number; onProgress?: (done: number, total: number) => Promise<void> | void } = {}): Promise<{ scanned: number; embedded: number; unchanged: number }> {
  if (!(await pgvectorAvailable())) { log.warn("embeddings.pgvector_missing", { table }); return { scanned: 0, embedded: 0, unchanged: 0 }; }
  const batch = Math.max(1, Math.min(256, opts.batch ?? 64));
  const where = table === "OwnProduct" ? { isActive: true, ...(opts.ids ? { id: { in: opts.ids } } : {}) } : { resolution: { not: "not-found" }, ...(opts.ids ? { id: { in: opts.ids } } : {}) };
  const common = { id: true, brand: true, description: true, category: true, gmdnName: true, binJson: true, embeddingHash: true, embeddingModel: true } as const;
  const rows: { id: string; sku: string; brand: string | null; description: string | null; category: string | null; gmdnName: string | null; binJson: string | null; embeddingHash: string | null; embeddingModel: string | null }[] = table === "OwnProduct"
    ? await prisma.ownProduct.findMany({ where: where as never, select: { ...common, sku: true }, take: opts.limit, orderBy: { updatedAt: "desc" } })
    : (await prisma.competitorProduct.findMany({ where: where as never, select: { ...common, cfnNorm: true }, take: opts.limit, orderBy: { updatedAt: "desc" } })).map((r) => ({ ...r, sku: r.cfnNorm }));
  const pending = rows
    .map((r) => { const text = embeddingText(r); return { id: r.id, text, hash: embeddingHash(text) }; })
    .filter((r, i) => rows[i].embeddingHash !== r.hash || rows[i].embeddingModel !== EMBEDDING_MODEL);
  let embedded = 0;
  for (let i = 0; i < pending.length; i += batch) {
    const slice = pending.slice(i, i + batch);
    const vectors = await embed(slice.map((s) => s.text));
    for (let j = 0; j < slice.length; j++) {
      await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "embedding" = $1::vector, "embeddingHash" = $2, "embeddingModel" = $3, "embeddedAt" = now() WHERE "id" = $4`, vectorLiteral(vectors[j]), slice[j].hash, EMBEDDING_MODEL, slice[j].id);
    }
    embedded += slice.length;
    await opts.onProgress?.(embedded, pending.length);
  }
  if (embedded) log.info("embeddings.refreshed", { table, embedded, unchanged: rows.length - pending.length });
  return { scanned: rows.length, embedded, unchanged: rows.length - pending.length };
}

/** Embed ONE competitor product (called from a run when its vector is missing/stale). Returns the vector. */
export async function ensureCompetitorEmbedding(cp: { id: string; cfnNorm: string; brand: string | null; description: string | null; category: string | null; gmdnName: string | null; binJson: string | null; embeddingHash: string | null; embeddingModel: string | null }): Promise<number[] | null> {
  if (!embeddingsEnabled() || !(await pgvectorAvailable())) return null;
  const text = embeddingText({ ...cp, sku: cp.cfnNorm });
  const hash = embeddingHash(text);
  if (cp.embeddingHash === hash && cp.embeddingModel === EMBEDDING_MODEL) {
    const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT "embedding"::text AS v FROM "CompetitorProduct" WHERE "id" = $1 AND "embedding" IS NOT NULL`, cp.id);
    if (rows[0]?.v) return JSON.parse(rows[0].v) as number[];
  }
  const [vector] = await embed([text]);
  await prisma.$executeRawUnsafe(`UPDATE "CompetitorProduct" SET "embedding" = $1::vector, "embeddingHash" = $2, "embeddingModel" = $3, "embeddedAt" = now() WHERE "id" = $4`, vectorLiteral(vector), hash, EMBEDDING_MODEL, cp.id);
  return vector;
}

export type Neighbour = { id: string; sku: string; similarity: number };

/**
 * Nearest own products to a vector (cosine), optionally restricted to families. Returns []
 * when retrieval is not possible so the caller falls back to the scan.
 */
export async function nearestOwnProducts(vector: number[], opts: { companyId: string; k?: number; families?: string[] | null }): Promise<Neighbour[]> {
  if (!(await pgvectorAvailable())) return [];
  const k = Math.max(1, Math.min(500, opts.k ?? RETRIEVAL_K));
  const fam = opts.families && opts.families.length ? opts.families : null;
  const rows = await prisma.$queryRawUnsafe<{ id: string; sku: string; similarity: number }[]>(
    `SELECT "id", "sku", (1 - ("embedding" <=> $1::vector))::float AS similarity
       FROM "OwnProduct"
      WHERE "companyId" = $2 AND "isActive" = true AND "embedding" IS NOT NULL AND "embeddingModel" = $3
        ${fam ? `AND ("category" = ANY($5::text[]) OR "category" IS NULL)` : ""}
      ORDER BY "embedding" <=> $1::vector
      LIMIT $4`,
    ...(fam ? [vectorLiteral(vector), opts.companyId, EMBEDDING_MODEL, k, fam] : [vectorLiteral(vector), opts.companyId, EMBEDDING_MODEL, k]),
  );
  return rows.map((r) => ({ id: r.id, sku: r.sku, similarity: Number(r.similarity) }));
}

/** How much of the catalog is retrievable — for Settings → System and the alerts. */
export async function embeddingCoverage(companyId?: string): Promise<{ available: boolean; enabled: boolean; model: string; own: { total: number; embedded: number }; competitor: { total: number; embedded: number } }> {
  const available = await pgvectorAvailable();
  const own = await prisma.$queryRawUnsafe<{ total: number; embedded: number }[]>(`SELECT count(*)::int AS total, ${available ? `count("embedding")::int` : "0"} AS embedded FROM "OwnProduct" WHERE "isActive" = true${companyId ? ` AND "companyId" = $1` : ""}`, ...(companyId ? [companyId] : [])).catch(() => [{ total: 0, embedded: 0 }]);
  const comp = await prisma.$queryRawUnsafe<{ total: number; embedded: number }[]>(`SELECT count(*)::int AS total, ${available ? `count("embedding")::int` : "0"} AS embedded FROM "CompetitorProduct" WHERE "resolution" <> 'not-found'`).catch(() => [{ total: 0, embedded: 0 }]);
  return { available, enabled: embeddingsEnabled(), model: EMBEDDING_MODEL, own: own[0] ?? { total: 0, embedded: 0 }, competitor: comp[0] ?? { total: 0, embedded: 0 } };
}

/** Queue an embedding refresh (after imports / catalog edits). Best effort: never fails the caller. */
export async function requestEmbeddingRefresh(table: Table, ids?: string[]): Promise<void> {
  if (!embeddingsEnabled()) return;
  try {
    const { enqueue, jobsEnabled } = await import("@/lib/jobs/boss");
    if (!jobsEnabled()) return;
    // One sweep per table at a time; a targeted refresh carries its ids so a big catalog is not rescanned.
    await enqueue("embed.refresh", { table, ...(ids && ids.length <= 500 ? { ids } : {}) }, { singletonKey: ids && ids.length <= 500 ? `embed:${table}:${createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 12)}` : `embed:${table}` });
  } catch (e) {
    log.warn("embeddings.enqueue_failed", { table, error: e instanceof Error ? e.message : String(e) });
  }
}

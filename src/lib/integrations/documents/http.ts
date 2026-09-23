/**
 * Generic HTTP document-extraction provider — the shape of most commercial document-AI
 * services: POST the file (multipart or base64 JSON) to an endpoint with a key, receive
 * JSON, and read the fields out of it through a response mapping the company configures:
 *
 *   linesPath:      "documents[0].tables[0].rows"        JSON path to the line array
 *   lineFields:     { competitorSku: "cells.sku.value", unitPrice: "cells.price.value", … }
 *   lineConfidence: "cells.sku.confidence"               (or a per-field path)
 *   headerFields:   { accountName: "documents[0].fields.customer.value" }
 *   overallPath:    "documents[0].confidence"
 *
 * A vendor with an SDK-only API gets a subclass that overrides `send`; the mapping stays.
 */
import type { DocumentExtractionProvider, ConnectionTestResult, ExtractionRequest } from "../core/contracts";
import type { ExtractedDocument, ExtractedFieldRecord } from "../types";
import { httpJson } from "../core/http";
import { getPath, applyTransform } from "../core/mapping";
import { ValidationError } from "../core/errors";
import { HEADER_FIELDS, LINE_FIELDS } from "./fields";

export type HttpExtractionConfig = {
  endpoint: string;
  auth: { mode: "bearer"; token: string } | { mode: "api-key"; header: string; key: string } | { mode: "none" };
  encoding: "multipart" | "base64-json";
  /** JSON body fields added alongside the document (model, document type…) */
  extraBody?: Record<string, string>;
  fileField?: string; // multipart field name, default "file"
  model?: string | null;
  response: { linesPath: string; lineFields: Partial<Record<(typeof LINE_FIELDS)[number], string>>; lineConfidencePath?: string | null; fieldConfidenceSuffix?: string | null; headerFields?: Partial<Record<(typeof HEADER_FIELDS)[number], string>>; overallPath?: string | null; pagePath?: string | null };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class HttpExtractionProvider implements DocumentExtractionProvider {
  readonly provider = "http";
  constructor(private cfg: HttpExtractionConfig) {}
  private headers(): Record<string, string> {
    const a = this.cfg.auth;
    return a.mode === "bearer" ? { authorization: `Bearer ${a.token}` } : a.mode === "api-key" ? { [a.header]: a.key } : {};
  }
  async testConnection(): Promise<ConnectionTestResult> {
    // An OPTIONS/HEAD is not universally supported: probe with a GET on the endpoint's origin and treat 401/403 as "reachable, credentials matter at submit time".
    try {
      const u = new URL(this.cfg.endpoint);
      const r = await httpJson<unknown>(`${u.origin}${u.pathname}`, { method: "GET", headers: this.headers() }, { provider: "documents-http", operation: "probe", retries: 0, notFoundOk: true, fetchImpl: this.cfg.fetchImpl });
      return { ok: true, message: `Endpoint reachable (${r.status})`, details: { endpoint: `${u.origin}${u.pathname}` } };
    } catch (e) {
      const msg = (e as Error).message;
      if (/\(40[15]\)|\(400\)|\(422\)/.test(msg)) return { ok: true, message: `Endpoint reachable; it answered ${msg.match(/\((\d{3})\)/)?.[1]} to a probe without a document, which is expected`, details: {} };
      throw e;
    }
  }
  /** Overridable transport. */
  protected async send(req: ExtractionRequest): Promise<unknown> {
    if (!req.bytes) throw new ValidationError("Document extraction needs the file bytes", { retryable: false });
    const headers = this.headers();
    let body: BodyInit;
    if (this.cfg.encoding === "multipart") {
      const fd = new FormData();
      fd.set(this.cfg.fileField ?? "file", new Blob([new Uint8Array(req.bytes)], { type: req.mimeType ?? "application/octet-stream" }), req.filename);
      for (const [k, v] of Object.entries(this.cfg.extraBody ?? {})) fd.set(k, v);
      if (this.cfg.model) fd.set("model", this.cfg.model);
      fd.set("documentType", req.documentType);
      body = fd;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...(this.cfg.extraBody ?? {}), model: this.cfg.model ?? undefined, documentType: req.documentType, filename: req.filename, mimeType: req.mimeType, content: req.bytes.toString("base64") });
    }
    const r = await httpJson<unknown>(this.cfg.endpoint, { method: "POST", headers, body }, { provider: "documents-http", operation: "extract", timeoutMs: this.cfg.timeoutMs ?? 120_000, retries: 1, fetchImpl: this.cfg.fetchImpl });
    return r.body;
  }
  async extract(req: ExtractionRequest): Promise<ExtractedDocument> {
    const body = await this.send(req);
    return mapExtractionResponse(body, this.cfg.response, req.documentType, this.provider, this.cfg.model ?? null);
  }
}

/** Pure: provider JSON → canonical ExtractedDocument through the response mapping. */
export function mapExtractionResponse(body: unknown, r: HttpExtractionConfig["response"], documentType: string, provider: string, model: string | null): ExtractedDocument {
  const lines = getPath(body, r.linesPath);
  if (!Array.isArray(lines)) throw new ValidationError(`Extraction response has no line array at "${r.linesPath}"`, { retryable: false });
  const fields: ExtractedFieldRecord[] = [];
  for (const [name, path] of Object.entries(r.headerFields ?? {})) {
    if (!path) continue;
    const v = getPath(body, path);
    if (v === undefined || v === null) continue;
    fields.push({ scope: "HEADER", field: name, rawValue: String(v), normalizedValue: String(v), confidence: num(getPath(body, `${path}${r.fieldConfidenceSuffix ?? ".confidence"}`)) ?? null });
  }
  lines.forEach((line, i) => {
    const lineConf = r.lineConfidencePath ? num(getPath(line, r.lineConfidencePath)) : null;
    const page = r.pagePath ? num(getPath(line, r.pagePath)) : null;
    for (const [name, path] of Object.entries(r.lineFields)) {
      if (!path) continue;
      const v = getPath(line, path);
      if (v === undefined || v === null || v === "") continue;
      const conf = num(getPath(line, `${path.replace(/\.value$/, "")}${r.fieldConfidenceSuffix ?? ".confidence"}`)) ?? lineConf;
      fields.push({ scope: "LINE", lineNo: i + 1, field: name, rawValue: String(v), normalizedValue: normalise(name, v), confidence: conf, page: page ?? null });
    }
  });
  const overall = r.overallPath ? num(getPath(body, r.overallPath)) : null;
  const confs = fields.map((f) => f.confidence).filter((c): c is number => typeof c === "number");
  return { provider, model, documentType, overallConfidence: overall ?? (confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null), fields, raw: null };
}

function num(v: unknown): number | null { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : null; }
function normalise(field: string, v: unknown): string | null {
  if (field === "quantity") { const n = applyTransform(v, "number"); return n === null || n === undefined ? null : String(n); }
  if (field === "unitPrice" || field === "extendedPrice") { const n = applyTransform(v, "money"); return n === null || n === undefined ? null : String(n); }
  if (field === "lineDate") return (applyTransform(v, "date") as string | null) ?? null;
  return String(v).trim();
}

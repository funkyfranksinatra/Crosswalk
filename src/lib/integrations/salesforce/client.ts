/**
 * A small Salesforce REST client: SOQL with pagination, sObject describe, upsert by external
 * id, and sObject-collection upserts for lines. It re-authenticates once on 401 and turns
 * Salesforce's REQUEST_LIMIT_EXCEEDED (a 403) into a rate-limit error the runner backs off
 * from. Every call goes through the shared HTTP wrapper (timeouts, retries, logs).
 */
import { httpJson, type HttpResult } from "../core/http";
import { AuthenticationError, AuthorizationError, IntegrationError, RateLimitError } from "../core/errors";
import { salesforceToken, type SalesforceAuthConfig, type SalesforceToken } from "./auth";

export type SalesforceClientConfig = { auth: SalesforceAuthConfig; apiVersion: string; fetchImpl?: typeof fetch };
export type SoqlPage<T> = { records: T[]; totalSize: number; done: boolean; nextRecordsUrl: string | null };

export class SalesforceClient {
  constructor(private cfg: SalesforceClientConfig) {}
  private get v() { return `v${this.cfg.apiVersion.replace(/^v/i, "")}`; }

  private async call<T>(path: string, init: RequestInit, operation: string, retriedAuth = false): Promise<HttpResult<T>> {
    const tok: SalesforceToken = await salesforceToken(this.cfg.auth, retriedAuth, this.cfg.fetchImpl);
    const url = path.startsWith("http") ? path : `${tok.instanceUrl}${path}`;
    try {
      return await httpJson<T>(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${tok.accessToken}`, accept: "application/json" } }, { provider: "salesforce", operation, fetchImpl: this.cfg.fetchImpl });
    } catch (e) {
      if (e instanceof AuthenticationError && !retriedAuth) return this.call<T>(path, init, operation, true); // session expired → one refresh
      if (e instanceof AuthorizationError && /REQUEST_LIMIT_EXCEEDED|TotalRequests Limit exceeded/i.test(e.message)) throw new RateLimitError("Salesforce API request limit exceeded for this org (24-hour rolling window)", 15 * 60_000, { providerRef: e.providerRef });
      throw e;
    }
  }

  async limits(): Promise<Record<string, { Max: number; Remaining: number }>> {
    return (await this.call<Record<string, { Max: number; Remaining: number }>>(`/services/data/${this.v}/limits`, { method: "GET" }, "limits")).body;
  }

  async query<T = Record<string, unknown>>(soql: string): Promise<SoqlPage<T>> {
    const r = await this.call<SoqlPage<T>>(`/services/data/${this.v}/query?q=${encodeURIComponent(soql)}`, { method: "GET" }, "query");
    return { ...r.body, nextRecordsUrl: r.body.nextRecordsUrl ?? null };
  }
  async queryMore<T = Record<string, unknown>>(nextRecordsUrl: string): Promise<SoqlPage<T>> {
    const r = await this.call<SoqlPage<T>>(nextRecordsUrl, { method: "GET" }, "queryMore");
    return { ...r.body, nextRecordsUrl: r.body.nextRecordsUrl ?? null };
  }

  /** Field API names of an object (used to validate mappings before a sync). */
  async describeFields(object: string): Promise<string[]> {
    const r = await this.call<{ fields: { name: string; type: string; referenceTo?: string[]; relationshipName?: string | null }[] }>(`/services/data/${this.v}/sobjects/${encodeURIComponent(object)}/describe`, { method: "GET" }, "describe");
    const names = r.body.fields.map((f) => f.name);
    // relationship paths (Owner.Email, Parent.Name) are valid SOQL: expose the relationship names too
    for (const f of r.body.fields) if (f.relationshipName) names.push(f.relationshipName);
    return names;
  }

  /** Upsert one record by an external-id field. 201 = created, 200/204 = updated. */
  async upsert(object: string, externalIdField: string, externalId: string, record: Record<string, unknown>): Promise<{ id: string | null; created: boolean; providerRef: string | null }> {
    const r = await this.call<{ id?: string; created?: boolean; success?: boolean; errors?: unknown[] } | null>(`/services/data/${this.v}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(externalIdField)}/${encodeURIComponent(externalId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(record) }, "upsert");
    if (r.body && r.body.success === false) throw new IntegrationError("VALIDATION", `Salesforce refused the ${object} upsert: ${JSON.stringify(r.body.errors ?? []).slice(0, 300)}`, { retryable: false, providerRef: r.providerRef });
    return { id: r.body?.id ?? null, created: r.status === 201 || r.body?.created === true, providerRef: r.providerRef };
  }

  /** Upsert up to 200 records at once by external id (sObject collections). Partial failures are returned, not thrown. */
  async upsertCollection(object: string, externalIdField: string, records: Record<string, unknown>[]): Promise<{ id: string | null; success: boolean; created: boolean; errors: string[] }[]> {
    const out: { id: string | null; success: boolean; created: boolean; errors: string[] }[] = [];
    for (let i = 0; i < records.length; i += 200) {
      const chunk = records.slice(i, i + 200).map((rec) => ({ attributes: { type: object }, ...rec }));
      const r = await this.call<{ id: string | null; success: boolean; created: boolean; errors: { message: string; statusCode: string }[] }[]>(`/services/data/${this.v}/composite/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(externalIdField)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allOrNone: false, records: chunk }) }, "upsertCollection");
      for (const x of r.body) out.push({ id: x.id ?? null, success: x.success, created: x.created, errors: (x.errors ?? []).map((e) => `${e.statusCode}: ${e.message}`) });
    }
    return out;
  }

  async findIdByExternal(object: string, externalIdField: string, externalId: string): Promise<string | null> {
    const q = await this.query<{ Id: string }>(`SELECT Id FROM ${object} WHERE ${externalIdField} = '${externalId.replace(/'/g, "\\'")}' LIMIT 1`);
    return q.records[0]?.Id ?? null;
  }
}

/** SOQL string literal escaping. */
export const soqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

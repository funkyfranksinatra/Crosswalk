/**
 * A minimal OData client for SAP (Gateway / S/4HANA Cloud APIs), v2 or v4, chosen in
 * configuration. Handles basic or OAuth client-credentials auth, the sap-client header,
 * $filter / $select / $top / $skip and server-driven paging ($skiptoken v2, @odata.nextLink
 * v4), delta links where a service exposes them, and CSRF tokens are not needed for reads.
 * Every call goes through the shared HTTP wrapper.
 */
import { httpJson } from "../core/http";
import { AuthenticationError, ConfigurationError, ValidationError } from "../core/errors";

export type SapAuth = { mode: "basic"; username: string; password: string } | { mode: "oauth"; tokenUrl: string; clientId: string; clientSecret: string; scope?: string | null };
export type ODataConfig = { baseUrl: string; version: "v2" | "v4"; client?: string | null; auth: SapAuth; timeoutMs?: number; fetchImpl?: typeof fetch };

export type ODataPage<T> = { records: T[]; next: string | null; deltaLink: string | null };

const tokens = new Map<string, { token: string; exp: number }>();

export class ODataClient {
  constructor(private cfg: ODataConfig) {
    if (!/^https?:\/\//.test(cfg.baseUrl)) throw new ConfigurationError("SAP OData base URL must start with http(s)://");
  }
  private get base() { return this.cfg.baseUrl.replace(/\/$/, ""); }

  private async authHeader(force = false): Promise<string> {
    const a = this.cfg.auth;
    if (a.mode === "basic") return `Basic ${Buffer.from(`${a.username}:${a.password}`).toString("base64")}`;
    const k = `${a.tokenUrl}|${a.clientId}`;
    const hit = tokens.get(k);
    if (hit && !force && hit.exp > Date.now() + 30_000) return `Bearer ${hit.token}`;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: a.clientId, client_secret: a.clientSecret, ...(a.scope ? { scope: a.scope } : {}) });
    const r = await httpJson<{ access_token?: string; expires_in?: number }>(a.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { provider: "sap", operation: "oauth.token", retries: 1, fetchImpl: this.cfg.fetchImpl });
    if (!r.body?.access_token) throw new AuthenticationError("SAP token endpoint did not return an access token");
    tokens.set(k, { token: r.body.access_token, exp: Date.now() + (r.body.expires_in ?? 3600) * 1000 });
    return `Bearer ${r.body.access_token}`;
  }

  private headers(auth: string): Record<string, string> {
    const h: Record<string, string> = { authorization: auth, accept: "application/json" };
    if (this.cfg.client) h["sap-client"] = this.cfg.client;
    if (this.cfg.version === "v4") h["odata-maxversion"] = "4.0";
    return h;
  }

  /** GET an entity set (or a full next/delta link) and normalise v2/v4 envelopes. */
  async get<T = Record<string, unknown>>(pathOrLink: string, query: Record<string, string | number | undefined> = {}, operation = "get", retriedAuth = false): Promise<ODataPage<T>> {
    const url = pathOrLink.startsWith("http") ? new URL(pathOrLink) : new URL(`${this.base}/${pathOrLink.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    if (this.cfg.version === "v2" && !url.searchParams.has("$format")) url.searchParams.set("$format", "json");
    try {
      const r = await httpJson<unknown>(url, { method: "GET", headers: this.headers(await this.authHeader(retriedAuth)) }, { provider: "sap", operation, timeoutMs: this.cfg.timeoutMs, fetchImpl: this.cfg.fetchImpl });
      return this.normalise<T>(r.body);
    } catch (e) {
      if (e instanceof AuthenticationError && this.cfg.auth.mode === "oauth" && !retriedAuth) return this.get<T>(pathOrLink, query, operation, true);
      throw e;
    }
  }

  private normalise<T>(body: unknown): ODataPage<T> {
    if (!body || typeof body !== "object") throw new ValidationError("SAP answered without an OData envelope", { retryable: false });
    const b = body as Record<string, unknown>;
    if (this.cfg.version === "v2") {
      const d = b.d as Record<string, unknown> | undefined;
      if (!d) throw new ValidationError("SAP v2 answer has no `d` envelope", { retryable: false });
      const results = Array.isArray(d.results) ? d.results : Array.isArray(d) ? d : [d];
      return { records: results as T[], next: (d.__next as string | undefined) ?? null, deltaLink: (d.__delta as string | undefined) ?? null };
    }
    const value = Array.isArray(b.value) ? b.value : [b];
    return { records: value as T[], next: (b["@odata.nextLink"] as string | undefined) ?? null, deltaLink: (b["@odata.deltaLink"] as string | undefined) ?? null };
  }

  /** Service document / metadata reachability — the connection test. */
  async probe(servicePath: string): Promise<{ ok: true; entitySets: string[] }> {
    const url = `${this.base}/${servicePath.replace(/^\//, "").replace(/\/$/, "")}/`;
    const r = await httpJson<unknown>(url, { method: "GET", headers: this.headers(await this.authHeader()) }, { provider: "sap", operation: "probe", timeoutMs: this.cfg.timeoutMs, fetchImpl: this.cfg.fetchImpl });
    const b = r.body as Record<string, unknown> | null;
    let sets: string[] = [];
    if (b && typeof b === "object") {
      const d = (b.d as Record<string, unknown> | undefined) ?? b;
      const es = (d.EntitySets as string[] | undefined) ?? (Array.isArray(d.value) ? (d.value as { name?: string }[]).map((x) => x.name ?? "").filter(Boolean) : []);
      sets = es;
    }
    return { ok: true, entitySets: sets };
  }
}

/** OData $filter literal for a datetime, per version. */
export function odataDateTime(version: "v2" | "v4", d: Date): string {
  return version === "v2" ? `datetime'${d.toISOString().replace(/\.\d{3}Z$/, "")}'` : d.toISOString();
}
export const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

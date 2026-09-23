/**
 * API-based roster adapter: a configurable REST/JSON endpoint (bearer / API-key header /
 * basic auth), a JSON path to the records array, optional next-link or page-number paging,
 * and the same field mapping as the file adapter. This is the shape most member APIs take;
 * a GPO with a bespoke protocol gets a subclass, not a rewrite.
 */
import type { GpoRosterAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { GpoMembershipImportRecord } from "../types";
import { applyMapping, getPath, mergeMapping, type FieldMap } from "../core/mapping";
import { httpJson } from "../core/http";
import { ValidationError } from "../core/errors";
import { MEMBERSHIP_SPEC, type GpoProfile } from "./profiles";

export type ApiAuth = { mode: "bearer"; token: string } | { mode: "api-key"; header: string; key: string } | { mode: "basic"; username: string; password: string } | { mode: "none" };
export type RosterApiConfig = {
  profile: GpoProfile;
  endpoint: string; // full URL of the roster list
  auth: ApiAuth;
  recordsPath?: string | null; // e.g. "data.members" ("" = the body is the array)
  paging?: { mode: "next-link"; path: string } | { mode: "page"; param: string; sizeParam?: string | null; size?: number } | { mode: "none" };
  sinceParam?: string | null; // query param that takes an ISO timestamp for incremental pulls
  mapping: FieldMap;
  extraQuery?: Record<string, string>;
  fetchImpl?: typeof fetch;
};

export class ApiRosterAdapter implements GpoRosterAdapter {
  readonly provider = "api";
  readonly gpoName: string;
  constructor(private cfg: RosterApiConfig) { this.gpoName = cfg.profile.gpoName; }
  private headers(): Record<string, string> {
    const a = this.cfg.auth;
    if (a.mode === "bearer") return { authorization: `Bearer ${a.token}` };
    if (a.mode === "api-key") return { [a.header]: a.key };
    if (a.mode === "basic") return { authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString("base64")}` };
    return {};
  }
  private url(cursor: string | null, since?: Date | null): string {
    if (cursor?.startsWith("link:")) return cursor.slice(5);
    const u = new URL(this.cfg.endpoint);
    for (const [k, v] of Object.entries(this.cfg.extraQuery ?? {})) u.searchParams.set(k, v);
    if (since && this.cfg.sinceParam) u.searchParams.set(this.cfg.sinceParam, since.toISOString());
    if (this.cfg.paging?.mode === "page") { u.searchParams.set(this.cfg.paging.param, cursor?.startsWith("page:") ? cursor.slice(5) : "1"); if (this.cfg.paging.sizeParam) u.searchParams.set(this.cfg.paging.sizeParam, String(this.cfg.paging.size ?? 500)); }
    return u.toString();
  }
  async testConnection(): Promise<ConnectionTestResult> {
    const r = await httpJson<unknown>(this.url(null), { headers: { ...this.headers(), accept: "application/json" } }, { provider: `gpo-${this.cfg.profile.key}`, operation: "roster.probe", fetchImpl: this.cfg.fetchImpl, retries: 0 });
    const list = this.records(r.body);
    const sample = list[0] as Record<string, unknown> | undefined;
    const keys = sample ? Object.keys(sample) : [];
    const missing = Object.entries(this.cfg.mapping).filter(([, rule]) => rule.source && sample && getPath(sample, rule.source) === undefined).map(([k, rule]) => `${k} ← "${rule.source}"`);
    if (missing.length) return { ok: false, message: `${this.cfg.profile.gpoName} API answered (${list.length} records on the first page) but these mapped fields are not in the records: ${missing.join(", ")}; record keys: ${keys.slice(0, 12).join(", ")}`, details: { keys } };
    return { ok: true, message: `${this.cfg.profile.gpoName} API answered: ${list.length} records on the first page`, details: { keys, providerRef: r.providerRef } };
  }
  private records(body: unknown): unknown[] {
    const v = this.cfg.recordsPath ? getPath(body, this.cfg.recordsPath) : body;
    if (!Array.isArray(v)) throw new ValidationError(`${this.cfg.profile.gpoName} API: no array at "${this.cfg.recordsPath || "(root)"}" in the response`, { retryable: false });
    return v;
  }
  async fetchMemberships(opts?: PullOptions): Promise<Page<GpoMembershipImportRecord>> {
    const r = await httpJson<unknown>(this.url(opts?.cursor ?? null, opts?.since), { headers: { ...this.headers(), accept: "application/json" } }, { provider: `gpo-${this.cfg.profile.key}`, operation: "roster.list", fetchImpl: this.cfg.fetchImpl });
    const list = this.records(r.body);
    const map = mergeMapping(this.cfg.profile.fileMapping, this.cfg.mapping);
    const rejected: { externalId: string | null; message: string }[] = [];
    const records = list.flatMap((raw, i) => {
      const m = applyMapping<Record<string, unknown>>(raw, map, MEMBERSHIP_SPEC);
      const errors = m.issues.filter((x) => x.level === "error");
      const rec = m.record;
      if (errors.length) { rejected.push({ externalId: (rec.externalMembershipId as string) ?? `api#${i}`, message: `${this.cfg.profile.gpoName} record ${i + 1}: ${errors.map((e) => e.message).join("; ")}` }); return []; }
      return [{ gpoName: this.cfg.profile.gpoName, gpoCode: this.cfg.profile.gpoCode, accountExternalId: (rec.accountExternalId as string) ?? null, accountNumber: (rec.accountNumber as string) ?? null, externalMembershipId: (rec.externalMembershipId as string) ?? null, memberName: (rec.memberName as string) ?? null, address: rec.addressLine1 || rec.city ? { line1: (rec.addressLine1 as string) ?? null, city: (rec.city as string) ?? null, region: (rec.region as string) ?? null, postalCode: (rec.postalCode as string) ?? null, country: (rec.country as string) ?? null } : null, tier: (rec.tier as string) ?? null, effectiveFrom: String(rec.effectiveFrom), effectiveTo: (rec.effectiveTo as string) ?? null, lastVerifiedAt: (rec.lastVerifiedAt as string) ?? null, source: "gpo-feed", provenance: { provider: "api", sourceSystem: this.cfg.profile.key, sourceRecordId: (rec.externalMembershipId as string) ?? `api#${i}`, meta: { endpoint: this.cfg.endpoint.replace(/\?.*$/, "") } } } as GpoMembershipImportRecord];
    });
    let next: string | null = null;
    const p = this.cfg.paging;
    if (p?.mode === "next-link") { const link = getPath(r.body, p.path); next = typeof link === "string" && link ? `link:${link}` : null; }
    else if (p?.mode === "page") { const page = opts?.cursor?.startsWith("page:") ? Number(opts.cursor.slice(5)) : 1; next = list.length >= (p.size ?? 500) ? `page:${page + 1}` : null; }
    return { records, nextCursor: next, rejected };
  }
}

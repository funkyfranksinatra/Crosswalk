/**
 * Salesforce CRMAdapter. Reads accounts, opportunities, contacts and (optionally) a separate
 * GPO-affiliation object through SOQL built from the company's field map; incremental by
 * LastModifiedDate; writes quotes and lines by external id so a retry after a timeout updates
 * the same records. No pricing logic lives here — it ships what the proposal already decided.
 */
import type { CRMAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { AccountImportRecord, OpportunityImportRecord, ContactImportRecord, GpoAffiliationRecord, QuoteWriteback, QuoteWritebackResult } from "../types";
import { applyMapping, mergeMapping, type FieldMap, type MappingBundle } from "../core/mapping";
import { ConfigurationError, MappingError, ValidationError } from "../core/errors";
import { SalesforceClient, soqlString } from "./client";
import type { SalesforceAuthConfig } from "./auth";
import { ACCOUNT_SPEC, OPPORTUNITY_SPEC, CONTACT_SPEC, SALESFORCE_DEFAULT_MAPPING, soqlFields } from "./mapping";

export type SalesforceAdapterConfig = {
  auth: SalesforceAuthConfig;
  apiVersion: string;
  mapping: MappingBundle;
  /** object names the company agreed on */
  quoteObject: string;
  quoteLineObject: string;
  /** optional separate affiliation object: { object, accountField, gpoField, tierField, fromField, toField } */
  gpoAffiliation?: { object: string; accountField: string; gpoField: string; tierField?: string | null; fromField?: string | null; toField?: string | null } | null;
  /** extra SOQL WHERE for accounts (e.g. "RecordType.Name = 'Hospital'") */
  accountFilter?: string | null;
  pageSize?: number;
  fetchImpl?: typeof fetch;
};

const PROVIDER = "salesforce";

export class SalesforceAdapter implements CRMAdapter {
  readonly provider = PROVIDER;
  private client: SalesforceClient;
  constructor(private cfg: SalesforceAdapterConfig) {
    if (!cfg.quoteObject || !cfg.quoteLineObject) throw new ConfigurationError("Salesforce quote and quote-line object names are required");
    this.client = new SalesforceClient({ auth: cfg.auth, apiVersion: cfg.apiVersion, fetchImpl: cfg.fetchImpl });
  }

  private map(entity: string): FieldMap { return mergeMapping(SALESFORCE_DEFAULT_MAPPING[entity] ?? {}, this.cfg.mapping[entity]); }
  private fieldName(entity: "Quote" | "QuoteLine", key: string): string | null { const r = this.map(entity)[key]; return (r?.constant as string | undefined) ?? r?.source ?? null; }

  async testConnection(): Promise<ConnectionTestResult> {
    const limits = await this.client.limits();
    const api = limits.DailyApiRequests;
    const details: Record<string, unknown> = { dailyApiRequests: api ? `${api.Remaining} of ${api.Max} remaining` : "n/a" };
    const missing: string[] = [];
    for (const [entity, object] of [["Account", "Account"], ["Opportunity", "Opportunity"], ["Quote", this.cfg.quoteObject], ["QuoteLine", this.cfg.quoteLineObject]] as const) {
      try {
        const fields = await this.client.describeFields(object);
        details[object] = `${fields.length} fields`;
        const map = this.map(entity);
        for (const [k, rule] of Object.entries(map)) {
          const path = entity === "Quote" || entity === "QuoteLine" ? (rule.constant as string | undefined) : rule.source;
          if (!path) continue;
          const head = path.split(".")[0];
          if (!fields.some((f) => f.toLowerCase() === path.toLowerCase() || f.toLowerCase() === head.toLowerCase())) missing.push(`${entity}.${k} → "${path}" does not exist on ${object}`);
        }
      } catch (e) { details[object] = `describe failed: ${(e as Error).message}`; missing.push(`${object}: ${(e as Error).message}`); }
    }
    if (this.cfg.gpoAffiliation?.object) { try { await this.client.describeFields(this.cfg.gpoAffiliation.object); details[this.cfg.gpoAffiliation.object] = "ok"; } catch (e) { missing.push(`GPO affiliation object ${this.cfg.gpoAffiliation.object}: ${(e as Error).message}`); } }
    if (missing.length) return { ok: false, message: `Salesforce connection succeeded, but the mapping does not fit this org: ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`, details };
    return { ok: true, message: `Connected to ${this.cfg.auth.loginUrl} (API ${this.cfg.apiVersion}); ${Object.keys(details).length - 1} objects described, mapping fits`, details };
  }

  async describeFields(entity: string): Promise<string[] | null> {
    const object = entity === "Quote" ? this.cfg.quoteObject : entity === "QuoteLine" ? this.cfg.quoteLineObject : entity;
    try { return await this.client.describeFields(object); } catch { return null; }
  }

  private async pull<T>(entity: "Account" | "Opportunity" | "Contact", spec: typeof ACCOUNT_SPEC, opts: PullOptions | undefined, extraWhere?: string | null): Promise<Page<T>> {
    const map = this.map(entity);
    const cursor = opts?.cursor ?? null;
    let page;
    if (cursor?.startsWith("more:")) page = await this.client.queryMore(cursor.slice(5));
    else {
      const where: string[] = [];
      if (opts?.since) where.push(`LastModifiedDate > ${opts.since.toISOString()}`);
      if (extraWhere) where.push(`(${extraWhere})`);
      const soql = `SELECT ${soqlFields(map).join(", ")} FROM ${entity}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY LastModifiedDate ASC${opts?.limit ? ` LIMIT ${Math.min(opts.limit, 2000)}` : ""}`;
      page = await this.client.query(soql);
    }
    const records: T[] = [];
    for (const raw of page.records) {
      const m = applyMapping<Record<string, unknown>>(raw, map, spec);
      const errors = m.issues.filter((i) => i.level === "error");
      if (errors.length) throw new MappingError(`${entity} ${String((raw as Record<string, unknown>).Id ?? "?")}: ${errors.map((e) => e.message).join("; ")}`, { retryable: false });
      const { sourceUpdatedAt, ...rest } = m.record;
      records.push({ ...rest, provenance: { provider: PROVIDER, sourceSystem: "salesforce", sourceRecordId: String(rest.externalId), sourceUpdatedAt: (sourceUpdatedAt as string | undefined) ?? null, meta: { object: entity } } } as T);
    }
    return { records, nextCursor: page.done || !page.nextRecordsUrl ? null : `more:${page.nextRecordsUrl}` };
  }

  fetchAccounts(opts?: PullOptions) { return this.pull<AccountImportRecord>("Account", ACCOUNT_SPEC, opts, this.cfg.accountFilter); }
  fetchOpportunities(opts?: PullOptions) { return this.pull<OpportunityImportRecord>("Opportunity", OPPORTUNITY_SPEC, opts); }
  fetchContacts(opts?: PullOptions) { return this.pull<ContactImportRecord>("Contact", CONTACT_SPEC, opts); }

  async fetchGpoAffiliations(opts?: PullOptions): Promise<Page<GpoAffiliationRecord>> {
    const g = this.cfg.gpoAffiliation;
    if (!g?.object) return { records: [], nextCursor: null };
    const fields = ["Id", g.accountField, g.gpoField, g.tierField, g.fromField, g.toField, "LastModifiedDate"].filter((x): x is string => Boolean(x));
    const cursor = opts?.cursor ?? null;
    const page = cursor?.startsWith("more:") ? await this.client.queryMore(cursor.slice(5)) : await this.client.query(`SELECT ${[...new Set(fields)].join(", ")} FROM ${g.object}${opts?.since ? ` WHERE LastModifiedDate > ${opts.since.toISOString()}` : ""} ORDER BY LastModifiedDate ASC`);
    const records = page.records.map((r) => {
      const rec = r as Record<string, unknown>;
      const get = (p: string | null | undefined) => (p ? (p.includes(".") ? p.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), rec) : rec[p]) : undefined);
      return { accountExternalId: String(get(g.accountField) ?? ""), gpoName: String(get(g.gpoField) ?? ""), gpoTier: (get(g.tierField) as string | undefined) ?? null, effectiveFrom: (get(g.fromField) as string | undefined) ?? null, effectiveTo: (get(g.toField) as string | undefined) ?? null, provenance: { provider: PROVIDER, sourceSystem: "salesforce", sourceRecordId: String(rec.Id), sourceUpdatedAt: (rec.LastModifiedDate as string) ?? null, meta: { object: g.object } } };
    }).filter((x) => x.accountExternalId && x.gpoName);
    return { records, nextCursor: page.done || !page.nextRecordsUrl ? null : `more:${page.nextRecordsUrl}` };
  }

  async createOrUpdateQuote(q: QuoteWriteback): Promise<QuoteWritebackResult> {
    const f = (k: string) => this.fieldName("Quote", k);
    const lf = (k: string) => this.fieldName("QuoteLine", k);
    const extField = f("externalIdField"), nameField = f("name"), accountField = f("accountField");
    if (!extField || !nameField || !accountField) throw new ConfigurationError("Quote mapping needs externalIdField, name and accountField");
    if (!/^[0-9A-Za-z]{15,18}$/.test(q.accountExternalId)) throw new ValidationError(`Proposal ${q.reference}: the account is not linked to a Salesforce record (sync accounts first)`, { retryable: false });
    const body: Record<string, unknown> = { [nameField]: `${q.reference} — Crosswalk quote`, [accountField]: q.accountExternalId };
    const set = (k: string, v: unknown) => { const name = f(k); if (name && v !== undefined && v !== null) body[name] = v; };
    set("opportunityField", q.opportunityExternalId ?? undefined);
    set("statusField", q.proposalStatus); set("approvalStatusField", q.approvalStatus); set("totalField", Number(q.contractValue));
    set("currencyField", q.currency); set("validThroughField", q.validThrough ? q.validThrough.slice(0, 10) : undefined);
    set("savingsField", q.customerSavings ? Number(q.customerSavings) : undefined); set("marginField", q.blendedMarginPct ? Number(q.blendedMarginPct) : undefined);
    set("referenceField", q.reference);
    for (const [k, v] of Object.entries(q.metadata ?? {})) if (/^[A-Za-z][A-Za-z0-9_]*__c$/.test(k)) body[k] = v;
    const up = await this.client.upsert(this.cfg.quoteObject, extField, q.idempotencyKey, body);
    const quoteId = up.id ?? (await this.client.findIdByExternal(this.cfg.quoteObject, extField, q.idempotencyKey));
    if (!quoteId) throw new ValidationError(`Salesforce accepted the quote upsert but returned no Id for ${q.reference}`, { retryable: false });
    const lineExt = lf("externalIdField"), quoteRef = lf("quoteField"), skuField = lf("skuField");
    const lineIds: string[] = [];
    if (lineExt && quoteRef && skuField && q.lines.length) {
      const lines = q.lines.map((l, i) => {
        const rec: Record<string, unknown> = { [lineExt]: `${q.idempotencyKey}-${i + 1}`, [quoteRef]: quoteId, [skuField]: l.sku ?? "" };
        const s = (k: string, v: unknown) => { const name = lf(k); if (name && v !== undefined && v !== null) rec[name] = v; };
        s("descriptionField", l.description); s("competitorCodeField", l.competitorCode); s("quantityField", Number(l.quantity)); s("unitPriceField", l.unitPrice ? Number(l.unitPrice) : undefined);
        s("matchTypeField", l.matchType); s("equivalenceField", l.equivalenceLevel); s("approvalStateField", l.approvalState); s("lineNoField", i + 1);
        return rec;
      });
      const results = await this.client.upsertCollection(this.cfg.quoteLineObject, lineExt, lines);
      const failed = results.filter((r) => !r.success);
      if (failed.length) throw new ValidationError(`Quote ${q.reference} was written but ${failed.length} of ${results.length} lines were refused: ${failed[0].errors.join("; ")}`, { retryable: false });
      for (const r of results) if (r.id) lineIds.push(r.id);
    }
    return { externalId: quoteId, created: up.created, lineExternalIds: lineIds, providerRef: up.providerRef };
  }

  /** Small helper for webhook-driven targeted pulls. */
  async fetchAccountsByIds(ids: string[]): Promise<AccountImportRecord[]> {
    if (!ids.length) return [];
    const map = this.map("Account");
    const page = await this.client.query(`SELECT ${soqlFields(map).join(", ")} FROM Account WHERE Id IN (${ids.slice(0, 200).map(soqlString).join(", ")})`);
    return page.records.map((raw) => { const m = applyMapping<Record<string, unknown>>(raw, map, ACCOUNT_SPEC); const { sourceUpdatedAt, ...rest } = m.record; return { ...rest, provenance: { provider: PROVIDER, sourceSystem: "salesforce", sourceRecordId: String(rest.externalId), sourceUpdatedAt: (sourceUpdatedAt as string) ?? null } } as AccountImportRecord; });
  }
}

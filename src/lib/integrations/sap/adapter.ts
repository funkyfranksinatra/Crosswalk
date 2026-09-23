/**
 * SAP ERPAdapter over OData. Each business read is a configurable service + entity set
 * (companies expose different ones); the company's plant → region table, condition-type
 * filter and field maps turn SAP rows into canonical ProductImportRecord /
 * StandardCostImportRecord / PriceEntryImportRecord / BillingImportRecord. Pages follow the
 * service's own next link; incremental reads filter on a configured change-date field.
 */
import type { ERPAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { ProductImportRecord, StandardCostImportRecord, PriceEntryImportRecord, BillingImportRecord } from "../types";
import { applyMapping, mergeMapping, type FieldMap, type MappingBundle } from "../core/mapping";
import { ConfigurationError, MappingError } from "../core/errors";
import { ODataClient, odataDateTime, type ODataConfig } from "./odata";
import { MATERIAL_SPEC, COST_SPEC, PRICE_SPEC, BILLING_SPEC, SAP_DEFAULT_MAPPING } from "./mapping";

export type SapService = { service: string; entitySet: string; changeDateField?: string | null; filter?: string | null; pageSize?: number };
export type SapAdapterConfig = {
  odata: ODataConfig;
  companyCode?: string | null;
  services: { materials: SapService; costs?: SapService | null; prices?: SapService | null; billing?: SapService | null };
  /** plant → region (canonical region for cost context) */
  plantRegions: Record<string, string>;
  /** condition types that mean "list price" (others are ignored); empty = accept all */
  listConditionTypes: string[];
  mapping: MappingBundle;
};

const PROVIDER = "odata";

export class SapAdapter implements ERPAdapter {
  readonly provider = PROVIDER;
  private client: ODataClient;
  constructor(private cfg: SapAdapterConfig) {
    if (!cfg.services.materials?.service || !cfg.services.materials.entitySet) throw new ConfigurationError("SAP material service and entity set are required");
    this.client = new ODataClient(cfg.odata);
  }
  private map(entity: string): FieldMap { return mergeMapping(SAP_DEFAULT_MAPPING[entity] ?? {}, this.cfg.mapping[entity]); }

  async testConnection(): Promise<ConnectionTestResult> {
    const details: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const [name, svc] of Object.entries(this.cfg.services)) {
      if (!svc) continue;
      try {
        const p = await this.client.probe(svc.service);
        details[name] = p.entitySets.length ? `${svc.service}: ${p.entitySets.length} entity sets` : `${svc.service}: reachable`;
        if (p.entitySets.length && !p.entitySets.includes(svc.entitySet)) problems.push(`${name}: entity set "${svc.entitySet}" is not in ${svc.service} (has ${p.entitySets.slice(0, 6).join(", ")}${p.entitySets.length > 6 ? "…" : ""})`);
        else { const one = await this.client.get(`${svc.service}/${svc.entitySet}`, { $top: 1 }, `${name}.sample`); details[`${name}Sample`] = one.records.length ? Object.keys(one.records[0] as object).length + " fields" : "empty set"; if (one.records.length) { const fields = Object.keys(one.records[0] as object); for (const [k, rule] of Object.entries(this.map(ENTITY[name as keyof typeof ENTITY]))) if (rule.source && !fields.includes(rule.source.split("/")[0].split(".")[0])) problems.push(`${name}: mapped field "${rule.source}" (${k}) is not in the first ${svc.entitySet} record`); } }
      } catch (e) { problems.push(`${name}: ${(e as Error).message}`); }
    }
    if (problems.length) return { ok: false, message: `SAP reached, but: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` (+${problems.length - 4})` : ""}`, details };
    return { ok: true, message: `Connected to ${this.cfg.odata.baseUrl} (OData ${this.cfg.odata.version}); ${Object.keys(details).filter((k) => !k.endsWith("Sample")).length} services reachable`, details };
  }

  async describeFields(entity: string): Promise<string[] | null> {
    const key = (Object.entries(ENTITY).find(([, e]) => e === entity)?.[0] ?? null) as keyof typeof ENTITY | null;
    const svc = key ? this.cfg.services[key] : null;
    if (!svc) return null;
    try { const one = await this.client.get(`${svc.service}/${svc.entitySet}`, { $top: 1 }, "describe"); return one.records.length ? Object.keys(one.records[0] as object) : null; } catch { return null; }
  }

  private async pull<T>(name: keyof typeof ENTITY, spec: typeof MATERIAL_SPEC, opts: PullOptions | undefined, finish: (rec: Record<string, unknown>, raw: Record<string, unknown>) => T | null): Promise<Page<T>> {
    const svc = this.cfg.services[name];
    if (!svc) return { records: [], nextCursor: null };
    const map = this.map(ENTITY[name]);
    const filters: string[] = [];
    if (svc.filter) filters.push(`(${svc.filter})`);
    if (opts?.since && svc.changeDateField) filters.push(`${svc.changeDateField} gt ${odataDateTime(this.cfg.odata.version, opts.since)}`);
    const page = opts?.cursor?.startsWith("link:") ? await this.client.get(opts.cursor.slice(5), {}, `${name}.next`) : await this.client.get(`${svc.service}/${svc.entitySet}`, { $filter: filters.join(" and ") || undefined, $top: svc.pageSize ?? opts?.limit ?? 500 }, `${name}.list`);
    const records: T[] = [];
    for (const raw of page.records) {
      const m = applyMapping<Record<string, unknown>>(raw, map, spec);
      const errors = m.issues.filter((i) => i.level === "error");
      if (errors.length) throw new MappingError(`${ENTITY[name]} ${String((raw as Record<string, unknown>)[map.sku?.source ?? "Product"] ?? "?")}: ${errors.map((e) => e.message).join("; ")}`, { retryable: false });
      const out = finish(m.record, raw as Record<string, unknown>);
      if (out) records.push(out);
    }
    return { records, nextCursor: page.next ? `link:${page.next}` : null };
  }

  fetchMaterials(opts?: PullOptions) {
    return this.pull<ProductImportRecord>("materials", MATERIAL_SPEC, opts, (r) => ({ sku: String(r.sku), description: String(r.description), productFamily: (r.productFamily as string) ?? null, uom: (r.uom as string) ?? undefined, listPrice: (r.listPrice as string) ?? null, currency: (r.currency as string) ?? undefined, status: (r.status as string) ?? null, discontinued: Boolean(r.discontinued), provenance: { provider: PROVIDER, sourceSystem: "sap", sourceRecordId: String(r.sku), sourceUpdatedAt: (r.sourceUpdatedAt as string) ?? null, meta: { entitySet: this.cfg.services.materials.entitySet } } }));
  }
  fetchStandardCosts(opts?: PullOptions) {
    return this.pull<StandardCostImportRecord>("costs", COST_SPEC, opts, (r) => {
      const unit = Number(r.priceUnit ?? 1) || 1;
      const cost = (Number(r.cost) / unit).toFixed(6);
      const plant = (r.plant as string | undefined) ?? null;
      return { sku: String(r.sku), plant, region: plant ? this.cfg.plantRegions[plant] ?? this.cfg.plantRegions["*"] ?? null : null, currency: (r.currency as string) ?? "USD", costType: (r.costType as string) ?? "STANDARD", cost, effectiveFrom: String(r.effectiveFrom), effectiveTo: (r.effectiveTo as string) ?? null, provenance: { provider: PROVIDER, sourceSystem: "sap", sourceRecordId: `${r.sku}|${plant ?? ""}|${r.effectiveFrom}`, meta: { entitySet: this.cfg.services.costs?.entitySet, priceUnit: unit } } };
    });
  }
  fetchListPrices(opts?: PullOptions) {
    return this.pull<PriceEntryImportRecord>("prices", PRICE_SPEC, opts, (r) => {
      const ct = (r.conditionType as string | undefined) ?? null;
      if (this.cfg.listConditionTypes.length && ct && !this.cfg.listConditionTypes.includes(ct)) return null;
      return { sku: String(r.sku), price: String(r.price), currency: (r.currency as string) ?? "USD", pricebook: (r.pricebook as string) ?? null, conditionType: ct, effectiveFrom: String(r.effectiveFrom), effectiveTo: (r.effectiveTo as string) ?? null, uom: (r.uom as string) ?? null, minQty: r.minQty !== undefined ? String(r.minQty) : null, provenance: { provider: PROVIDER, sourceSystem: "sap", sourceRecordId: `${r.sku}|${ct ?? ""}|${r.pricebook ?? ""}|${r.effectiveFrom}`, meta: { entitySet: this.cfg.services.prices?.entitySet } } };
    });
  }
  fetchBillingDocuments(opts?: PullOptions) {
    return this.pull<BillingImportRecord>("billing", BILLING_SPEC, opts, (r, raw) => {
      const item = raw.BillingDocumentItem ?? raw.Item ?? "";
      const qty = Number(r.quantity);
      // NetAmount is the item's net value; per-unit is what the purchase record stores
      const perUnit = qty > 0 && raw.NetAmount !== undefined && Number(r.netPrice) === Number(raw.NetAmount) ? (Number(r.netPrice) / qty).toFixed(6) : String(r.netPrice);
      return { externalId: `${r.externalId}${item ? `-${item}` : ""}`, accountExternalId: (r.accountExternalId as string) ?? null, accountNumber: (r.accountNumber as string) ?? null, sku: String(r.sku), quantity: String(qty), netPrice: perUnit, currency: (r.currency as string) ?? "USD", invoiceDate: String(r.invoiceDate), contractNumber: (r.contractNumber as string) ?? null, provenance: { provider: PROVIDER, sourceSystem: "sap", sourceRecordId: `${r.externalId}${item ? `-${item}` : ""}`, meta: { entitySet: this.cfg.services.billing?.entitySet } } };
    });
  }
}

const ENTITY = { materials: "Material", costs: "StandardCost", prices: "PriceCondition", billing: "BillingDocument" } as const;

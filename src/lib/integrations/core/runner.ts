/**
 * The sync runner: one entry point for schedules, the admin UI, webhooks and the CLI.
 *
 *   runSync(key, syncType, trigger, actorUserId, opts)
 *     → reads + validates the configuration (disabled / unconfigured integrations refuse)
 *     → opens an IntegrationSyncJob, builds the adapter
 *     → pulls page by page (provider cursors stay inside the run; the *since* watermark is the
 *       cross-run cursor), writes through the domain writers, records row errors and reviews
 *     → closes the job SUCCEEDED / PARTIAL / FAILED and updates the integration's health
 *
 * A failed row never stops the run; a failed *connection* fails the run and leaves the
 * watermark where it was, so the next run picks the rows up again (writers are idempotent).
 */
import { log } from "@/lib/log";
import { audit } from "@/lib/audit";
import { readConfig, setCursor, getCursor, type IntegrationKey, type ResolvedConfig } from "./config";
import { startJob, finishJob, failJob, type JobContext, type SyncTrigger, type SyncStatus } from "./jobs";
import { recordSyncOutcome, recordTest } from "./health";
import { INTEGRATIONS, definition, buildCrm, buildErp, buildGpoRoster, buildFx, buildContractPrices, buildAny, cfgRead, effectiveMapping, type BuildOptions } from "./registry";
import { ConfigurationError, ValidationError, asIntegrationError, IntegrationError } from "./errors";
import type { Page, PullOptions, ConnectionTestResult } from "./contracts";
import { writeAccount, writeOpportunity, writeContacts, writeGpoAffiliation, writeProduct, writeStandardCost, writeListPrice, writeBilling } from "./writers";
import { validateMapping, type MappingIssue } from "./mapping";

export type RunOptions = { queueJobId?: string | null; /** ignore the since-watermark and pull everything */ full?: boolean; upload?: { filename: string; buffer: Buffer } | null; /** cap pages for a "sync a test record" run */ maxPages?: number; fetchImpl?: typeof fetch };
export type RunResult = { jobId: string; status: SyncStatus; counters: JobContext["counters"]; report: unknown; error?: { message: string; category: string; retryable: boolean } };

const MAX_PAGES = 10_000;

export async function loadEnabledConfig(k: IntegrationKey): Promise<ResolvedConfig> {
  const cfg = await readConfig(k);
  if (!cfg) throw new ConfigurationError(`${INTEGRATIONS[k].label} is not configured — set it up under Settings → Integrations`);
  if (!cfg.enabled) throw new ConfigurationError(`${INTEGRATIONS[k].label} is disabled`);
  return cfg;
}

export async function runSync(k: IntegrationKey, syncType: string, trigger: SyncTrigger, actorUserId: string | null, opts: RunOptions = {}): Promise<RunResult> {
  const def = await definition(k);
  const st = def.syncTypes.find((s) => s.id === syncType);
  if (!st) throw new ConfigurationError(`${def.label} has no "${syncType}" sync (available: ${def.syncTypes.map((s) => s.id).join(", ") || "none"})`);
  if (opts.upload && !st.acceptsUpload) throw new ConfigurationError(`${def.label} · ${st.label} does not take an uploaded file`);
  const cfg = await loadEnabledConfig(k);
  const since = opts.full || opts.upload ? null : parseSince(await getCursor(k, syncType));
  const ctx = await startJob(k, cfg.provider, syncType, trigger, actorUserId, { queueJobId: opts.queueJobId ?? null, cursorBefore: since?.toISOString() ?? null, mappingVersion: cfg.configVersion });
  const startedAt = new Date();
  const build: BuildOptions = { upload: opts.upload ?? null, fetchImpl: opts.fetchImpl };
  try {
    let report: unknown;
    switch (def.family) {
      case "crm": report = await runCrm(ctx, cfg, syncType, since, opts, build); break;
      case "erp": report = await runErp(ctx, cfg, syncType, since, opts, build); break;
      case "gpo": report = await runGpo(ctx, cfg, since, opts, build); break;
      case "fx": report = await runFx(ctx, cfg, build); break;
      case "contracts": report = await runContracts(ctx, cfg, opts, build); break;
      default: throw new ConfigurationError(`${def.label} has nothing to sync`);
    }
    // the watermark moves only after a run that reached the end (partial rows are retried by hash on the next run)
    if (!opts.upload && !opts.maxPages && !ctx.capped) { ctx.cursorAfter = JSON.stringify({ since: startedAt.toISOString() }); await setCursor(k, syncType, ctx.cursorAfter); }
    const status = await finishJob(ctx, report);
    await recordSyncOutcome(k, status === "PARTIAL" ? "PARTIAL" : "SUCCEEDED", status === "PARTIAL" ? { message: `${ctx.counters.errored} rows could not be applied`, category: "VALIDATION", retryable: false } : null);
    await audit({ actorUserId, entityType: "Integration", entityId: k, action: "SYNC", context: { syncType, trigger, jobId: ctx.jobId, status, ...ctx.counters } });
    return { jobId: ctx.jobId, status, counters: ctx.counters, report };
  } catch (e) {
    const err = await failJob(ctx, e);
    await recordSyncOutcome(k, "FAILED", err);
    await audit({ actorUserId, entityType: "Integration", entityId: k, action: "SYNC_FAILED", context: { syncType, trigger, jobId: ctx.jobId, category: err.category, error: err.message } });
    return { jobId: ctx.jobId, status: "FAILED", counters: ctx.counters, report: null, error: err };
  }
}

function parseSince(cursor: string | null): Date | null {
  if (!cursor) return null;
  try { const v = JSON.parse(cursor) as { since?: string }; const d = v.since ? new Date(v.since) : null; return d && !isNaN(+d) ? d : null; } catch { return null; }
}

/** Walk a paged reader; the callback applies each record and reports its own errors through ctx. */
async function eachPage<T>(ctx: JobContext, entity: string, read: (o: PullOptions) => Promise<Page<T>>, since: Date | null, maxPages: number | undefined, apply: (r: T) => Promise<unknown>, idOf: (r: T) => string | null) {
  let cursor: string | null = null; let pages = 0;
  do {
    const page: Page<T> = await read({ since, cursor });
    pages++;
    ctx.received(page.records.length + (page.rejected?.length ?? 0));
    for (const r of page.rejected ?? []) ctx.rowError(entity, r.externalId, new ValidationError(r.message), r.externalId);
    for (const r of page.records) {
      try { await apply(r); } catch (e) { ctx.rowError(entity, idOf(r), e); }
    }
    cursor = page.nextCursor;
    if (maxPages && pages >= maxPages) break;
  } while (cursor && pages < MAX_PAGES);
  // A reader that still had a next cursor at MAX_PAGES did not reach the end: the caller must not
  // advance the since-watermark, or the tail would be skipped on the next incremental run.
  if (cursor && pages >= MAX_PAGES) ctx.capped = true;
  return pages;
}

// ---- CRM -------------------------------------------------------------------------------------------

async function runCrm(ctx: JobContext, cfg: ResolvedConfig, syncType: string, since: Date | null, opts: RunOptions, build: BuildOptions) {
  const crm = await buildCrm(cfg, build);
  const system = cfg.provider === "mock" ? "salesforce-mock" : "salesforce";
  if (syncType === "accounts") {
    // A child can arrive before its parent (other page, other run). Its hash would then skip it
    // forever, so children written without a parent are re-linked once the page walk is done.
    const orphans: { externalId: string; parentExternalId: string }[] = [];
    const pages = await eachPage(ctx, "Account", (o) => crm.fetchAccounts(o), since, opts.maxPages, async (a) => { const out = await writeAccount(ctx, system, a); if (a.parentExternalId && out !== "skipped") orphans.push({ externalId: a.externalId, parentExternalId: a.parentExternalId }); }, (a) => a.externalId);
    const relinked = await relinkParents(system, orphans);
    let affiliations = 0;
    if (crm.fetchGpoAffiliations) await eachPage(ctx, "GpoAffiliation", (o) => crm.fetchGpoAffiliations!(o), since, opts.maxPages, async (g) => { await writeGpoAffiliation(ctx, system, g); affiliations++; }, (g) => g.accountExternalId);
    return { pages, affiliations, relinked, system };
  }
  if (syncType === "opportunities") { const pages = await eachPage(ctx, "Opportunity", (o) => crm.fetchOpportunities(o), since, opts.maxPages, (o) => writeOpportunity(ctx, system, o), (o) => o.externalId); return { pages, system }; }
  if (syncType === "contacts") {
    if (!crm.fetchContacts) throw new ConfigurationError("this CRM provider does not expose contacts");
    const batch: Parameters<typeof writeContacts>[2] = [];
    const pages = await eachPage(ctx, "Contact", (o) => crm.fetchContacts!(o), since, opts.maxPages, async (c) => { batch.push(c); }, (c) => c.externalId);
    await writeContacts(ctx, system, batch);
    return { pages, system };
  }
  throw new ConfigurationError(`unknown CRM sync "${syncType}"`);
}

async function relinkParents(system: string, orphans: { externalId: string; parentExternalId: string }[]): Promise<number> {
  const { prisma } = await import("@/lib/db");
  let n = 0;
  for (const o of orphans) {
    const [child, parent] = await Promise.all([
      prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system, entityType: "Account", externalId: o.externalId } } }),
      prisma.externalRef.findUnique({ where: { system_entityType_externalId: { system, entityType: "Account", externalId: o.parentExternalId } } }),
    ]);
    if (!child || !parent) continue;
    const r = await prisma.account.updateMany({ where: { id: child.entityId, parentAccountId: null }, data: { parentAccountId: parent.entityId } });
    n += r.count;
  }
  return n;
}

// ---- ERP -------------------------------------------------------------------------------------------

async function runErp(ctx: JobContext, cfg: ResolvedConfig, syncType: string, since: Date | null, opts: RunOptions, build: BuildOptions) {
  const erp = await buildErp(cfg, build);
  const system = cfg.provider === "mock" ? "sap-mock" : "sap";
  const { getCompany } = await import("@/lib/settings");
  const companyId = (await getCompany()).id;
  let pages = 0;
  if (syncType === "materials") {
    pages = await eachPage(ctx, "OwnProduct", (o) => erp.fetchMaterials(o), since, opts.maxPages, (m) => writeProduct(ctx, system, companyId, m), (m) => m.sku);
    if (ctx.counters.created || ctx.counters.updated) { const { requestEmbeddingRefresh } = await import("@/lib/match/embeddings"); await requestEmbeddingRefresh("OwnProduct"); }
  } else if (syncType === "costs") pages = await eachPage(ctx, "StandardCost", (o) => erp.fetchStandardCosts(o), since, opts.maxPages, (c) => writeStandardCost(ctx, system, companyId, c), (c) => c.sku);
  else if (syncType === "prices") pages = await eachPage(ctx, "PriceEntry", (o) => erp.fetchListPrices(o), since, opts.maxPages, (p) => writeListPrice(ctx, system, companyId, p), (p) => p.sku);
  else if (syncType === "billing") pages = await eachPage(ctx, "PurchaseRecord", (o) => erp.fetchBillingDocuments(o), since, opts.maxPages, (b) => writeBilling(ctx, system, companyId, b), (b) => b.externalId);
  else throw new ConfigurationError(`unknown ERP sync "${syncType}"`);
  return { pages, system, companyId };
}

// ---- GPO rosters -------------------------------------------------------------------------------------

async function runGpo(ctx: JobContext, cfg: ResolvedConfig, since: Date | null, opts: RunOptions, build: BuildOptions) {
  const roster = await buildGpoRoster(cfg, build);
  const { reconcileRoster } = await import("../gpo/reconcile");
  const records: Awaited<ReturnType<typeof roster.fetchMemberships>>["records"] = [];
  const incremental = cfg.provider === "api" && Boolean(cfgRead.str(cfg.config, "sinceParam")) && since !== null;
  const pages = await eachPage(ctx, "GpoMembership", (o) => roster.fetchMemberships(incremental ? o : { ...o, since: null }), since, opts.maxPages, async (m) => { records.push(m); }, (m) => m.externalMembershipId ?? m.accountNumber ?? null);
  // eachPage counted received; reconcileRoster counts outcomes
  const summary = await reconcileRoster(cfg.key, ctx, records, { closeMissing: cfgRead.bool(cfg.config, "closeMissing"), complete: !incremental && !opts.maxPages });
  return { pages, ...summary, incremental };
}

// ---- FX -----------------------------------------------------------------------------------------------

async function runFx(ctx: JobContext, cfg: ResolvedConfig, build: BuildOptions) {
  if (cfg.provider === "manual") throw new ConfigurationError("the manual FX provider has nothing to pull — rates are entered under Settings → Exchange rates");
  const provider = await buildFx(cfg, build);
  const { pullRates } = await import("../fx/service");
  const bases = cfgRead.csv(cfg.config, "baseCurrencies", ["USD"]); const quotes = cfgRead.csv(cfg.config, "quoteCurrencies", ["EUR", "GBP", "CAD"]);
  const pairs = bases.flatMap((b) => quotes.filter((q) => q !== b).map((q) => ({ base: b, quote: q })));
  const date = new Date().toISOString().slice(0, 10);
  ctx.received(pairs.length);
  const out = await pullRates(provider, pairs, date, ctx.jobId);
  ctx.created(out.stored);
  for (const m of out.missing) ctx.rowError("ExchangeRate", m, new IntegrationError("NOT_FOUND", `no ${m} rate published for ${date}`, { retryable: false }));
  return { date, ...out };
}

// ---- Competitor contract prices ---------------------------------------------------------------------------

async function runContracts(ctx: JobContext, cfg: ResolvedConfig, opts: RunOptions, build: BuildOptions) {
  const adapter = await buildContractPrices(cfg, build);
  const { ingestContractPrices } = await import("../competitor-contracts/ingest");
  const uom = cfgRead.json<Record<string, string>>(cfg.config, "uomAliases", {});
  const outcomes: Awaited<ReturnType<typeof ingestContractPrices>> = [];
  let cursor: string | null = null; let pages = 0;
  do {
    const page = await adapter.fetchContractPrices({ cursor });
    pages++;
    for (const r of page.rejected ?? []) { ctx.received(); ctx.rowError("CompetitorContractPrice", r.externalId, new ValidationError(r.message), r.externalId); }
    outcomes.push(...(await ingestContractPrices(ctx, page.records, { uomAliases: Object.fromEntries(Object.entries(uom).map(([k, v]) => [k.toLowerCase().replace(/[.\s]/g, ""), v])), currencies: cfgRead.csv(cfg.config, "currencies", ["USD", "CAD", "EUR", "GBP"]), unknownCompetitor: cfgRead.str(cfg.config, "unknownCompetitor", "review") as "review" | "create", keepExpired: cfgRead.bool(cfg.config, "keepExpired"), sourceSystem: opts.upload?.filename })));
    cursor = page.nextCursor;
    if (opts.maxPages && pages >= opts.maxPages) break;
  } while (cursor && pages < MAX_PAGES);
  const tally = outcomes.reduce<Record<string, number>>((acc, o) => { acc[o.result] = (acc[o.result] ?? 0) + 1; return acc; }, {});
  return { pages, tally, rows: outcomes };
}

// ---- connection test / mapping validation ----------------------------------------------------------------

export async function testConnection(k: IntegrationKey, actorUserId: string | null, fetchImpl?: typeof fetch): Promise<ConnectionTestResult & { category?: string }> {
  const cfg = await readConfig(k);
  if (!cfg) return { ok: false, message: `${INTEGRATIONS[k].label} is not configured` };
  const t0 = Date.now();
  try {
    const adapter = await buildAny(cfg, { fetchImpl });
    const r = await adapter.testConnection();
    await recordTest(k, r.ok, r.ok ? null : { message: r.message, category: "PROVIDER_UNAVAILABLE" });
    log.info("integration.test", { integration: k, provider: cfg.provider, ok: r.ok, ms: Date.now() - t0 });
    await audit({ actorUserId, entityType: "Integration", entityId: k, action: "TEST_CONNECTION", context: { ok: r.ok, message: r.message } });
    return r;
  } catch (e) {
    const err = asIntegrationError(e);
    await recordTest(k, false, { message: err.message, category: err.category });
    log.warn("integration.test_failed", { integration: k, provider: cfg.provider, category: err.category, error: err.message, ms: Date.now() - t0 });
    await audit({ actorUserId, entityType: "Integration", entityId: k, action: "TEST_CONNECTION", context: { ok: false, category: err.category, message: err.message } });
    return { ok: false, message: err.message, category: err.category };
  }
}

/** Validate the saved mapping against the specs — and, when the provider can describe its objects, against the live field list. */
export async function validateIntegrationMapping(k: IntegrationKey, live: boolean, fetchImpl?: typeof fetch): Promise<{ entities: Record<string, MappingIssue[]>; live: boolean; ok: boolean }> {
  const def = await definition(k);
  const cfg = await readConfig(k);
  const mapping = effectiveMapping(def, cfg?.mapping ?? {});
  const entities: Record<string, MappingIssue[]> = {};
  let describe: ((entity: string) => Promise<string[] | null>) | null = null;
  if (live && cfg) {
    try { const adapter = await buildAny(cfg, { fetchImpl }) as { describeFields?: (e: string) => Promise<string[] | null> }; if (adapter.describeFields) describe = adapter.describeFields.bind(adapter); } catch (e) { const err = asIntegrationError(e); entities._connection = [{ field: "_", level: "warning", message: `live validation unavailable: ${err.message}` }]; }
  }
  for (const [entity, spec] of Object.entries(def.mappingSpecs)) {
    if (entity === "_") continue;
    const fields = describe ? await describe(entity).catch(() => null) : null;
    entities[entity] = validateMapping(mapping[entity] ?? {}, spec, fields);
  }
  const ok = !Object.values(entities).some((issues) => issues.some((i) => i.level === "error"));
  return { entities, live: Boolean(describe), ok };
}

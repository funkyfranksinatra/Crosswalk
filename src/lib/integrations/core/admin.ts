/**
 * What the Integration Settings screen reads and writes. Everything returned here is safe to
 * show an administrator: secrets appear only as "present / absent" per field, never as values,
 * and error messages have already been redacted at the source.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";
import { publicFieldSpec } from "./fields";
import { readConfig, saveConfig, secretsState, type IntegrationKey, type SaveInput } from "./config";
import { definition, fieldsFor, providerOf, INTEGRATIONS, effectiveMapping } from "./registry";
import { openReviewCount, REVIEW_KINDS } from "./review";
import { parseMappingBundle, type MappingBundle } from "./mapping";
import { ConfigurationError } from "./errors";
import { rescheduleIntegration } from "./schedule";

export type IntegrationSummary = { key: IntegrationKey; label: string; family: string; description: string; provider: string | null; providerLabel: string | null; mock: boolean; enabled: boolean; status: string; lastSyncAt: string | null; lastAttemptAt: string | null; lastTestAt: string | null; lastTestOk: boolean | null; lastError: string | null; lastErrorCategory: string | null; openReviews: number; scheduleCron: string | null };

export async function listIntegrations(): Promise<IntegrationSummary[]> {
  const rows = await prisma.integrationConfig.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const reviews = await prisma.integrationReviewItem.groupBy({ by: ["integrationKey"], where: { status: "OPEN" }, _count: { _all: true } });
  const openBy = new Map(reviews.map((r) => [r.integrationKey, r._count._all]));
  return Object.values(INTEGRATIONS).map((d) => {
    const r = byKey.get(d.key);
    const p = r ? d.providers.find((p) => p.id === r.provider) : null;
    return { key: d.key, label: d.label, family: d.family, description: d.description, provider: r?.provider ?? null, providerLabel: p?.label ?? null, mock: Boolean(p?.mock), enabled: r?.enabled ?? false, status: r?.status ?? "NOT_CONFIGURED", lastSyncAt: r?.lastSyncAt?.toISOString() ?? null, lastAttemptAt: r?.lastAttemptAt?.toISOString() ?? null, lastTestAt: r?.lastTestAt?.toISOString() ?? null, lastTestOk: r?.lastTestOk ?? null, lastError: r?.lastError ?? null, lastErrorCategory: r?.lastErrorCategory ?? null, openReviews: openBy.get(d.key) ?? 0, scheduleCron: r?.scheduleCron ?? null };
  });
}

export async function integrationDetail(k: IntegrationKey) {
  const d = await definition(k);
  const row = await prisma.integrationConfig.findUnique({ where: { key: k } });
  const secrets = row ? await secretsState(k) : { present: new Set<string>(), unreadable: null };
  const present = [...secrets.present];
  const overrides = parseMappingBundle(row?.mappingJson);
  const jobs = await prisma.integrationSyncJob.findMany({ where: { integrationKey: k }, orderBy: { startedAt: "desc" }, take: 20, select: { id: true, provider: true, syncType: true, trigger: true, status: true, startedAt: true, completedAt: true, received: true, created: true, updated: true, skipped: true, errored: true, reviewed: true, errorSummary: true, errorCategory: true } });
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row?.configJson ?? "{}") as Record<string, unknown>; } catch { config = {}; }
  return {
    definition: {
      key: d.key, label: d.label, family: d.family, description: d.description,
      providers: d.providers.map((p) => ({ id: p.id, label: p.label, description: p.description, mock: Boolean(p.mock), fields: p.fields.map(publicFieldSpec) })),
      commonFields: d.commonFields.map(publicFieldSpec),
      mappingSpecs: d.mappingSpecs, defaultMapping: d.defaultMapping,
      syncTypes: d.syncTypes, webhook: d.webhook ?? null, requiredFromCustomer: d.requiredFromCustomer,
    },
    config: row ? {
      provider: row.provider, enabled: row.enabled, config, secretsPresent: present, secretsUnreadable: secrets.unreadable, mapping: overrides, effectiveMapping: effectiveMapping(d, overrides), scheduleCron: row.scheduleCron, configVersion: row.configVersion,
      status: row.status, lastTestAt: row.lastTestAt, lastTestOk: row.lastTestOk, lastConnectedAt: row.lastConnectedAt, lastSyncAt: row.lastSyncAt, lastAttemptAt: row.lastAttemptAt, lastError: row.lastError, lastErrorCategory: row.lastErrorCategory, updatedAt: row.updatedAt,
    } : null,
    jobs,
    openReviews: await openReviewCount(k),
    mockAllowed: (await import("./mock")).mockAllowed(),
  };
}

export type AdminSaveBody = { provider?: unknown; enabled?: unknown; config?: unknown; secrets?: unknown; mapping?: unknown; scheduleCron?: unknown };

/** Validate the body shape (never trust the browser), save, audit without the secret values, reschedule. */
export async function saveIntegration(k: IntegrationKey, b: AdminSaveBody, actorUserId: string) {
  const d = await definition(k);
  const providerId = typeof b.provider === "string" ? b.provider : "";
  const provider = providerOf(d, providerId);
  if (provider.mock && !(await import("./mock")).mockAllowed()) throw new ConfigurationError("mock providers are not allowed in this deployment (INTEGRATIONS_ALLOW_MOCK)");
  const specs = fieldsFor(d, provider.id);
  const config = b.config && typeof b.config === "object" && !Array.isArray(b.config) ? (b.config as Record<string, unknown>) : {};
  const secrets: Record<string, string | null> = {};
  if (b.secrets && typeof b.secrets === "object" && !Array.isArray(b.secrets)) for (const [name, v] of Object.entries(b.secrets as Record<string, unknown>)) { if (v === null || typeof v === "string") secrets[name] = v; }
  let mapping: MappingBundle | undefined;
  if (b.mapping !== undefined) {
    if (!b.mapping || typeof b.mapping !== "object" || Array.isArray(b.mapping)) throw new ConfigurationError("mapping must be an object of entity → field rules");
    mapping = {};
    for (const [entity, rules] of Object.entries(b.mapping as Record<string, unknown>)) {
      if (!d.mappingSpecs[entity]) throw new ConfigurationError(`mapping: unknown entity "${entity}" (expected ${Object.keys(d.mappingSpecs).join(", ")})`);
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new ConfigurationError(`mapping.${entity} must be an object`);
      const clean: MappingBundle[string] = {};
      for (const [field, rule] of Object.entries(rules as Record<string, unknown>)) {
        if (!d.mappingSpecs[entity].fields.some((f) => f.name === field)) throw new ConfigurationError(`mapping.${entity}: "${field}" is not a canonical field`);
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new ConfigurationError(`mapping.${entity}.${field} must be a rule object`);
        const r = rule as Record<string, unknown>;
        clean[field] = { source: typeof r.source === "string" ? r.source : undefined, constant: r.constant as string | undefined, transform: typeof r.transform === "string" ? (r.transform as never) : undefined, valueMap: r.valueMap && typeof r.valueMap === "object" ? (r.valueMap as Record<string, string>) : undefined, unmapped: typeof r.unmapped === "string" ? (r.unmapped as never) : undefined, default: r.default as string | undefined, required: typeof r.required === "boolean" ? r.required : undefined, separator: typeof r.separator === "string" ? r.separator : undefined };
        for (const key of Object.keys(clean[field]) as (keyof typeof clean[string])[]) if (clean[field][key] === undefined) delete clean[field][key];
      }
      mapping[entity] = clean;
    }
  }
  const scheduleCron = b.scheduleCron === undefined ? undefined : b.scheduleCron === null || b.scheduleCron === "" ? null : String(b.scheduleCron);
  if (scheduleCron && !/^(\S+\s+){4}\S+$/.test(scheduleCron)) throw new ConfigurationError("schedule must be a 5-field cron expression (UTC), e.g. 0 2 * * *");
  const input: SaveInput = { provider: provider.id, enabled: typeof b.enabled === "boolean" ? b.enabled : undefined, config, secrets, mapping, scheduleCron };
  const prev = await readConfig(k).catch(() => null);
  const out = await saveConfig(k, input, specs, actorUserId);
  const secretFieldsChanged = Object.entries(secrets).filter(([name]) => specs.some((s) => s.name === name && s.secret)).map(([name, v]) => `${name}:${v ? "set" : "cleared"}`);
  await audit({ actorUserId, entityType: "Integration", entityId: k, action: "CONFIGURED", before: prev ? { provider: prev.provider, enabled: prev.enabled, configVersion: prev.configVersion } : null, after: { provider: provider.id, enabled: input.enabled ?? prev?.enabled ?? false, configVersion: out.configVersion, status: out.status, secretFieldsChanged, mappingChanged: mapping !== undefined, scheduleCron } });
  log.info("integration.configured", { integration: k, provider: provider.id, status: out.status, configVersion: out.configVersion, secretFieldsChanged: secretFieldsChanged.length, errors: out.errors.length });
  await rescheduleIntegration(k);
  return out;
}

export async function listJobs(k: IntegrationKey | null, limit = 50) {
  return prisma.integrationSyncJob.findMany({ where: k ? { integrationKey: k } : {}, orderBy: { startedAt: "desc" }, take: Math.min(limit, 200), include: { _count: { select: { errors: true } } } });
}
export async function jobDetail(id: string) {
  const job = await prisma.integrationSyncJob.findUnique({ where: { id }, include: { errors: { take: 500, orderBy: { id: "asc" } } } });
  if (!job) throw new Error("not found");
  return { ...job, report: job.reportJson ? JSON.parse(job.reportJson) : null, reportJson: undefined };
}

export async function listReviews(filter: { key?: IntegrationKey | null; kind?: string | null; status?: "OPEN" | "RESOLVED" | "DISMISSED" }, limit = 100) {
  if (filter.kind && !(REVIEW_KINDS as readonly string[]).includes(filter.kind)) throw new Error(`unknown review kind ${filter.kind}`);
  const rows = await prisma.integrationReviewItem.findMany({ where: { ...(filter.key ? { integrationKey: filter.key } : {}), ...(filter.kind ? { kind: filter.kind } : {}), status: filter.status ?? "OPEN" }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 500) });
  return rows.map((r) => ({ ...r, payload: safeJson(r.payloadJson), suggestion: safeJson(r.suggestionJson), payloadJson: undefined, suggestionJson: undefined }));
}
function safeJson(s: string | null): unknown { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

/** Resolution is delegated to the integration that queued the item. */
export async function resolveReviewItem(id: string, action: Record<string, unknown>, actorUserId: string): Promise<unknown> {
  const item = await prisma.integrationReviewItem.findUnique({ where: { id } });
  if (!item) throw new Error("not found");
  if (item.status !== "OPEN") throw new Error("review item is already resolved");
  const type = String(action.type ?? "");
  const k = item.integrationKey as IntegrationKey;
  if (k.startsWith("gpo:")) {
    const { resolveRosterReview } = await import("../gpo/reconcile");
    if (type === "link") { if (typeof action.accountId !== "string") throw new Error("accountId is required"); await resolveRosterReview(k, id, { type: "link", accountId: action.accountId }, actorUserId); }
    else if (type === "supersede" || type === "dismiss") await resolveRosterReview(k, id, { type }, actorUserId);
    else throw new Error("type must be link, supersede or dismiss");
    return { ok: true };
  }
  if (k === "competitor-contracts") {
    const { resolveContractReview } = await import("../competitor-contracts/ingest");
    if (type === "accept") return resolveContractReview(id, { type: "accept", corrections: action.corrections && typeof action.corrections === "object" ? (action.corrections as never) : undefined }, actorUserId);
    if (type === "dismiss") return resolveContractReview(id, { type: "dismiss", reason: typeof action.reason === "string" ? action.reason : undefined }, actorUserId);
    throw new Error("type must be accept or dismiss");
  }
  const { resolveReview } = await import("./review");
  if (type !== "dismiss" && type !== "accept") throw new Error("type must be accept or dismiss");
  await resolveReview(id, type === "accept" ? "ACCEPTED" : "DISMISSED", actorUserId, { reason: typeof action.reason === "string" ? action.reason : null });
  return { ok: true };
}

/**
 * Scheduled feeds — the replacement for "someone uploads a spreadsheet when they remember".
 *
 * A feed is a named source of commercial data that is ingested on a schedule by the
 * `feed.ingest` queue, on demand from Settings → Integrations, and once at worker start
 * (`FEEDS_RUN_ON_START=true`). Every ingestion is a FeedRun row: what ran, from where,
 * how many rows, what changed, what failed. Freshness (time since the last OK run) is
 * exposed on /api/health and turns into an alert when a feed goes stale.
 *
 * Sources, in order of preference per feed:
 *   - the vendor API adapter when its credentials are configured (Salesforce / SAP — skeletons today)
 *   - a file drop in INTEGRATION_FEED_DIR (CSV; the same files Settings → Integrations describes)
 * An unchanged file (same content hash as the last OK run) is skipped, so a schedule can
 * be aggressive without re-importing anything.
 *
 * Idempotency is the underlying importer's: every one of them upserts by natural key.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { audit } from "@/lib/audit";
import { feedDir } from "@/lib/integrations/file";
import { parseCsv } from "@/lib/sheets/csv";
import { feedAge } from "@/lib/observability/metrics";

export type FeedName = "crm" | "erp" | "gpo" | "pricing" | "competitor-sizes" | "competitor-prices";

export type FeedDefinition = {
  name: FeedName;
  title: string;
  description: string;
  /** Files (in INTEGRATION_FEED_DIR) this feed reads when no API adapter is configured. */
  files: string[];
  /** Default cron (UTC); FEED_<NAME>_CRON overrides, "off" disables. */
  defaultCron: string;
  /** Alert when the last successful run is older than this many hours (FEED_<NAME>_MAX_AGE_HOURS overrides). */
  maxAgeHours: number;
};

export const FEEDS: Record<FeedName, FeedDefinition> = {
  crm: { name: "crm", title: "CRM accounts & opportunities", description: "Accounts (with GPO affiliation) and open opportunities from the CRM.", files: ["crm-accounts.csv", "crm-opportunities.csv"], defaultCron: "0 2 * * *", maxAgeHours: 36 },
  erp: { name: "erp", title: "ERP SKUs, standard costs & purchases", description: "Material master, standard cost by plant and invoiced purchases from the ERP.", files: ["erp-skus.csv", "erp-costs.csv", "erp-purchases.csv"], defaultCron: "30 2 * * *", maxAgeHours: 36 },
  gpo: { name: "gpo", title: "GPO memberships", description: "Member roster with tier and effective dates.", files: ["gpo-memberships.csv"], defaultCron: "0 3 * * 1", maxAgeHours: 8 * 24 },
  pricing: { name: "pricing", title: "List prices & pricebooks", description: "List price per SKU and per pricebook (the same layout as Catalog → Import pricing).", files: ["pricing.csv"], defaultCron: "15 2 * * *", maxAgeHours: 36 },
  "competitor-sizes": { name: "competitor-sizes", title: "Competitor size master", description: "Dimensions for competitor codes GUDID does not size (product marketing's master).", files: ["competitor-sizes.csv"], defaultCron: "0 4 * * 1", maxAgeHours: 8 * 24 },
  "competitor-prices": { name: "competitor-prices", title: "Competitor price observations", description: "GPO contract files and invoice extracts with competitor prices (Competitor pricing → Import layout).", files: ["competitor-prices.csv"], defaultCron: "45 2 * * *", maxAgeHours: 8 * 24 },
};

const envKey = (name: string) => name.toUpperCase().replace(/-/g, "_");

export function feedCron(name: FeedName): string | null {
  const v = process.env[`FEED_${envKey(name)}_CRON`]?.trim();
  if (v?.toLowerCase() === "off") return null;
  return v || FEEDS[name].defaultCron;
}

export function feedMaxAgeHours(name: FeedName): number {
  const v = Number(process.env[`FEED_${envKey(name)}_MAX_AGE_HOURS`]);
  return Number.isFinite(v) && v > 0 ? v : FEEDS[name].maxAgeHours;
}

const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();
/** SHA-256 of a feed file, cached by (path, mtime, size): health checks and alert passes must not re-read a 300 MB purchases file. */
function fileHash(p: string): string {
  const st = fs.statSync(p);
  const c = hashCache.get(p);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.hash;
  const hash = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  hashCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, hash });
  return hash;
}

export function isFeedName(name: unknown): name is FeedName {
  return typeof name === "string" && Object.hasOwn(FEEDS, name);
}

export type FeedSource = { kind: "api" | "file" | "none"; ref: string | null; hash: string | null; present: string[] };

/**
 * Where a feed's data comes from right now, and a content hash so unchanged drops are skipped.
 * `ref` names files or the integration, never server paths. The crm / erp / gpo feeds are served by
 * an enabled Tier 2 integration (Settings → Integrations) when there is one — those pull from the
 * provider, so they carry no hash and are never "unchanged". The retired SF_* / SAP_* variables still
 * count as an API source so the ingestion runs and fails with the truthful message (sync.ts).
 */
export async function feedSource(name: FeedName): Promise<FeedSource> {
  const dir = feedDir();
  const present = dir ? FEEDS[name].files.filter((f) => fs.existsSync(path.join(dir, f))) : [];
  if (name === "crm" || name === "erp" || name === "gpo") {
    const { tier2Status, legacyEnvPresent } = await import("@/lib/integrations/sync");
    const t2 = await tier2Status();
    const on = t2.filter((t) => t.enabled && (name === "gpo" ? t.family === "gpo" : t.key === (name === "crm" ? "salesforce" : "sap")));
    if (on.length) return { kind: "api", ref: on.map((t) => `${t.label} (${t.provider})`).join(", "), hash: null, present };
    if (name === "crm" && legacyEnvPresent("crm")) return { kind: "api", ref: "Salesforce (legacy SF_* variables — not used)", hash: null, present };
    if (name === "erp" && legacyEnvPresent("erp")) return { kind: "api", ref: "SAP OData (legacy SAP_* variables — not used)", hash: null, present };
  }
  if (!dir || !present.length) return { kind: "none", ref: null, hash: null, present };
  const h = createHash("sha256");
  for (const f of present) { h.update(f); h.update(fileHash(path.join(dir, f))); }
  return { kind: "file", ref: present.join(", "), hash: h.digest("hex"), present };
}

function readGrid(file: string): (string | number | null)[][] {
  const dir = feedDir();
  if (!dir) return [];
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return [];
  return parseCsv(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
}

type Counts = { rows: number; created: number; updated: number; skipped: number; failed: number; report: unknown };

async function runFeed(name: FeedName, actorUserId: string | null): Promise<Counts> {
  const { getCompany } = await import("@/lib/settings");
  const company = await getCompany();
  switch (name) {
    case "crm": {
      const { syncCrmAccounts } = await import("@/lib/integrations/sync");
      const r = await syncCrmAccounts(actorUserId);
      return { rows: r.created + r.updated + r.skipped + r.failed, created: r.created, updated: r.updated, skipped: r.skipped, failed: r.failed, report: r };
    }
    case "erp": {
      const { syncErp } = await import("@/lib/integrations/sync");
      const rs = await syncErp(actorUserId, company.id);
      const sum = (k: "created" | "updated" | "skipped" | "failed") => rs.reduce((a, r) => a + r[k], 0);
      return { rows: sum("created") + sum("updated") + sum("skipped") + sum("failed"), created: sum("created"), updated: sum("updated"), skipped: sum("skipped"), failed: sum("failed"), report: rs };
    }
    case "gpo": {
      const { syncGpoMemberships } = await import("@/lib/integrations/sync");
      const r = await syncGpoMemberships(actorUserId);
      return { rows: r.created + r.updated + r.skipped + r.failed, created: r.created, updated: r.updated, skipped: r.skipped, failed: r.failed, report: r };
    }
    case "pricing": {
      const { importPricingRows } = await import("@/lib/excel/pricing");
      const grid = readGrid("pricing.csv");
      if (!grid.length) throw new Error("pricing.csv is missing or empty");
      const r = await importPricingRows(grid, company.id);
      // Rows that could not be applied (unknown SKU, invalid cell) count as failed: the file is not "consumed" and is retried on the next schedule.
      return { rows: r.rows, created: 0, updated: r.updated, skipped: 0, failed: r.invalid.length + r.unknownSkus.length, report: r };
    }
    case "competitor-sizes": {
      const { importCompetitorSizesRows } = await import("@/lib/excel/sizes");
      const grid = readGrid("competitor-sizes.csv");
      if (!grid.length) throw new Error("competitor-sizes.csv is missing or empty");
      const r = await importCompetitorSizesRows(grid);
      return { rows: r.rows, created: r.upserted, updated: 0, skipped: 0, failed: r.skipped.length, report: r };
    }
    case "competitor-prices": {
      const { importObservationRows } = await import("@/lib/intelligence/import");
      const grid = readGrid("competitor-prices.csv");
      if (!grid.length) throw new Error("competitor-prices.csv is missing or empty");
      const system = await prisma.user.findFirst({ where: { roles: { some: { role: "ADMIN" } } }, select: { id: true } });
      if (!actorUserId && !system) throw new Error("no ADMIN user exists to attribute the imported observations to");
      const r = await importObservationRows(actorUserId ?? system!.id, grid, null);
      return { rows: r.rows, created: r.recorded, updated: 0, skipped: 0, failed: r.skipped.length, report: r };
    }
  }
}

export type IngestOptions = { trigger: "schedule" | "manual" | "startup"; actorUserId?: string | null; jobId?: string | null; force?: boolean };

/** Ingest one feed: skip when nothing changed, record a FeedRun either way, notify on failure. */
export async function ingestFeed(name: string, opts: IngestOptions) {
  if (!isFeedName(name)) throw new Error(`unknown feed "${name}"`);
  const feed = name;
  const source = await feedSource(feed);
  // One ingestion of a feed at a time, whichever door it came through (queue or "Sync now"). The
  // check and the RUNNING row are written under a per-feed advisory lock: two callers arriving
  // together (a schedule and a "Sync now", two worker processes) would otherwise both pass a plain
  // find-then-create and ingest the same file twice. A RUNNING row from a process that died is
  // closed as FAILED here rather than blocking the feed for ever.
  const opened = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`feed:${feed}`}))::text`;
    await tx.feedRun.updateMany({ where: { feed, status: "RUNNING", startedAt: { lt: new Date(Date.now() - RUNNING_STALE_MS) } }, data: { status: "FAILED", finishedAt: new Date(), error: "the process running this ingestion stopped before it finished" } });
    const active = await tx.feedRun.findFirst({ where: { feed, status: "RUNNING" }, select: { id: true, startedAt: true } });
    if (active) return { kind: "active" as const, startedAt: active.startedAt };
    if (source.kind === "none") {
      const run = await tx.feedRun.create({ data: { feed, trigger: opts.trigger, status: "SKIPPED", sourceRef: source.ref, error: `no source configured (set INTEGRATION_FEED_DIR with ${FEEDS[feed].files.join(" / ")}, or enable the integration under Settings → Integrations)`, finishedAt: new Date(), jobId: opts.jobId ?? null } });
      return { kind: "skipped" as const, run };
    }
    if (source.hash && !opts.force) {
      // Only a fully clean run "consumes" a file: one with rejected rows (an ERP SKU file that landed
      // after the pricing file) is tried again on the next schedule, not skipped forever.
      const last = await tx.feedRun.findFirst({ where: { feed, status: "OK", sourceHash: source.hash, failed: 0 }, orderBy: { startedAt: "desc" }, select: { id: true, startedAt: true } });
      if (last) {
        const run = await tx.feedRun.create({ data: { feed, trigger: opts.trigger, status: "SKIPPED", sourceRef: source.ref, sourceHash: source.hash, error: `unchanged since ${last.startedAt.toISOString()}`, finishedAt: new Date(), jobId: opts.jobId ?? null } });
        return { kind: "skipped" as const, run };
      }
    }
    const run = await tx.feedRun.create({ data: { feed, trigger: opts.trigger, sourceRef: source.ref, sourceHash: source.hash, jobId: opts.jobId ?? null } });
    return { kind: "running" as const, run };
  });
  if (opened.kind === "active") throw new Error(`Feed "${feed}" is already being ingested (started ${opened.startedAt.toISOString()})`);
  if (opened.kind === "skipped") return { status: "SKIPPED" as const, runId: opened.run.id, reason: opened.run.error };
  const run = opened.run;
  const t0 = Date.now();
  try {
    const c = await runFeed(feed, opts.actorUserId ?? null);
    await prisma.feedRun.update({ where: { id: run.id }, data: { status: "OK", finishedAt: new Date(), rows: c.rows, created: c.created, updated: c.updated, skipped: c.skipped, failed: c.failed, reportJson: JSON.stringify(boundedReport(c.report)) } });
    await audit({ actorUserId: opts.actorUserId ?? null, entityType: "Feed", entityId: feed, action: "FEED_INGESTED", after: { trigger: opts.trigger, rows: c.rows, created: c.created, updated: c.updated, skipped: c.skipped, failed: c.failed, source: source.kind } });
    log.info("feed.ok", { feed, trigger: opts.trigger, ms: Date.now() - t0, ...c, report: undefined });
    feedAge.set({ feed }, 0);
    return { status: "OK" as const, runId: run.id, ...c };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.feedRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: error.slice(0, 2000) } });
    log.error("feed.failed", { feed, trigger: opts.trigger, ms: Date.now() - t0, error });
    const { notifyFeedFailed } = await import("@/lib/notifications");
    await notifyFeedFailed(feed, error, run.id).catch((ne) => log.warn("feed.notify_failed", { feed, error: ne instanceof Error ? ne.message : String(ne) }));
    throw e;
  }
}

/** A RUNNING row older than this belongs to a process that died (the queue's expiry has long passed). */
const RUNNING_STALE_MS = 12 * 3600_000;

/** Keep a report JSON-valid and small: long lists are truncated with a count, never cut mid-document. */
function boundedReport(report: unknown, maxItems = 200): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.length > maxItems ? [...v.slice(0, maxItems).map(walk), `… ${v.length - maxItems} more`] : v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
    return v;
  };
  return walk(report);
}

/** Queue a manual ingestion (dedupe: one queued/running job per feed). `force` ingests even an unchanged file. */
export async function requestIngest(feed: FeedName, actorUserId: string | null, force = false) {
  const { enqueue } = await import("@/lib/jobs/boss");
  const { jobId, deduplicated } = await enqueue("feed.ingest", { feed, trigger: "manual", actorUserId, force }, { singletonKey: `feed:${feed}` });
  return { jobId, alreadyQueued: deduplicated };
}

export type FeedStatus = { name: FeedName; title: string; description: string; cron: string | null; source: FeedSource; lastOk: Date | null; lastRun: { status: string; startedAt: Date; error: string | null; rows: number; created: number; updated: number; skipped: number; failed: number } | null; ageHours: number | null; maxAgeHours: number; stale: boolean };

/** Everything the Settings page and the alert rules need, in one shape. */
export async function feedStatuses(): Promise<FeedStatus[]> {
  const out: FeedStatus[] = [];
  for (const def of Object.values(FEEDS)) {
    const [lastOk, lastRunRaw] = await Promise.all([
      prisma.feedRun.findFirst({ where: { feed: def.name, status: "OK" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
      prisma.feedRun.findFirst({ where: { feed: def.name, status: { not: "SKIPPED" } }, orderBy: { startedAt: "desc" } }),
    ]);
    // A RUNNING row whose process died is a failure, not "in progress".
    const lastRun = lastRunRaw && lastRunRaw.status === "RUNNING" && Date.now() - lastRunRaw.startedAt.getTime() > RUNNING_STALE_MS ? { ...lastRunRaw, status: "FAILED", error: lastRunRaw.error ?? "the process running this ingestion stopped before it finished" } : lastRunRaw;
    const source = await feedSource(def.name);
    const cron = feedCron(def.name);
    const ageHours = lastOk ? (Date.now() - lastOk.startedAt.getTime()) / 3600_000 : null;
    const maxAgeHours = feedMaxAgeHours(def.name);
    // A feed with no source or no schedule is "not connected", never "stale".
    const stale = source.kind !== "none" && cron !== null && (ageHours === null || ageHours > maxAgeHours);
    if (ageHours !== null) feedAge.set({ feed: def.name }, Math.round(ageHours * 3600));
    out.push({ name: def.name, title: def.title, description: def.description, cron, source, lastOk: lastOk?.startedAt ?? null, lastRun: lastRun ? { status: lastRun.status, startedAt: lastRun.startedAt, error: lastRun.error, rows: lastRun.rows, created: lastRun.created, updated: lastRun.updated, skipped: lastRun.skipped, failed: lastRun.failed } : null, ageHours, maxAgeHours, stale });
  }
  return out;
}

/**
 * Queue catalogue. Every background unit of work in Crosswalk is one of these queues;
 * the options are the retry / expiry policy pg-boss applies to each job.
 *
 *   request.run       one cross-reference run (resumable by stage — see pipeline/run.ts)
 *   gudid.import      one bulk GUDID import (resumable by page cursor — see gudid/library.ts)
 *   gudid.refresh     re-check cached GUDID records past their TTL (cron + on-demand)
 *   integration.sync  one CRM / ERP / GPO synchronisation
 *   feed.ingest       one scheduled feed ingestion (costs, prices, purchases, sizes…)
 *   notify.deliver    one external delivery (email / Teams) of one notification
 *   alerts.evaluate   the monitoring rules (cron)
 *   embed.refresh     (Tier 3) embed catalog / competitor products whose text changed (cron + after imports)
 *   analytics.refresh (Tier 3) recompute the materialised analytics reports (cron + after commercial events)
 *   bids.ingest       (Tier 3) pull public awards from SAM.gov / USAspending (cron + on demand)
 *   retention.sweep   (Tier 0) nightly data-retention sweep — scheduled only when RETENTION_ENABLED=true
 *
 * `expireInSeconds` is the crash detector: a job still "active" after that long is
 * assumed dead (server killed mid-run) and retried. Handlers therefore have to be
 * idempotent or resumable — they all are, by design, and the adversarial suite checks it.
 */
/**
 * Every queue is `exclusive`: with a singletonKey, at most one job per key is queued OR
 * active (a second "run this request" while one is running is a no-op, not a duplicate);
 * without a key (alerts.evaluate) at most one job at all, so a cron cannot stack up.
 *
 * Crash detection is the HEARTBEAT (`heartbeatSeconds`): pg-boss refreshes it while the
 * handler runs, and a dead process's job is failed and retried within ~2 heartbeats.
 * `expireInSeconds` is only the backstop for a genuinely hung handler, so it is set well
 * above any legitimate duration (pg-boss caps it at 24 h) — an expired job's handler is still running, and pg-boss
 * aborts its signal (see workers.ts: an abort is an interruption, never a user cancel).
 */
export const QUEUES = {
  "request.run": { policy: "exclusive", retryLimit: 2, retryDelay: 30, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 23 * 3600, deleteAfterSeconds: 7 * 86400 },
  "gudid.import": { policy: "exclusive", retryLimit: 3, retryDelay: 60, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 23 * 3600, deleteAfterSeconds: 7 * 86400 },
  "gudid.refresh": { policy: "exclusive", retryLimit: 2, retryDelay: 120, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 6 * 3600, deleteAfterSeconds: 2 * 86400 },
  "integration.sync": { policy: "exclusive", retryLimit: 2, retryDelay: 60, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 12 * 3600, deleteAfterSeconds: 7 * 86400 },
  "feed.ingest": { policy: "exclusive", retryLimit: 2, retryDelay: 120, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 12 * 3600, deleteAfterSeconds: 14 * 86400 },
  "notify.deliver": { policy: "exclusive", retryLimit: 5, retryDelay: 15, retryBackoff: true, retryDelayMax: 900, expireInSeconds: 300, deleteAfterSeconds: 3 * 86400 },
  "alerts.evaluate": { policy: "exclusive", retryLimit: 0, expireInSeconds: 600, deleteAfterSeconds: 86400 },
  "embed.refresh": { policy: "exclusive", retryLimit: 2, retryDelay: 120, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 6 * 3600, deleteAfterSeconds: 2 * 86400 },
  "analytics.refresh": { policy: "exclusive", retryLimit: 1, retryDelay: 60, expireInSeconds: 1800, deleteAfterSeconds: 2 * 86400 },
  "bids.ingest": { policy: "exclusive", retryLimit: 2, retryDelay: 300, retryBackoff: true, heartbeatSeconds: 60, expireInSeconds: 6 * 3600, deleteAfterSeconds: 7 * 86400 },
  "retention.sweep": { policy: "exclusive", retryLimit: 0, heartbeatSeconds: 60, expireInSeconds: 3600, deleteAfterSeconds: 30 * 86400 },
} as const;

export type QueueName = keyof typeof QUEUES;

export type JobData = {
  /** `resume` is set by orphan recovery: continue from the row's checkpoint / cursor even on a fresh job. */
  "request.run": { requestId: string; freshGrades?: boolean; resume?: boolean };
  "gudid.import": { importId: string; resume?: boolean };
  "gudid.refresh": { cfnNorm?: string; limit?: number };
  /** Legacy `system` runs the env/file/dev path; `key`+`syncType` runs a Settings → Integrations configuration through the Tier 2 runner. */
  "integration.sync": { system?: "crm" | "erp" | "gpo"; key?: string; syncType?: string; trigger?: "schedule" | "manual" | "startup"; actorUserId: string | null; full?: boolean };
  "feed.ingest": { feed: string; trigger: "schedule" | "manual" | "startup"; actorUserId?: string | null; force?: boolean };
  "notify.deliver": { notificationId: string; channel: "email" | "teams" };
  "alerts.evaluate": Record<string, never>;
  "embed.refresh": { table?: "OwnProduct" | "CompetitorProduct"; ids?: string[]; limit?: number };
  "analytics.refresh": { reports?: string[]; trigger?: "schedule" | "event" | "manual" };
  "bids.ingest": { source: "sam" | "usaspending"; trigger: "schedule" | "manual"; actorUserId?: string | null; lookbackDays?: number };
  "retention.sweep": { trigger?: "schedule" | "manual"; actorUserId?: string | null };
};

/** Schedules (cron, UTC). Overridable per feed from the environment (see feeds/schedule.ts). */
export const CRON = {
  "alerts.evaluate": process.env.ALERTS_CRON ?? "*/5 * * * *",
  "gudid.refresh": process.env.GUDID_REFRESH_CRON ?? "30 3 * * *",
  "embed.refresh": process.env.EMBED_REFRESH_CRON ?? "15 4 * * *",
  "analytics.refresh": process.env.ANALYTICS_CRON ?? "0 * * * *",
  "bids.ingest": process.env.BIDS_CRON ?? "0 5 * * *",
  "retention.sweep": process.env.RETENTION_CRON ?? "45 2 * * *",
} as const;

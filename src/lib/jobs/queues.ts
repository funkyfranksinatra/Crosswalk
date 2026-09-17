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
 *
 * `expireInSeconds` is the crash detector: a job still "active" after that long is
 * assumed dead (server killed mid-run) and retried. Handlers therefore have to be
 * idempotent or resumable — they all are, by design, and the adversarial suite checks it.
 */
/**
 * Every queue is `exclusive`: with a singletonKey, at most one job per key is queued OR
 * active (a second "run this request" while one is running is a no-op, not a duplicate);
 * without a key (alerts.evaluate) at most one job at all, so a cron cannot stack up.
 */
export const QUEUES = {
  "request.run": { policy: "exclusive", retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 3 * 3600, deleteAfterSeconds: 7 * 86400 },
  "gudid.import": { policy: "exclusive", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 8 * 3600, deleteAfterSeconds: 7 * 86400 },
  "gudid.refresh": { policy: "exclusive", retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 1800, deleteAfterSeconds: 2 * 86400 },
  "integration.sync": { policy: "exclusive", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 2 * 3600, deleteAfterSeconds: 7 * 86400 },
  "feed.ingest": { policy: "exclusive", retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 2 * 3600, deleteAfterSeconds: 14 * 86400 },
  "notify.deliver": { policy: "exclusive", retryLimit: 5, retryDelay: 15, retryBackoff: true, retryDelayMax: 900, expireInSeconds: 120, deleteAfterSeconds: 3 * 86400 },
  "alerts.evaluate": { policy: "exclusive", retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86400 },
} as const;

export type QueueName = keyof typeof QUEUES;

export type JobData = {
  /** `resume` is set by orphan recovery: continue from the row's checkpoint / cursor even on a fresh job. */
  "request.run": { requestId: string; freshGrades?: boolean; resume?: boolean };
  "gudid.import": { importId: string; resume?: boolean };
  "gudid.refresh": { cfnNorm?: string; limit?: number };
  "integration.sync": { system: "crm" | "erp" | "gpo"; actorUserId: string | null };
  "feed.ingest": { feed: string; trigger: "schedule" | "manual" | "startup"; actorUserId?: string | null };
  "notify.deliver": { notificationId: string; channel: "email" | "teams" };
  "alerts.evaluate": Record<string, never>;
};

/** Schedules (cron, UTC). Overridable per feed from the environment (see feeds/schedule.ts). */
export const CRON = {
  "alerts.evaluate": process.env.ALERTS_CRON ?? "*/5 * * * *",
  "gudid.refresh": process.env.GUDID_REFRESH_CRON ?? "30 3 * * *",
} as const;

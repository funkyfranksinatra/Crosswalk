/**
 * IntegrationSyncJob lifecycle. A handler receives a JobContext, reports what it received /
 * created / updated / skipped / errored, records row-level errors and review items through
 * it, and the runner closes the job as SUCCEEDED / PARTIAL / FAILED.
 */
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import type { IntegrationKey } from "./config";
import { asIntegrationError, redactMessage, type ErrorCategory } from "./errors";

export type SyncStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
export type SyncTrigger = "schedule" | "manual" | "webhook" | "startup";

export type Counters = { received: number; created: number; updated: number; skipped: number; errored: number; reviewed: number };

export class JobContext {
  readonly counters: Counters = { received: 0, created: 0, updated: 0, skipped: 0, errored: 0, reviewed: 0 };
  private errorRows: { entityType: string; externalId: string | null; category: string; message: string; rowRef: string | null }[] = [];
  cursorAfter: string | null = null;
  constructor(readonly jobId: string, readonly integrationKey: IntegrationKey, readonly provider: string, readonly syncType: string, readonly actorUserId: string | null, readonly cursorBefore: string | null, readonly mappingVersion: number) {}

  received(n = 1) { this.counters.received += n; }
  created(n = 1) { this.counters.created += n; }
  updated(n = 1) { this.counters.updated += n; }
  skipped(n = 1) { this.counters.skipped += n; }
  reviewed(n = 1) { this.counters.reviewed += n; }
  /** A row that could not be applied. Never throws; the job becomes PARTIAL. */
  rowError(entityType: string, externalId: string | null, e: unknown, rowRef: string | null = null) {
    const err = asIntegrationError(e, "VALIDATION");
    this.counters.errored += 1;
    if (this.errorRows.length < 5000) this.errorRows.push({ entityType, externalId, category: err.category, message: redactMessage(err.message).slice(0, 1000), rowRef });
  }
  async flushErrors() {
    if (!this.errorRows.length) return;
    const rows = this.errorRows.splice(0, this.errorRows.length);
    for (let i = 0; i < rows.length; i += 500) await prisma.integrationSyncError.createMany({ data: rows.slice(i, i + 500).map((r) => ({ jobId: this.jobId, ...r })) });
  }
  get errorCount() { return this.counters.errored; }
}

export async function startJob(k: IntegrationKey, provider: string, syncType: string, trigger: SyncTrigger, actorUserId: string | null, opts: { queueJobId?: string | null; cursorBefore?: string | null; mappingVersion?: number } = {}): Promise<JobContext> {
  const row = await prisma.integrationSyncJob.create({ data: { integrationKey: k, provider, syncType, trigger, status: "RUNNING", actorUserId, queueJobId: opts.queueJobId ?? null, cursorBefore: opts.cursorBefore ?? null } });
  log.info("integration.sync.start", { integration: k, provider, syncType, trigger, jobId: row.id });
  return new JobContext(row.id, k, provider, syncType, actorUserId, opts.cursorBefore ?? null, opts.mappingVersion ?? 0);
}

export async function finishJob(ctx: JobContext, report: unknown = null): Promise<SyncStatus> {
  await ctx.flushErrors();
  const c = ctx.counters;
  const status: SyncStatus = c.errored > 0 ? "PARTIAL" : "SUCCEEDED";
  const summary = c.errored ? `${c.errored} of ${c.received} rows could not be applied` : null;
  await prisma.integrationSyncJob.update({ where: { id: ctx.jobId }, data: { status, completedAt: new Date(), ...c, errorSummary: summary, errorCategory: c.errored ? "VALIDATION" : null, cursorAfter: ctx.cursorAfter, reportJson: report ? JSON.stringify(bounded(report)).slice(0, 200_000) : null } });
  log.info("integration.sync.done", { integration: ctx.integrationKey, provider: ctx.provider, syncType: ctx.syncType, jobId: ctx.jobId, status, ...c });
  return status;
}

export async function failJob(ctx: JobContext, e: unknown): Promise<{ message: string; category: ErrorCategory; retryable: boolean }> {
  await ctx.flushErrors();
  const err = asIntegrationError(e);
  const message = redactMessage(err.message);
  await prisma.integrationSyncJob.update({ where: { id: ctx.jobId }, data: { status: "FAILED", completedAt: new Date(), ...ctx.counters, errorSummary: message.slice(0, 2000), errorCategory: err.category } });
  log.error("integration.sync.failed", { integration: ctx.integrationKey, provider: ctx.provider, syncType: ctx.syncType, jobId: ctx.jobId, category: err.category, error: message, providerRef: err.providerRef });
  return { message, category: err.category, retryable: err.retryable };
}

export async function cancelStaleJobs(olderThanMs = 12 * 3600_000): Promise<number> {
  const r = await prisma.integrationSyncJob.updateMany({ where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - olderThanMs) } }, data: { status: "CANCELLED", completedAt: new Date(), errorSummary: "the process running this sync stopped before it finished" } });
  return r.count;
}

function bounded(v: unknown, maxItems = 200): unknown {
  if (Array.isArray(v)) return v.length > maxItems ? [...v.slice(0, maxItems).map((x) => bounded(x)), `… ${v.length - maxItems} more`] : v.map((x) => bounded(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, bounded(x)]));
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
  return v;
}

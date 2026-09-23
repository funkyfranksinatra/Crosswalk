/**
 * Integration health. Six states, written only by the save / test / sync paths:
 *   NOT_CONFIGURED  no row, or required fields missing
 *   CONFIGURED      valid configuration, never tested
 *   CONNECTED       last test or sync succeeded
 *   DEGRADED        last sync partial, or connected but the last attempt failed a retryable way
 *   ERROR           last test or sync failed
 *   DISABLED        switched off
 */
import { prisma } from "@/lib/db";
import type { IntegrationKey } from "./config";
import type { ErrorCategory } from "./errors";

export const HEALTH_STATES = ["NOT_CONFIGURED", "CONFIGURED", "CONNECTED", "DEGRADED", "ERROR", "DISABLED"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export async function recordTest(k: IntegrationKey, ok: boolean, error: { message: string; category: ErrorCategory } | null): Promise<void> {
  const row = await prisma.integrationConfig.findUnique({ where: { key: k }, select: { enabled: true } });
  await prisma.integrationConfig.update({ where: { key: k }, data: { lastTestAt: new Date(), lastTestOk: ok, ...(ok ? { lastConnectedAt: new Date(), lastError: null, lastErrorCategory: null, status: row?.enabled === false ? "DISABLED" : "CONNECTED" } : { lastError: error?.message.slice(0, 1000) ?? "test failed", lastErrorCategory: error?.category ?? "UNKNOWN", status: row?.enabled === false ? "DISABLED" : "ERROR" }) } });
}

export async function recordSyncOutcome(k: IntegrationKey, outcome: "SUCCEEDED" | "PARTIAL" | "FAILED", error: { message: string; category: ErrorCategory; retryable: boolean } | null): Promise<void> {
  const row = await prisma.integrationConfig.findUnique({ where: { key: k }, select: { enabled: true } });
  const now = new Date();
  if (outcome === "SUCCEEDED") await prisma.integrationConfig.update({ where: { key: k }, data: { lastAttemptAt: now, lastSyncAt: now, lastConnectedAt: now, lastError: null, lastErrorCategory: null, status: row?.enabled === false ? "DISABLED" : "CONNECTED" } });
  else if (outcome === "PARTIAL") await prisma.integrationConfig.update({ where: { key: k }, data: { lastAttemptAt: now, lastSyncAt: now, lastConnectedAt: now, lastError: error?.message.slice(0, 1000) ?? "some rows failed", lastErrorCategory: error?.category ?? "VALIDATION", status: row?.enabled === false ? "DISABLED" : "DEGRADED" } });
  else await prisma.integrationConfig.update({ where: { key: k }, data: { lastAttemptAt: now, lastError: error?.message.slice(0, 1000) ?? "sync failed", lastErrorCategory: error?.category ?? "UNKNOWN", status: row?.enabled === false ? "DISABLED" : error?.retryable ? "DEGRADED" : "ERROR" } });
}

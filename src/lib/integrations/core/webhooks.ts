/**
 * Inbound events. Verification is the provider's own scheme (HMAC signature, shared secret
 * header, or basic auth) chosen in configuration; receipt is idempotent by event id; the
 * payload itself is never stored — a bounded, redacted summary is.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { AuthenticationError } from "./errors";
import type { IntegrationKey } from "./config";

export type WebhookAuth =
  | { mode: "hmac-sha256"; secret: string; header: string; encoding?: "hex" | "base64"; prefix?: string }
  | { mode: "shared-secret"; secret: string; header: string }
  | { mode: "basic"; username: string; password: string }
  | { mode: "none" };

export function verifyWebhook(auth: WebhookAuth, headers: Headers, rawBody: string): void {
  switch (auth.mode) {
    case "none": return;
    case "shared-secret": {
      const given = headers.get(auth.header) ?? "";
      if (!given || !safeEqual(given, auth.secret)) throw new AuthenticationError(`webhook rejected: header ${auth.header} did not match the configured secret`);
      return;
    }
    case "basic": {
      const h = headers.get("authorization") ?? "";
      const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
      if (!safeEqual(h, expected)) throw new AuthenticationError("webhook rejected: basic credentials did not match");
      return;
    }
    case "hmac-sha256": {
      const given = (headers.get(auth.header) ?? "").replace(auth.prefix ?? "", "").trim();
      const want = createHmac("sha256", auth.secret).update(rawBody).digest(auth.encoding ?? "hex");
      if (!given || !safeEqual(given, want)) throw new AuthenticationError(`webhook rejected: ${auth.header} signature did not verify`);
      return;
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Record receipt; returns false when this event id was already seen (idempotent). */
export async function receiveEvent(k: IntegrationKey, eventId: string, eventType: string | null, payloadHash: string | null, summary: unknown): Promise<{ id: string; duplicate: boolean }> {
  const existing = await prisma.integrationInboundEvent.findUnique({ where: { integrationKey_eventId: { integrationKey: k, eventId } }, select: { id: true } });
  if (existing) { log.info("integration.webhook.duplicate", { integration: k, eventId }); return { id: existing.id, duplicate: true }; }
  const row = await prisma.integrationInboundEvent.create({ data: { integrationKey: k, eventId, eventType, payloadHash, summaryJson: summary ? JSON.stringify(summary).slice(0, 4000) : null } });
  log.info("integration.webhook.received", { integration: k, eventId, eventType });
  return { id: row.id, duplicate: false };
}

export async function markEvent(id: string, status: "PROCESSED" | "IGNORED" | "FAILED", error: string | null = null): Promise<void> {
  await prisma.integrationInboundEvent.update({ where: { id }, data: { status, processedAt: new Date(), error: error?.slice(0, 1000) ?? null } });
}

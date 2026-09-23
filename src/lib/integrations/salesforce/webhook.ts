/**
 * Salesforce inbound events. Salesforce has no single webhook shape — companies relay
 * Platform Events / Change Data Capture / Outbound Messages through a small middleware (or
 * a Flow HTTP callout). The relay signs the JSON body with the shared secret configured on
 * the integration (HMAC-SHA256 in X-Crosswalk-Signature). The body is:
 *
 *   { "eventId": "…", "type": "account.changed", "accountIds": ["001…"] }
 *
 * Receipt is idempotent by eventId; the handler pulls just those accounts through the
 * adapter and applies them with the normal writers inside a webhook-triggered sync job.
 */
import { createHash } from "node:crypto";
import { readConfig } from "../core/config";
import { verifyWebhook, receiveEvent, markEvent } from "../core/webhooks";
import { AuthenticationError, ConfigurationError, ValidationError, asIntegrationError } from "../core/errors";
import { buildCrm } from "../core/registry";
import { startJob, finishJob, failJob } from "../core/jobs";
import { recordSyncOutcome } from "../core/health";
import { writeAccount } from "../core/writers";
import { log } from "@/lib/log";

export const SIGNATURE_HEADER = "x-crosswalk-signature";

export type SalesforceEvent = { eventId: string; type: string; accountIds?: string[]; opportunityIds?: string[] };

export function parseEvent(raw: string): SalesforceEvent {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new ValidationError("webhook body is not JSON"); }
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object" || typeof b.eventId !== "string" || !b.eventId || typeof b.type !== "string") throw new ValidationError("webhook body needs eventId and type");
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9]{15,18}$/.test(x)).slice(0, 200) : []);
  return { eventId: b.eventId.slice(0, 200), type: b.type.slice(0, 100), accountIds: ids(b.accountIds), opportunityIds: ids(b.opportunityIds) };
}

export async function handleSalesforceWebhook(headers: Headers, rawBody: string, fetchImpl?: typeof fetch): Promise<{ status: number; body: Record<string, unknown> }> {
  const cfg = await readConfig("salesforce");
  if (!cfg || !cfg.enabled) return { status: 404, body: { error: "Salesforce integration is not enabled" } };
  const secret = cfg.secrets.webhookSecret;
  if (!secret) { log.warn("integration.webhook.rejected", { integration: "salesforce", reason: "no webhook secret configured" }); return { status: 403, body: { error: "webhook not configured" } }; }
  try { verifyWebhook({ mode: "hmac-sha256", secret, header: SIGNATURE_HEADER, encoding: "hex" }, headers, rawBody); }
  catch (e) { const err = asIntegrationError(e); log.warn("integration.webhook.rejected", { integration: "salesforce", reason: err.category }); return { status: err instanceof AuthenticationError || err.category === "AUTHENTICATION" ? 401 : 400, body: { error: "signature invalid" } }; }
  let ev: SalesforceEvent;
  try { ev = parseEvent(rawBody); } catch (e) { return { status: 400, body: { error: asIntegrationError(e).message } }; }
  const receipt = await receiveEvent("salesforce", ev.eventId, ev.type, createHash("sha256").update(rawBody).digest("hex"), { type: ev.type, accounts: ev.accountIds?.length ?? 0, opportunities: ev.opportunityIds?.length ?? 0 });
  if (receipt.duplicate) return { status: 200, body: { ok: true, duplicate: true } };
  if (!ev.accountIds?.length) { await markEvent(receipt.id, "IGNORED", "no account ids"); return { status: 202, body: { ok: true, ignored: true } }; }
  const ctx = await startJob("salesforce", cfg.provider, "accounts", "webhook", null, { mappingVersion: cfg.configVersion });
  try {
    const crm = await buildCrm(cfg, { fetchImpl });
    const byIds = (crm as { fetchAccountsByIds?: (ids: string[]) => Promise<Awaited<ReturnType<typeof crm.fetchAccounts>>["records"]> }).fetchAccountsByIds;
    if (!byIds) throw new ConfigurationError("this CRM provider cannot fetch accounts by id");
    const records = await byIds.call(crm, ev.accountIds);
    const system = cfg.provider === "mock" ? "salesforce-mock" : "salesforce";
    ctx.received(records.length);
    for (const a of records) { try { await writeAccount(ctx, system, a); } catch (e) { ctx.rowError("Account", a.externalId, e); } }
    const status = await finishJob(ctx, { eventId: ev.eventId, type: ev.type });
    await recordSyncOutcome("salesforce", status === "PARTIAL" ? "PARTIAL" : "SUCCEEDED", null);
    await markEvent(receipt.id, "PROCESSED");
    return { status: 200, body: { ok: true, jobId: ctx.jobId, applied: records.length, status } };
  } catch (e) {
    const err = await failJob(ctx, e);
    await recordSyncOutcome("salesforce", "FAILED", err);
    await markEvent(receipt.id, "FAILED", err.message);
    // 5xx makes the relay retry; the eventId dedupe makes that safe
    return { status: err.retryable ? 503 : 200, body: { ok: false, jobId: ctx.jobId, error: err.message } };
  }
}

/**
 * IntegrationConfig access: read a resolved configuration (non-secret values, decrypted
 * secrets, mappings), save one from the admin API without ever echoing secrets, and keep the
 * health columns. Secrets are sealed with AES-256-GCM under INTEGRATIONS_ENCRYPTION_KEY
 * (32 bytes, base64 or hex) — outside production a key derived from SESSION_SECRET stands in.
 * A secret value of the form `env:NAME` is not stored as a value at all: it is resolved from
 * the environment (and so from SECRETS_PROVIDER) whenever the adapter needs it.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { ConfigurationError } from "./errors";
import type { FieldSpec } from "./fields";
import { normalizeConfig, validateConfig } from "./fields";
import { parseMappingBundle, type MappingBundle } from "./mapping";

export type IntegrationKey = "salesforce" | "sap" | "gpo:premier" | "gpo:vizient" | "gpo:healthtrust" | "documents" | "fx" | "competitor-contracts";
export const INTEGRATION_KEYS: IntegrationKey[] = ["salesforce", "sap", "gpo:premier", "gpo:vizient", "gpo:healthtrust", "documents", "fx", "competitor-contracts"];
export function isIntegrationKey(k: unknown): k is IntegrationKey { return typeof k === "string" && (INTEGRATION_KEYS as string[]).includes(k); }

export type ResolvedConfig = {
  key: IntegrationKey;
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** decrypted / resolved secrets — only ever handed to adapters */
  secrets: Record<string, string>;
  mapping: MappingBundle;
  scheduleCron: string | null;
  configVersion: number;
  status: string;
};

// ---- sealing ----------------------------------------------------------------------------------

function key(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) throw new ConfigurationError("INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes (64 hex or 44 base64 characters)");
    return buf;
  }
  const session = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && !session) throw new ConfigurationError("INTEGRATIONS_ENCRYPTION_KEY (or SESSION_SECRET) must be set to store integration secrets");
  return Buffer.from(hkdfSync("sha256", session ?? "crosswalk-dev-insecure-session-key", "crosswalk-integrations", "secrets-v1", 32));
}

export function seal(obj: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}
export function open(sealed: string | null | undefined): Record<string, string> {
  if (!sealed) return {};
  const [v, iv, enc, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !enc || !tag) throw new ConfigurationError("Stored integration secrets are unreadable (format)");
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8")) as Record<string, string>;
  } catch {
    throw new ConfigurationError("Stored integration secrets cannot be decrypted — INTEGRATIONS_ENCRYPTION_KEY (or SESSION_SECRET) differs from the one they were saved with; re-enter them");
  }
}

/** `env:NAME` → the environment's value at use time; anything else is the literal. */
export function resolveSecret(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const m = value.match(/^env:([A-Z][A-Z0-9_]*)$/);
  if (!m) return value;
  const v = process.env[m[1]];
  if (!v) throw new ConfigurationError(`Secret "${field}" refers to environment variable ${m[1]}, which is not set`);
  return v;
}

// ---- read / write ---------------------------------------------------------------------------

export async function readConfig(k: IntegrationKey): Promise<ResolvedConfig | null> {
  const row = await prisma.integrationConfig.findUnique({ where: { key: k } });
  if (!row) return null;
  const stored = open(row.secretsJson);
  const secrets: Record<string, string> = {};
  for (const [name, v] of Object.entries(stored)) { const r = resolveSecret(v, name); if (r !== undefined) secrets[name] = r; }
  return { key: k, provider: row.provider, enabled: row.enabled, config: parseJson(row.configJson), secrets, mapping: parseMappingBundle(row.mappingJson), scheduleCron: row.scheduleCron, configVersion: row.configVersion, status: row.status };
}

/** Which secret fields have a stored value (for the UI: `{ set: true }`, never the value); unreadable secrets count as absent. */
export async function secretsPresent(k: IntegrationKey): Promise<Set<string>> {
  return (await secretsState(k)).present;
}

/** Presence per secret field plus, when the stored blob cannot be opened under the current key, the reason (so the UI can say "re-enter"). */
export async function secretsState(k: IntegrationKey): Promise<{ present: Set<string>; unreadable: string | null }> {
  const row = await prisma.integrationConfig.findUnique({ where: { key: k }, select: { secretsJson: true } });
  try { return { present: new Set(Object.keys(open(row?.secretsJson))), unreadable: null }; }
  catch (e) { return { present: new Set(), unreadable: e instanceof Error ? e.message : String(e) }; }
}

export type SaveInput = {
  provider: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** secret fields sent by the form: a value stores it, "" clears it, absent keeps the stored one */
  secrets?: Record<string, string | null | undefined>;
  mapping?: MappingBundle;
  scheduleCron?: string | null;
};

/**
 * Save from the admin API. Validates against the provider's field specs; bumps configVersion;
 * resets health to CONFIGURED (or NOT_CONFIGURED / DISABLED) because a changed configuration
 * has not been tested yet.
 */
export async function saveConfig(k: IntegrationKey, input: SaveInput, specs: FieldSpec[], actorUserId: string | null): Promise<{ status: string; configVersion: number; errors: { field: string; message: string }[] }> {
  const existing = await prisma.integrationConfig.findUnique({ where: { key: k } });
  // Secrets sealed under a key this process does not have (rotated or lost INTEGRATIONS_ENCRYPTION_KEY)
  // must not make every save fail — that is exactly when an admin needs to re-enter them. They are
  // treated as absent for this save: supplied values replace the unreadable blob; a save that supplies
  // none keeps the blob untouched (restoring the old key still recovers it) and reports the problem.
  let storedSecrets: Record<string, string> = {};
  let unreadable: string | null = null;
  try { storedSecrets = open(existing?.secretsJson); } catch (e) { unreadable = e instanceof Error ? e.message : String(e); }
  const nextSecrets: Record<string, string> = { ...storedSecrets };
  for (const [name, v] of Object.entries(input.secrets ?? {})) {
    const spec = specs.find((s) => s.name === name && s.secret);
    if (!spec) continue;
    if (v === undefined) continue;
    if (v === null || v === "") delete nextSecrets[name];
    else nextSecrets[name] = String(v);
  }
  // Secrets for fields the new provider does not have are dropped, so a provider switch leaves nothing behind.
  for (const name of Object.keys(nextSecrets)) if (!specs.some((s) => s.name === name && s.secret)) delete nextSecrets[name];
  let config: Record<string, unknown>;
  try { config = normalizeConfig(input.config ?? {}, specs); } catch (e) { return { status: existing?.status ?? "NOT_CONFIGURED", configVersion: existing?.configVersion ?? 0, errors: [{ field: "config", message: e instanceof Error ? e.message : String(e) }] }; }
  const v = validateConfig(config, specs, new Set(Object.keys(nextSecrets)));
  const keepUnreadable = unreadable !== null && Object.keys(nextSecrets).length === 0;
  if (keepUnreadable) { v.ok = false; v.errors.push({ field: "secrets", message: unreadable! }); }
  const enabled = input.enabled ?? existing?.enabled ?? false;
  const status = !enabled ? "DISABLED" : v.ok ? "CONFIGURED" : "NOT_CONFIGURED";
  const data = {
    provider: input.provider, enabled,
    configJson: JSON.stringify(config),
    secretsJson: keepUnreadable ? existing!.secretsJson : Object.keys(nextSecrets).length ? seal(nextSecrets) : null,
    mappingJson: JSON.stringify(input.mapping ?? parseMappingBundle(existing?.mappingJson)),
    scheduleCron: input.scheduleCron === undefined ? existing?.scheduleCron ?? null : input.scheduleCron,
    configVersion: (existing?.configVersion ?? 0) + 1,
    status, lastTestAt: null, lastTestOk: null, lastError: v.ok ? null : v.errors.map((e) => e.message).join("; "), lastErrorCategory: v.ok ? null : "CONFIGURATION",
    updatedByUserId: actorUserId,
  };
  const row = await prisma.integrationConfig.upsert({ where: { key: k }, create: { key: k, ...data }, update: data });
  return { status: row.status, configVersion: row.configVersion, errors: v.errors };
}

/** Make sure a row exists (jobs reference it) without changing anything already there. */
export async function ensureConfigRow(k: IntegrationKey, provider: string): Promise<void> {
  await prisma.integrationConfig.upsert({ where: { key: k }, create: { key: k, provider, status: "NOT_CONFIGURED" }, update: {} });
}

export async function setCursor(k: IntegrationKey, syncType: string, cursor: string | null): Promise<void> {
  const row = await prisma.integrationConfig.findUnique({ where: { key: k }, select: { cursorJson: true } });
  const cursors = parseJson(row?.cursorJson ?? "{}") as Record<string, string | null>;
  cursors[syncType] = cursor;
  await prisma.integrationConfig.update({ where: { key: k }, data: { cursorJson: JSON.stringify(cursors) } });
}
export async function getCursor(k: IntegrationKey, syncType: string): Promise<string | null> {
  const row = await prisma.integrationConfig.findUnique({ where: { key: k }, select: { cursorJson: true } });
  return ((parseJson(row?.cursorJson ?? "{}") as Record<string, string | null>)[syncType]) ?? null;
}

function parseJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

/** Redact anything secret-shaped from an arbitrary object before it leaves the server. */
export function redactSecrets<T>(value: T, secretFields: Iterable<string>): T {
  const names = new Set([...secretFields].map((s) => s.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = names.has(k.toLowerCase()) || /secret|password|token|apikey|api_key|private/i.test(k) ? (x ? "[set]" : x) : walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

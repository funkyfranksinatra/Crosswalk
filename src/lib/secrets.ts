/**
 * Secret loading and production safety checks (Tier 0.3).
 *
 * Secrets reach the process one of two ways: as environment variables (a .env file, the
 * container's environment, a Kubernetes secret mounted as env) or from a secret manager
 * selected by SECRETS_PROVIDER, fetched once at start-up and copied into process.env so the
 * rest of the code never knows the difference.
 *
 *   SECRETS_PROVIDER=env      nothing to fetch (default)
 *   SECRETS_PROVIDER=aws      AWS Secrets Manager — AWS_SECRET_ID (a JSON secret of key/values);
 *                             credentials from the usual chain; needs @aws-sdk/client-secrets-manager
 *   SECRETS_PROVIDER=vault    HashiCorp Vault KV v2 — VAULT_ADDR, VAULT_TOKEN (or VAULT_TOKEN_FILE),
 *                             VAULT_SECRET_PATH (e.g. secret/data/crosswalk/prod), VAULT_NAMESPACE
 *   SECRETS_PROVIDER=doppler  Doppler — DOPPLER_TOKEN (a service token bound to project + config)
 *   SECRETS_PROVIDER=file     a JSON file of key/values — SECRETS_FILE (a mounted secret volume)
 *
 * A key already present and non-empty in the environment is never overwritten (the deploy
 * environment wins; set SECRETS_OVERRIDE=true to let the provider win). Values are never
 * logged; only the key names that were loaded.
 *
 * `assertProductionSecrets()` refuses to start a production build with the development
 * session key, a database password from an example file, or a secret that is obviously a
 * placeholder. It runs from instrumentation (web), the worker and the container entrypoint.
 */
import fs from "node:fs";
import { log } from "@/lib/log";

export type SecretsProvider = "env" | "aws" | "vault" | "doppler" | "file";

export function secretsProvider(): SecretsProvider {
  const p = (process.env.SECRETS_PROVIDER ?? "env").trim().toLowerCase();
  if (["env", "aws", "vault", "doppler", "file"].includes(p)) return p as SecretsProvider;
  throw new Error(`SECRETS_PROVIDER must be env | aws | vault | doppler | file (got '${p}')`);
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function setSecretsFetchForTests(f: typeof fetch | null) { if (!process.env.VITEST) throw new Error("test seam"); fetchImpl = f ?? ((...a) => fetch(...a)); }

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required for SECRETS_PROVIDER=${secretsProvider()}`);
  return v;
}

/** Only string-valued keys survive; nested objects are flattened one level as PARENT_CHILD. */
export function flattenSecrets(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = `${prefix}${k}`;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = String(v);
    else if (v && typeof v === "object" && !Array.isArray(v) && !prefix) Object.assign(out, flattenSecrets(v, `${key}_`));
  }
  return out;
}

async function fromAws(): Promise<Record<string, string>> {
  const id = need("AWS_SECRET_ID");
  let mod: { SecretsManagerClient: new (o: object) => { send(cmd: unknown): Promise<{ SecretString?: string }> }; GetSecretValueCommand: new (o: object) => unknown };
  try {
    mod = (await import(/* webpackIgnore: true */ "@aws-sdk/client-secrets-manager" as string)) as typeof mod;
  } catch {
    throw new Error("SECRETS_PROVIDER=aws needs @aws-sdk/client-secrets-manager (npm install @aws-sdk/client-secrets-manager)");
  }
  const client = new mod.SecretsManagerClient(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {});
  const res = await client.send(new mod.GetSecretValueCommand({ SecretId: id }));
  if (!res.SecretString) throw new Error(`AWS secret ${id} has no SecretString (binary secrets are not supported)`);
  return flattenSecrets(JSON.parse(res.SecretString));
}

async function fromVault(): Promise<Record<string, string>> {
  const addr = need("VAULT_ADDR").replace(/\/$/, "");
  const path = need("VAULT_SECRET_PATH").replace(/^\//, "");
  const token = process.env.VAULT_TOKEN?.trim() || (process.env.VAULT_TOKEN_FILE ? fs.readFileSync(process.env.VAULT_TOKEN_FILE, "utf8").trim() : "");
  if (!token) throw new Error("VAULT_TOKEN or VAULT_TOKEN_FILE is required for SECRETS_PROVIDER=vault");
  const headers: Record<string, string> = { "x-vault-token": token, accept: "application/json" };
  if (process.env.VAULT_NAMESPACE) headers["x-vault-namespace"] = process.env.VAULT_NAMESPACE;
  const res = await fetchImpl(`${addr}/v1/${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Vault returned ${res.status} for ${path}`);
  const body = (await res.json()) as { data?: { data?: unknown } | Record<string, unknown> };
  // KV v2 nests under data.data; KV v1 is data.
  const data = body.data && typeof body.data === "object" && "data" in body.data && typeof (body.data as { data?: unknown }).data === "object" ? (body.data as { data: unknown }).data : body.data;
  return flattenSecrets(data);
}

async function fromDoppler(): Promise<Record<string, string>> {
  const token = need("DOPPLER_TOKEN");
  const u = new URL("https://api.doppler.com/v3/configs/config/secrets/download");
  u.searchParams.set("format", "json");
  if (process.env.DOPPLER_PROJECT) u.searchParams.set("project", process.env.DOPPLER_PROJECT);
  if (process.env.DOPPLER_CONFIG) u.searchParams.set("config", process.env.DOPPLER_CONFIG);
  const res = await fetchImpl(u, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Doppler returned ${res.status}`);
  return flattenSecrets(await res.json());
}

function fromFile(): Record<string, string> {
  const file = need("SECRETS_FILE");
  const raw = fs.readFileSync(file, "utf8");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return flattenSecrets(JSON.parse(trimmed));
  // KEY=value lines (a .env-style mounted secret)
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

let loaded: Promise<string[]> | null = null;

/**
 * Fetch from the configured provider and copy into process.env. Idempotent per process.
 * Returns the names of the keys that were set. Throws when the provider is configured but
 * unreachable — a deployment that cannot read its secrets must not come up half-configured.
 */
export function loadSecrets(): Promise<string[]> {
  if (!loaded) loaded = doLoad().catch((e) => { loaded = null; throw e; });
  return loaded;
}
export function resetSecretsForTests() { if (!process.env.VITEST) throw new Error("test seam"); loaded = null; }

async function doLoad(): Promise<string[]> {
  const provider = secretsProvider();
  if (provider === "env") return [];
  const values = provider === "aws" ? await fromAws() : provider === "vault" ? await fromVault() : provider === "doppler" ? await fromDoppler() : fromFile();
  const override = (process.env.SECRETS_OVERRIDE ?? "").toLowerCase() === "true";
  const set: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
    if (!override && process.env[k]?.trim()) continue;
    process.env[k] = v;
    set.push(k);
  }
  log.info("secrets.loaded", { provider, keys: set.sort() });
  return set;
}

// ---------------------------------------------------------------------------------------------
// Production safety

const DEV_SESSION_KEY = "crosswalk-dev-insecure-session-key";
const PLACEHOLDERS = /^(changeme|change-me|password|secret|example|test|todo|xxx+|replace[-_ ]?me|your[-_].*)$/i;
const WEAK_DB_CREDS = [/\/\/crosswalk:crosswalk@/, /\/\/postgres:postgres@/, /:(password|changeme|postgres|secret|example)@/i];

export type SecretProblem = { key: string; problem: string };

/**
 * Pure check over an environment map; returns every problem found. `production` decides
 * whether the strict rules apply (a `next dev` box is allowed the insecure defaults).
 */
export function checkSecrets(env: NodeJS.ProcessEnv, production: boolean): SecretProblem[] {
  const out: SecretProblem[] = [];
  const val = (k: string) => env[k]?.trim() ?? "";
  const sso = Boolean(val("SSO_ISSUER") && val("SSO_CLIENT_ID"));
  if (!production) return out;
  const session = val("SESSION_SECRET");
  if (!session) {
    if (sso || val("ALLOW_DEV_SIGNIN") === "true") out.push({ key: "SESSION_SECRET", problem: "not set — sessions cannot be signed" });
  } else if (session === DEV_SESSION_KEY) out.push({ key: "SESSION_SECRET", problem: "is the development key" });
  else if (session.length < 16) out.push({ key: "SESSION_SECRET", problem: "shorter than 16 characters" });
  else if (PLACEHOLDERS.test(session)) out.push({ key: "SESSION_SECRET", problem: "is a placeholder" });
  const db = val("DATABASE_URL");
  if (db && WEAK_DB_CREDS.some((re) => re.test(db))) out.push({ key: "DATABASE_URL", problem: "uses a default or placeholder password" });
  if (db && !/sslmode=/.test(db) && !/@(localhost|127\.0\.0\.1|db|postgres)([:/]|$)/.test(db)) out.push({ key: "DATABASE_URL", problem: "has no sslmode for a remote database" });
  for (const k of ["SSO_CLIENT_SECRET", "OPENAI_API_KEY", "METRICS_TOKEN", "AVATAX_LICENSE_KEY", "SAM_API_KEY", "SF_CLIENT_SECRET"]) {
    const v = val(k);
    if (v && PLACEHOLDERS.test(v)) out.push({ key: k, problem: "is a placeholder" });
  }
  if (val("ALLOW_DEV_SIGNIN") === "true" && !sso) out.push({ key: "ALLOW_DEV_SIGNIN", problem: "development sign-in is enabled on a production build (demo instances only)" });
  return out;
}

/**
 * Refuse to run a production build with weak or default secrets. ALLOW_DEV_SIGNIN on its own
 * is a warning (it is the documented demo-box escape hatch); everything else is fatal.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const production = env.NODE_ENV === "production";
  const problems = checkSecrets(env, production);
  const fatal = problems.filter((p) => p.key !== "ALLOW_DEV_SIGNIN");
  for (const p of problems.filter((p) => p.key === "ALLOW_DEV_SIGNIN")) log.warn("secrets.warning", { key: p.key, problem: p.problem });
  if (!fatal.length) return;
  for (const p of fatal) log.error("secrets.refused", { key: p.key, problem: p.problem });
  throw new Error(`Refusing to start: ${fatal.map((p) => `${p.key} ${p.problem}`).join("; ")}. See docs/DEPLOYMENT.md#secrets.`);
}

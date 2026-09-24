/**
 * WS5 — configuration and environment (docs/BUILD_NOTES.md §5): strict readers, JOBS_WORKER modes,
 * pool sizes and adapter names, the Prisma CLI's direct-host derivation for Neon pooler URLs, the
 * neon-http adapter's refusal to open a transaction, the secrets loader's remote providers through
 * a controlled fetch (Vault KV v1/v2, Doppler, AWS without its SDK), SECRETS_OVERRIDE precedence,
 * redaction of the `secrets.loaded` log line, and the retention / alert / feed parsers' bounds.
 * No database, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, afterEach, vi } from "vitest";
import { intEnv, boolEnv, enumEnv, resetEnvWarningsForTests } from "@/lib/env";
import { onLog } from "@/lib/log";
import { loadSecrets, resetSecretsForTests, setSecretsFetchForTests, secretsProvider, checkSecrets } from "@/lib/secrets";
import { retentionConfig } from "@/lib/retention";
import { feedCron, feedMaxAgeHours } from "@/lib/feeds";
import { redactMessage } from "@/lib/integrations/core/errors";
import { tenancyStrict, defaultLabelers, defaultCompanyName } from "@/lib/tenancy";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; resetSecretsForTests(); setSecretsFetchForTests(null); resetEnvWarningsForTests(); });

describe("strict environment readers", () => {
  test("integers: default, bounds, non-numeric and fractional values fall back and are logged once", () => {
    const lines: Record<string, unknown>[] = [];
    const off = onLog((l) => { if (l.event === "env.invalid") lines.push(l); });
    expect(intEnv("WS5_X", 7, {}, {})).toBe(7);
    expect(intEnv("WS5_X", 7, {}, { WS5_X: " 12 " })).toBe(12);
    expect(intEnv("WS5_X", 7, { min: 1, max: 10 }, { WS5_X: "0" })).toBe(7);
    expect(intEnv("WS5_X", 7, { min: 1, max: 10 }, { WS5_X: "11" })).toBe(7);
    expect(intEnv("WS5_X", 7, {}, { WS5_X: "abc" })).toBe(7);
    expect(intEnv("WS5_X", 7, {}, { WS5_X: "2.5" })).toBe(7);
    expect(intEnv("WS5_X", 7, {}, { WS5_X: "abc" })).toBe(7); // same bad value: not logged twice
    off();
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatchObject({ name: "WS5_X", problem: expect.stringMatching(/minimum/), using: 7 });
  });

  test('booleans: only "true"/"false"; "on", "yes", "1" are not true; enums are case-insensitive and closed', () => {
    expect(boolEnv("B", false, { B: "true" })).toBe(true);
    expect(boolEnv("B", true, { B: "FALSE" })).toBe(false);
    for (const v of ["on", "yes", "1", "enabled"]) expect(boolEnv("B", false, { B: v })).toBe(false);
    expect(boolEnv("B", true, {})).toBe(true);
    expect(enumEnv("M", ["inline", "external", "off"] as const, "inline", { M: "External" })).toBe("external");
    expect(enumEnv("M", ["inline", "external", "off"] as const, "inline", { M: "on" })).toBe("inline");
    expect(enumEnv("M", ["inline", "external", "off"] as const, "inline", {})).toBe("inline");
  });

  test("JOBS_WORKER: inline | external | off; 'on' is not a mode (logged, read as inline so jobs are still worked); pool and maintenance bounds", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/x";
    const { jobsMode, jobsEnabled } = await import("@/lib/jobs/boss");
    process.env.JOBS_WORKER = "off"; expect(jobsMode()).toBe("off"); expect(jobsEnabled()).toBe(false);
    process.env.JOBS_WORKER = "external"; expect(jobsMode()).toBe("external"); expect(jobsEnabled()).toBe(true);
    process.env.JOBS_WORKER = "on"; expect(jobsMode()).toBe("inline"); expect(jobsEnabled()).toBe(true);
    delete process.env.JOBS_WORKER; expect(jobsMode()).toBe("inline");
    expect(intEnv("JOBS_POOL_MAX", 3, { min: 1, max: 100 }, { JOBS_POOL_MAX: "NaN" })).toBe(3);
    expect(intEnv("JOBS_MAINTENANCE_SECONDS", 60, { min: 1, max: 86_400 }, { JOBS_MAINTENANCE_SECONDS: "0" })).toBe(60);
  });

  test("DATABASE_POOL_MAX is 1–200 or the default; DATABASE_ADAPTER is a closed list and an unknown value is refused, not 'pg'", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/x";
    const { poolMax, adapterKind, strictSsl } = await import("@/lib/db");
    expect(poolMax({})).toBe(5); expect(poolMax({ DATABASE_POOL_MAX: "20" })).toBe(20); expect(poolMax({ DATABASE_POOL_MAX: "abc" })).toBe(5); expect(poolMax({ DATABASE_POOL_MAX: "0" })).toBe(5); expect(poolMax({ DATABASE_POOL_MAX: "500" })).toBe(5);
    expect(adapterKind({})).toBe("pg"); expect(adapterKind({ DATABASE_ADAPTER: "Neon-WS" })).toBe("neon-ws"); expect(adapterKind({ DATABASE_ADAPTER: "neon-http" })).toBe("neon-http");
    expect(() => adapterKind({ DATABASE_ADAPTER: "mysql" })).toThrow(/DATABASE_ADAPTER must be/);
    expect(strictSsl("postgresql://u:p@h/db?sslmode=require")).toContain("sslmode=verify-full");
    expect(strictSsl("postgresql://u:p@h/db?sslmode=require&uselibpqcompat=true")).toContain("sslmode=require");
    expect(strictSsl("not a url")).toBe("not a url");
  });

  test("the neon-http adapter refuses to open a transaction with a clear message (every $transaction call site fails before writing anything)", async () => {
    const { PrismaNeonHttp } = await import("@prisma/adapter-neon");
    const adapter = new PrismaNeonHttp("postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db?sslmode=require", {});
    const conn = (await adapter.connect()) as { startTransaction(): Promise<unknown> };
    await expect(conn.startTransaction()).rejects.toThrow(/Transactions are not supported in HTTP mode/);
  });

  test("prisma.config.ts: DIRECT_DATABASE_URL wins; a Neon pooler host loses its -pooler segment; other URLs pass through untouched", async () => {
    const load = async (vars: Record<string, string | undefined>) => {
      for (const k of ["DIRECT_DATABASE_URL", "DATABASE_URL"]) delete process.env[k];
      Object.assign(process.env, vars);
      vi.resetModules();
      const cfg = (await import("../../prisma.config")).default as unknown as { datasource: { url: string } };
      return cfg.datasource.url;
    };
    expect(await load({ DATABASE_URL: "postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require" })).toBe("postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require");
    expect(await load({ DATABASE_URL: "postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb" })).toBe("postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb");
    expect(await load({ DATABASE_URL: "postgresql://u:p@localhost:5432/crosswalk_ws5" })).toBe("postgresql://u:p@localhost:5432/crosswalk_ws5");
    expect(await load({ DATABASE_URL: "postgresql://u:p@my-pooler.example.com/db" })).toBe("postgresql://u:p@my-pooler.example.com/db"); // only Neon hosts are rewritten
    expect(await load({ DATABASE_URL: "postgresql://u:p@ep-a-pooler.eu-central-1.aws.neon.tech/db", DIRECT_DATABASE_URL: "postgresql://direct@host/db" })).toBe("postgresql://direct@host/db");
    expect(await load({})).toBe("postgresql://localhost:5432/crosswalk");
  });
});

describe("secrets loader", () => {
  test("SECRETS_PROVIDER is validated; the remote providers need their settings", async () => {
    process.env.SECRETS_PROVIDER = "consul";
    expect(() => secretsProvider()).toThrow(/env \| aws \| vault \| doppler \| file/);
    await expect(loadSecrets()).rejects.toThrow(/SECRETS_PROVIDER/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "vault"; delete process.env.VAULT_ADDR;
    await expect(loadSecrets()).rejects.toThrow(/VAULT_ADDR is required/);
    resetSecretsForTests(); process.env.VAULT_ADDR = "https://vault.example"; process.env.VAULT_SECRET_PATH = "secret/data/crosswalk"; delete process.env.VAULT_TOKEN; delete process.env.VAULT_TOKEN_FILE;
    await expect(loadSecrets()).rejects.toThrow(/VAULT_TOKEN or VAULT_TOKEN_FILE/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "doppler"; delete process.env.DOPPLER_TOKEN;
    await expect(loadSecrets()).rejects.toThrow(/DOPPLER_TOKEN is required/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "aws"; process.env.AWS_SECRET_ID = "crosswalk/prod";
    await expect(loadSecrets()).rejects.toThrow(/needs @aws-sdk\/client-secrets-manager/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "file"; delete process.env.SECRETS_FILE;
    await expect(loadSecrets()).rejects.toThrow(/SECRETS_FILE is required/);
    resetSecretsForTests(); process.env.SECRETS_PROVIDER = "env";
    expect(await loadSecrets()).toEqual([]);
  });

  test("Vault: KV v2 (data.data) and KV v1 (data) through a controlled fetch; token from a file; namespace header; a non-2xx is an error; values never appear in the log", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const lines: string[] = [];
    const off = onLog((l) => lines.push(JSON.stringify(l)));
    setSecretsFetchForTests(async (url, init) => {
      calls.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      if (String(url).endsWith("/v1/secret/data/crosswalk")) return new Response(JSON.stringify({ data: { data: { WS5_V2: "vault-v2-value", lower: "ignored", NESTED: { CHILD: "c" } }, metadata: { version: 3 } } }), { status: 200 });
      if (String(url).endsWith("/v1/kv/crosswalk")) return new Response(JSON.stringify({ data: { WS5_V1: "vault-v1-value" } }), { status: 200 });
      return new Response("denied", { status: 403 });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws5-vault-"));
    fs.writeFileSync(path.join(dir, "token"), "s.file-token\n");
    Object.assign(process.env, { SECRETS_PROVIDER: "vault", VAULT_ADDR: "https://vault.example/", VAULT_SECRET_PATH: "/secret/data/crosswalk", VAULT_TOKEN_FILE: path.join(dir, "token"), VAULT_NAMESPACE: "team-a" });
    delete process.env.VAULT_TOKEN; delete process.env.WS5_V2; delete process.env.NESTED_CHILD;
    expect((await loadSecrets()).sort()).toEqual(["NESTED_CHILD", "WS5_V2"]);
    expect(process.env.WS5_V2).toBe("vault-v2-value"); expect(process.env.NESTED_CHILD).toBe("c"); expect(process.env.lower).toBeUndefined();
    expect(calls[0].url).toBe("https://vault.example/v1/secret/data/crosswalk");
    expect(calls[0].headers["x-vault-token"]).toBe("s.file-token"); expect(calls[0].headers["x-vault-namespace"]).toBe("team-a");
    resetSecretsForTests(); process.env.VAULT_SECRET_PATH = "kv/crosswalk"; delete process.env.WS5_V1;
    expect(await loadSecrets()).toEqual(["WS5_V1"]); expect(process.env.WS5_V1).toBe("vault-v1-value");
    resetSecretsForTests(); process.env.VAULT_SECRET_PATH = "secret/data/other";
    await expect(loadSecrets()).rejects.toThrow(/Vault returned 403/);
    off();
    const loaded = lines.filter((l) => l.includes("secrets.loaded"));
    expect(loaded.length).toBe(2);
    expect(lines.join("\n")).not.toMatch(/vault-v2-value|vault-v1-value|s\.file-token/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("Doppler: project/config in the query, bearer token, JSON body; SECRETS_OVERRIDE decides who wins", async () => {
    let seen: { url: string; auth: string } | null = null;
    setSecretsFetchForTests(async (url, init) => { seen = { url: String(url), auth: (init?.headers as Record<string, string>).authorization }; return new Response(JSON.stringify({ WS5_D: "doppler-value", WS5_KEEP: "doppler-keep" }), { status: 200 }); });
    Object.assign(process.env, { SECRETS_PROVIDER: "doppler", DOPPLER_TOKEN: "dp.st.token", DOPPLER_PROJECT: "crosswalk", DOPPLER_CONFIG: "prd", WS5_KEEP: "from-env" });
    delete process.env.WS5_D; delete process.env.SECRETS_OVERRIDE;
    expect(await loadSecrets()).toEqual(["WS5_D"]);
    expect(process.env.WS5_KEEP).toBe("from-env");
    expect(seen!.url).toBe("https://api.doppler.com/v3/configs/config/secrets/download?format=json&project=crosswalk&config=prd");
    expect(seen!.auth).toBe("Bearer dp.st.token");
    resetSecretsForTests(); process.env.SECRETS_OVERRIDE = "true";
    expect((await loadSecrets()).sort()).toEqual(["WS5_D", "WS5_KEEP"]);
    expect(process.env.WS5_KEEP).toBe("doppler-keep");
    resetSecretsForTests(); process.env.SECRETS_OVERRIDE = "yes"; process.env.WS5_KEEP = "from-env-again"; // only "true" overrides
    await loadSecrets(); expect(process.env.WS5_KEEP).toBe("from-env-again");
    // loadSecrets is idempotent per process and a failure is retriable (the promise is not cached)
    resetSecretsForTests();
    setSecretsFetchForTests(async () => new Response("", { status: 500 }));
    await expect(loadSecrets()).rejects.toThrow(/Doppler returned 500/);
    setSecretsFetchForTests(async () => new Response(JSON.stringify({ WS5_D: "second-try" }), { status: 200 }));
    delete process.env.WS5_D;
    expect(await loadSecrets()).toEqual(["WS5_D"]);
  });

  test("checkSecrets production matrix: loopback vs private vs remote, sslmode, placeholders in every checked key", () => {
    const base = { SESSION_SECRET: "a-perfectly-fine-long-random-secret", DATABASE_URL: "postgresql://app:pw@db.example.com/x?sslmode=require" };
    expect(checkSecrets(base, true)).toEqual([]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://postgres:postgres@10.0.0.5:5432/x?sslmode=require" }, true)).toMatchObject([{ key: "DATABASE_URL" }]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://app:password@db.example.com/x?sslmode=require" }, true)).toMatchObject([{ key: "DATABASE_URL", problem: /placeholder/ }]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://app:pw@host.docker.internal:5432/x" }, true)).toEqual([]);
    expect(checkSecrets({ ...base, DATABASE_URL: "postgresql://app:pw@[::1]:5432/x" }, true)).toEqual([]);
    for (const k of ["SSO_CLIENT_SECRET", "METRICS_TOKEN", "AVATAX_LICENSE_KEY", "SAM_API_KEY", "SF_CLIENT_SECRET"]) expect(checkSecrets({ ...base, [k]: "xxxx" }, true)).toMatchObject([{ key: k, problem: /placeholder/ }]);
    expect(checkSecrets({ ...base, METRICS_TOKEN: "xxxx" }, false)).toEqual([]);
  });

  test("redaction covers bearer/basic tokens, key=value secrets, provider key prefixes, PEM blocks and URL credentials", () => {
    const s = redactMessage("bearer abcdefghijklmnop basic QUJDREVGR0hJSg== api_key=SECRETVALUE1 password: 'hunter22' sk_live_abcdefghij npg_abcdefghijk https://user:pa55word@host/db -----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----");
    expect(s).not.toMatch(/abcdefghijklmnop|QUJDREVGR0hJSg|SECRETVALUE1|hunter22|sk_live_abcdefghij|npg_abcdefghijk|pa55word|xyz/);
    expect(s).toContain("https://user:[redacted]@host/db");
  });
});

describe("other parsers", () => {
  test("retention windows: unset → defaults, off/never/none/0 → null, malformed → throws; batch bounded", () => {
    const d = retentionConfig({});
    expect(d.enabled).toBe(false); expect(d.days).toEqual({ requests: null, llmCalls: 90, syncLog: 180, feedRuns: 180, notifications: 180, snapshots: 90, alerts: 90 });
    expect(retentionConfig({ RETENTION_ALERTS_DAYS: "never" }).days.alerts).toBeNull();
    expect(retentionConfig({ RETENTION_REQUESTS_DAYS: " 30 " }).days.requests).toBe(30);
    expect(retentionConfig({ RETENTION_REQUESTS_DAYS: "30.9" }).days.requests).toBe(30);
    expect(() => retentionConfig({ RETENTION_FEED_RUNS_DAYS: "-1" })).toThrow(/whole number/);
    expect(retentionConfig({ RETENTION_BATCH: "999999999" }).batch).toBe(100_000);
    expect(retentionConfig({ RETENTION_ENABLED: "yes" }).enabled).toBe(false);
    expect(retentionConfig({ RETENTION_DRY_RUN: "TRUE" }).dryRun).toBe(true);
  });

  test("feed schedule and age overrides; tenancy strictness and company defaults", () => {
    process.env.FEED_COMPETITOR_PRICES_CRON = "off"; expect(feedCron("competitor-prices")).toBeNull();
    process.env.FEED_COMPETITOR_PRICES_CRON = "  "; expect(feedCron("competitor-prices")).toBe("45 2 * * *");
    process.env.FEED_ERP_MAX_AGE_HOURS = "-5"; expect(feedMaxAgeHours("erp")).toBe(36);
    process.env.FEED_ERP_MAX_AGE_HOURS = "72"; expect(feedMaxAgeHours("erp")).toBe(72);
    expect(tenancyStrict({})).toBe(true); expect(tenancyStrict({ TENANCY_STRICT: "false" })).toBe(false); expect(tenancyStrict({ TENANCY_STRICT: "no" })).toBe(true);
    expect(defaultCompanyName({})).toBe("Medtronic"); expect(defaultCompanyName({ COMPANY_NAME: "  Acme " })).toBe("Acme");
    expect(defaultLabelers({ OWN_LABELERS: "Acme Surgical, acme surgical, Acme" })).toEqual(["Acme Surgical", "Acme"]);
  });
});

/**
 * Salesforce authentication. Two server-to-server flows, chosen in configuration:
 *   client-credentials  — a Connected App with the Client Credentials flow enabled and a
 *                         "run as" user (Setup → App Manager → Edit Policies)
 *   jwt-bearer          — a Connected App with a certificate; the app signs a JWT (RS256)
 *                         with the private key and exchanges it for a token; no secret
 *                         travels, the user must be pre-authorised
 * Tokens are cached per (login URL, client id) and refreshed on 401 or after `TOKEN_TTL_MS`.
 * Nothing here logs the token, the secret or the key.
 */
import { SignJWT, importPKCS8 } from "jose";
import { httpJson } from "../core/http";
import { AuthenticationError, ConfigurationError } from "../core/errors";

export type SalesforceAuthConfig =
  | { flow: "client-credentials"; loginUrl: string; clientId: string; clientSecret: string }
  | { flow: "jwt-bearer"; loginUrl: string; clientId: string; username: string; privateKeyPem: string; audience?: string | null };

export type SalesforceToken = { accessToken: string; instanceUrl: string; issuedAt: number };

const TOKEN_TTL_MS = 50 * 60 * 1000;
const cache = new Map<string, SalesforceToken>();
const cacheKey = (c: SalesforceAuthConfig) => `${c.loginUrl}|${c.clientId}|${c.flow}`;

export function clearSalesforceTokenCache() { cache.clear(); }

export async function salesforceToken(cfg: SalesforceAuthConfig, force = false, fetchImpl?: typeof fetch): Promise<SalesforceToken> {
  const k = cacheKey(cfg);
  const hit = cache.get(k);
  if (hit && !force && Date.now() - hit.issuedAt < TOKEN_TTL_MS) return hit;
  const loginUrl = cfg.loginUrl.replace(/\/$/, "");
  if (!/^https:\/\//.test(loginUrl)) throw new ConfigurationError("Salesforce login URL must be https:// (https://login.salesforce.com, https://test.salesforce.com or your My Domain)");
  const body = new URLSearchParams();
  if (cfg.flow === "client-credentials") {
    body.set("grant_type", "client_credentials"); body.set("client_id", cfg.clientId); body.set("client_secret", cfg.clientSecret);
  } else {
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.set("assertion", await signAssertion(cfg));
  }
  const res = await httpJson<{ access_token?: string; instance_url?: string; error?: string; error_description?: string }>(`${loginUrl}/services/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { provider: "salesforce", operation: "oauth.token", retries: 1, fetchImpl }).catch((e) => {
    if (e instanceof AuthenticationError || (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 400)) throw new AuthenticationError(`Salesforce did not issue a token: ${(e as Error).message.replace(/^salesforce[^:]*: ?/i, "")}. Check the Connected App's client id/secret, that the ${cfg.flow} flow is enabled, and (JWT) that the user is pre-authorised.`);
    throw e;
  });
  if (!res.body?.access_token || !res.body.instance_url) throw new AuthenticationError(`Salesforce token response was incomplete${res.body?.error ? ` (${res.body.error}: ${res.body.error_description ?? ""})` : ""}`);
  const tok = { accessToken: res.body.access_token, instanceUrl: res.body.instance_url.replace(/\/$/, ""), issuedAt: Date.now() };
  cache.set(k, tok);
  return tok;
}

async function signAssertion(cfg: Extract<SalesforceAuthConfig, { flow: "jwt-bearer" }>): Promise<string> {
  let key;
  try { key = await importPKCS8(cfg.privateKeyPem.replace(/\\n/g, "\n"), "RS256"); } catch { throw new ConfigurationError("The Salesforce private key is not a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)"); }
  return new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(cfg.clientId).setSubject(cfg.username).setAudience(cfg.audience ?? cfg.loginUrl.replace(/\/$/, "")).setExpirationTime("3m").sign(key);
}

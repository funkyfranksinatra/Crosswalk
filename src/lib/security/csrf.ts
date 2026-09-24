/**
 * Cross-site request forgery posture for cookie-authenticated mutations (pure; the proxy wires it).
 *
 * The session cookies are `SameSite=Lax`, which already keeps them off cross-site POSTs in
 * every current browser. This is the second layer: a non-GET /api request that carries a
 * session cookie must demonstrably come from this origin —
 *
 *   1. `Sec-Fetch-Site` (every current browser sends it): `same-origin` or `none` (a typed
 *      URL / bookmark) passes; `same-site` and `cross-site` are refused.
 *   2. Otherwise `Origin` (browsers send it on every non-GET): its host must be the host the
 *      request was addressed to (`X-Forwarded-Host` in front of a proxy, else `Host`) or the
 *      configured APP_BASE_URL host.
 *   3. A request with neither header is not a browser (curl, a script with a copied cookie):
 *      the cookie itself is the credential and there is no forgery vector, so it passes.
 *
 * Returns null when the request may proceed, else a short reason for the 403 body / log.
 */
export function crossSiteReason(headers: Headers, url: URL, env: Record<string, string | undefined> = process.env): string | null {
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) return site === "same-origin" || site === "none" ? null : `sec-fetch-site=${site}`;
  const origin = headers.get("origin")?.trim();
  if (!origin || origin === "null") return origin ? "origin=null" : null;
  let host: string;
  try { host = new URL(origin).host.toLowerCase(); } catch { return "origin unparsable"; }
  return expectedHosts(headers, url, env).has(host) ? null : "origin mismatch";
}

/** Hosts this deployment answers to: the forwarded host, the Host header, the URL's own host and APP_BASE_URL's. */
export function expectedHosts(headers: Headers, url: URL, env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => { const h = v?.split(",")[0].trim().toLowerCase(); if (h) out.add(h); };
  // X-Forwarded-Host is a balancer's word, not a client's: honoured only when one is declared (review REV-09).
  if (Number(env.TRUST_PROXY_HOPS ?? 0) > 0) add(headers.get("x-forwarded-host"));
  add(headers.get("host"));
  add(url.host);
  try { if (env.APP_BASE_URL) add(new URL(env.APP_BASE_URL).host); } catch { /* unset or malformed: ignored */ }
  return out;
}

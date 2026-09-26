/**
 * WS4 real-HTTP probe against `npx next dev -p 3104` (the real proxy in front of the real handlers).
 *   MODE=default  — dev sign-in, webhook, clinical reviewer, spoofed headers, scope through HTTP, CSRF, CORS,
 *                   rate limiting, request ids, hardening headers + nonce CSP, metrics, health, 500-mapping.
 *   MODE=proxy    — the server was started with SSO_MODE=proxy (+ SSO_PROXY_SHARED_SECRET) and CSP_REPORT_ONLY=true.
 * Prints one line per check; exits 1 when any check fails. Run with `npx tsx` from the repo root with the ws4 env loaded.
 */
import { createHmac } from "node:crypto";
import net from "node:net";
import { prisma } from "../../../../../../src/lib/db";

const BASE = process.env.BASE ?? "http://localhost:3104";
const MODE = process.env.MODE ?? "default";
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`); if (!ok) failures++; }
type R = { status: number; headers: Headers; text: string };
async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<R> {
  const headers = new Headers(init.headers ?? {});
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
/** A raw HTTP/1.1 request (undici refuses a content-length that disagrees with the body): status line only. */
function rawStatus(method: string, path: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: ${u.host}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\nConnection: close\r\n\r\n${body}`);
    });
    let buf = "";
    sock.setTimeout(8000, () => { sock.destroy(); resolve(-1); });
    sock.on("data", (d) => { buf += d.toString(); const m = buf.match(/^HTTP\/1\.[01] (\d{3})/); if (m) { sock.destroy(); resolve(Number(m[1])); } });
    sock.on("error", reject);
    sock.on("close", () => { const m = buf.match(/^HTTP\/1\.[01] (\d{3})/); resolve(m ? Number(m[1]) : -1); });
  });
}
const json = (o: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

async function signIn(email: string): Promise<string> {
  const u = await prisma.user.findFirstOrThrow({ where: { email } });
  const res = await fetch(`${BASE}/api/auth/dev`, { method: "POST", ...json({ userId: u.id }) });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/crosswalk_dev_user=([^;]+)/);
  if (res.status !== 200 || !m) throw new Error(`dev sign-in failed for ${email}: ${res.status} ${setCookie}`);
  check(`dev cookie flags for ${email}`, /HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie) && /Path=\//i.test(setCookie), setCookie.replace(/=[^;]+/, "=…"));
  return `crosswalk_dev_user=${m[1]}`;
}

async function defaultMode() {
  // ---- open list / anonymous ----------------------------------------------------------------
  check("GET /api/requests without a cookie → 401", (await call("/api/requests")).status === 401);
  check("POST /api/requests without a cookie → 401", (await call("/api/requests", { method: "POST", ...json({}) })).status === 401);
  check("GET /api/webhooks/salesforce without a cookie → 401 (only POST is open)", (await call("/api/webhooks/salesforce")).status === 401);
  check("POST /api/webhooks/sap without a cookie → 401 (prefix not open)", (await call("/api/webhooks/sap", { method: "POST", ...json({}) })).status === 401);
  check("POST /api/webhooks/salesforce/ (trailing slash) without a cookie → 401 or 308, never the handler", [401, 308, 404].includes((await call("/api/webhooks/salesforce/", { method: "POST", ...json({}) })).status));
  const health = await call("/api/health");
  const hj = JSON.parse(health.text);
  check("GET /api/health → 200, keys only ok/status/checks/ms, no names/counts", health.status === 200 && Object.keys(hj).sort().join(",") === "checks,ms,ok,status" && Object.keys(hj.checks).every((k) => ["database", "jobs"].includes(k)), health.text);
  check("x-sso-subject alone is not a session outside proxy mode", (await call("/api/requests", { headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": "x" } })).status === 401);

  // ---- KN-01 webhook through the real proxy ---------------------------------------------------
  const { saveIntegration } = await import("../../../../../../src/lib/integrations/core/admin");
  const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@crosswalk.dev" } });
  const SECRET = `wh-http-${Date.now().toString(36)}`;
  await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, secrets: { webhookSecret: SECRET } }, admin.id);
  const evt = JSON.stringify({ eventId: `http-${Date.now()}`, type: "account.changed", accountIds: ["001MOCK0000000003"] });
  const sig = createHmac("sha256", SECRET).update(evt).digest("hex");
  const w1 = await call("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": sig }, body: evt });
  check("signed webhook, no cookie → 200 applied", w1.status === 200 && /"applied":1/.test(w1.text), `${w1.status} ${w1.text.slice(0, 120)}`);
  const w2 = await call("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": sig }, body: evt });
  check("replay of the same event → deduplicated", w2.status === 200 && /"duplicate":true/.test(w2.text), w2.text.slice(0, 80));
  const w3 = await call("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": "deadbeef" }, body: evt });
  check("invalid signature → 401", w3.status === 401, w3.text.slice(0, 80));
  const big = JSON.stringify({ eventId: "big", type: "x", pad: "a".repeat(257 * 1024) });
  const w4 = await call("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": createHmac("sha256", SECRET).update(big).digest("hex") }, body: big });
  check("body > 256 KB → 413", w4.status === 413, `${w4.status}`);
  const w5 = await rawStatus("POST", "/api/webhooks/salesforce", { "content-type": "application/json", "x-crosswalk-signature": sig, "content-length": String(300 * 1024) }, evt);
  // The Node runtime hands the proxy the request only once the declared body has arrived, so a lying content-length
  // simply leaves the connection waiting (-1 here after 8 s); a real 300 KB body gets the 413 above. Recorded, not a defect.
  check("declared content-length > 256 KB: 413 at the gate, or the runtime waits for the body (never applied)", w5 === 413 || w5 === -1, `${w5}`);
  await saveIntegration("salesforce", { provider: "mock", enabled: true, config: { scenario: "ok" }, secrets: { webhookSecret: "" } }, admin.id);
  const w6 = await call("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": sig }, body: evt.replace("http-", "http2-") });
  check("no webhook secret configured → 403", w6.status === 403, w6.text.slice(0, 80));
  await saveIntegration("salesforce", { provider: "mock", enabled: false, config: { scenario: "ok" }, secrets: { webhookSecret: SECRET } }, admin.id);
  const w7 = await call("/api/webhooks/salesforce", { method: "POST", headers: { "content-type": "application/json", "x-crosswalk-signature": sig }, body: evt });
  check("integration disabled → 404", w7.status === 404, w7.text.slice(0, 80));
  await prisma.integrationInboundEvent.deleteMany({ where: { eventId: { startsWith: "http-" } } });

  // ---- sessions -------------------------------------------------------------------------------
  const clinical = await signIn("dr.clinical@crosswalk.dev");
  const alex = await signIn("alex.rep@crosswalk.dev");
  const adminCookie = await signIn("admin@crosswalk.dev");
  const analyst = await signIn("priya.analyst@crosswalk.dev");
  check("tampered dev cookie → 401", (await call("/api/requests", { cookie: alex.slice(0, -2) + "zz" })).status === 401);
  check("bare user id as cookie → 401", (await call("/api/requests", { cookie: `crosswalk_dev_user=${alex.split("=")[1].split(".")[0]}` })).status === 401);
  check("unknown user id (bad sign-in) → 400", (await call("/api/auth/dev", { method: "POST", ...json({ userId: "clzzzzzzzzzzzzzzzzzzzzzz" }) })).status === 400);

  // ---- KN-02 clinical reviewer ----------------------------------------------------------------
  const c1 = await call("/api/crosses?status=IN_REVIEW", { cookie: clinical });
  const c2 = await call("/api/crosswalk/versions", { cookie: clinical });
  check("CLINICAL_REVIEWER GET /api/crosses → 200", c1.status === 200, `${c1.status}`);
  check("CLINICAL_REVIEWER GET /api/crosswalk/versions → 200", c2.status === 200, `${c2.status}`);
  check("no price/cost/margin keys in either payload", !/"(price|listPrice|unitPrice|cost|cogs|floorPrice|margin[A-Za-z]*)"\s*:/i.test(c1.text + c2.text));
  check("CLINICAL_REVIEWER GET /api/proposals → 403 (still no view_pricing)", (await call("/api/proposals", { cookie: clinical })).status === 403);
  check("CLINICAL_REVIEWER GET /api/catalog/enrich → 403 (KN-07)", (await call("/api/catalog/enrich", { cookie: clinical })).status === 403);
  check("ADMIN GET /api/catalog/enrich → 200", (await call("/api/catalog/enrich", { cookie: adminCookie })).status === 200);

  // ---- scope through HTTP + spoofed headers ------------------------------------------------------
  const stranger = await prisma.user.create({ data: { email: `ws4http.${Date.now().toString(36)}@test.local`, name: "ws4 http stranger", territory: "Mars", roles: { create: [{ role: "SALES_REP" }] } } });
  const alexRow = await prisma.user.findFirstOrThrow({ where: { email: "alex.rep@crosswalk.dev" } });
  // A stand-alone account owned by alex (the seeded MSK account sits under an UNASSIGNED IDN, which the scope rule shows to every rep).
  const msk = await prisma.account.create({ data: { name: `ws4 http owned ${Date.now().toString(36)}`, accountNumber: `WS4H-${Date.now().toString(36)}`, ownerUserId: alexRow.id, territory: "Northeast" } });
  try {
    const strangerCookie = await signIn(stranger.email);
    check("owner rep GET /api/accounts/{id} → 200", (await call(`/api/accounts/${msk.id}`, { cookie: alex })).status === 200);
    const s1 = await call(`/api/accounts/${msk.id}`, { cookie: strangerCookie });
    check("stranger rep GET /api/accounts/{id} → 404", s1.status === 404, `${s1.status}`);
    const s2 = await call(`/api/accounts/${msk.id}`, { cookie: strangerCookie, headers: { "x-crosswalk-path": "/api/health", "x-crosswalk-route": "GET /api/health" } });
    check("spoofed x-crosswalk-path / x-crosswalk-route are overwritten by the proxy → still 404", s2.status === 404, `${s2.status}`);
    const enc = msk.id.slice(0, -1) + "%" + msk.id.charCodeAt(msk.id.length - 1).toString(16);
    check("percent-encoded id: owner 200", (await call(`/api/accounts/${enc}`, { cookie: alex })).status === 200);
    check("percent-encoded id: stranger 404", (await call(`/api/accounts/${enc}`, { cookie: strangerCookie })).status === 404);
    const dbl = await call(`/api/accounts/${enc.replace("%", "%25")}`, { cookie: alex });
    check("double-encoded id: 404 for the owner too (not a valid id)", dbl.status === 404, `${dbl.status}`);
    const ds = await call(`/api/accounts//${msk.id}`, { cookie: strangerCookie });
    check("duplicate slashes: stranger never reaches the record", ds.status !== 200, `${ds.status}`);
    const ts = await call(`/api/accounts/${msk.id}/`, { cookie: strangerCookie });
    check("trailing slash: stranger never reaches the record", ts.status !== 200, `${ts.status}`);
    const head = await call(`/api/accounts/${msk.id}`, { method: "HEAD", cookie: strangerCookie });
    check("HEAD as stranger → 404", head.status === 404, `${head.status}`);
    const opt = await call(`/api/accounts/${msk.id}`, { method: "OPTIONS", cookie: strangerCookie });
    check("OPTIONS as stranger → not 200 with a body", opt.status !== 200 || opt.text.length === 0, `${opt.status}`);
    check("NUL byte in path → 400", (await call("/api/accounts/x%00y", { cookie: alex })).status === 400);
    check("undecodable path → 400", (await call("/api/accounts/x%ZZ", { cookie: alex })).status === 400);
    const memb = await call(`/api/accounts/${msk.id}/memberships`, { method: "POST", cookie: strangerCookie, ...json({ gpoName: "x" }) });
    check("stranger POST memberships → 403 (permission first; same answer for any id)", memb.status === 403, `${memb.status}`);
    const audit = await call(`/api/audit?entityType=Account&entityId=${msk.id}`, { cookie: strangerCookie });
    check("stranger GET /api/audit for the account → 404", audit.status === 404, `${audit.status}`);
    // ---- CSRF / CORS ----------------------------------------------------------------------------
    const csrf1 = await call("/api/notifications", { method: "POST", cookie: alex, headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
    check("cookie mutation with a foreign Origin → 403", csrf1.status === 403, `${csrf1.status} ${csrf1.text.slice(0, 80)}`);
    const csrf2 = await call("/api/notifications", { method: "POST", cookie: alex, headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
    check("cookie mutation with Sec-Fetch-Site: cross-site → 403", csrf2.status === 403, `${csrf2.status}`);
    const csrf3 = await call("/api/notifications", { method: "POST", cookie: alex, headers: { origin: BASE, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
    check("same-origin mutation → 200", csrf3.status === 200, `${csrf3.status}`);
    const csrf4 = await call("/api/notifications", { method: "POST", cookie: alex, headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
    check("script client (no Origin, no Sec-Fetch-Site) with a cookie → 200", csrf4.status === 200, `${csrf4.status}`);
    check("cross-site GET is not blocked (reads are not forgeable)", (await call("/api/notifications", { cookie: alex, headers: { "sec-fetch-site": "cross-site" } })).status === 200);
    const cors = await call("/api/notifications", { cookie: alex, headers: { origin: "https://evil.example" } });
    check("no CORS headers on responses", !cors.headers.get("access-control-allow-origin") && !cors.headers.get("access-control-allow-credentials"));
    const pre = await call("/api/notifications", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    check("preflight gets no CORS grant", !pre.headers.get("access-control-allow-origin"), `${pre.status}`);
  } finally {
    await prisma.user.delete({ where: { id: stranger.id } }).catch(() => undefined);
    await prisma.account.delete({ where: { id: msk.id } }).catch(() => undefined);
  }

  // ---- rate limiting, request ids, headers --------------------------------------------------------
  const client = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  let last: R | null = null;
  for (let i = 0; i < 21; i++) last = await call("/api/auth/me", { headers: { "x-forwarded-for": client } });
  check("21st /api/auth/* call from one client in a minute → 429 with Retry-After and x-ratelimit-*", last!.status === 429 && Number(last!.headers.get("retry-after")) >= 1 && last!.headers.get("x-ratelimit-limit") === "20" && last!.headers.get("x-ratelimit-remaining") === "0", `${last!.status} retry-after=${last!.headers.get("retry-after")} limit=${last!.headers.get("x-ratelimit-limit")}`);
  check("another client address is unaffected", (await call("/api/auth/me", { headers: { "x-forwarded-for": "198.51.100.9" } })).status === 200);
  const spoofed = await call("/api/auth/me", { headers: { "x-forwarded-for": `${client}, 198.51.100.10` } });
  check("TRUST_PROXY_HOPS=1: the LAST forwarded entry is the client, so a spoofed first entry gets its own bucket, not the victim's", spoofed.status === 200, `${spoofed.status}`);
  const ok = await call("/api/auth/me");
  check("every /api response carries x-ratelimit-limit/remaining/reset", Boolean(ok.headers.get("x-ratelimit-limit") && ok.headers.get("x-ratelimit-remaining") && ok.headers.get("x-ratelimit-reset")));
  const rid = await call("/api/auth/me", { headers: { "x-request-id": "trace-abc:123" } });
  check("valid x-request-id echoed", rid.headers.get("x-request-id") === "trace-abc:123", rid.headers.get("x-request-id") ?? "");
  const rid2 = await call("/api/auth/me", { headers: { "x-request-id": "bad id with spaces <script>" } });
  check("malformed x-request-id replaced", /^[a-f0-9]{20}$/.test(rid2.headers.get("x-request-id") ?? ""), rid2.headers.get("x-request-id") ?? "");
  for (const [k, v] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "strict-origin-when-cross-origin"], ["cross-origin-opener-policy", "same-origin"], ["x-dns-prefetch-control", "off"], ["cache-control", "private, no-store"]]) check(`API header ${k}: ${v}`, (ok.headers.get(k) ?? "").toLowerCase() === v.toLowerCase(), ok.headers.get(k) ?? "(missing)");
  check("no HSTS over plain http", !ok.headers.get("strict-transport-security"));
  check("HSTS when x-forwarded-proto: https", /max-age=31536000/.test((await call("/api/auth/me", { headers: { "x-forwarded-proto": "https" } })).headers.get("strict-transport-security") ?? ""));
  const page = await call("/", { cookie: alex });
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
  check("page response carries a nonce CSP with strict-dynamic (next dev adds 'unsafe-eval')", page.status === 200 && Boolean(nonce) && /strict-dynamic/.test(csp) && /frame-ancestors 'none'/.test(csp), csp.slice(0, 120));
  check("the nonce appears on the page's script tags", Boolean(nonce) && page.text.includes(`nonce="${nonce}"`));
  check("a second page load gets a different nonce", ((await call("/", { cookie: alex })).headers.get("content-security-policy") ?? "") !== csp);
  check("API JSON carries no CSP (no script context)", !ok.headers.get("content-security-policy"));
  check("x-powered-by absent", !ok.headers.get("x-powered-by"));

  // ---- metrics --------------------------------------------------------------------------------------
  const token = process.env.METRICS_TOKEN ?? "";
  check("GET /api/metrics with no credential → 401", (await call("/api/metrics")).status === 401);
  check("wrong bearer → 401", (await call("/api/metrics", { headers: { authorization: `Bearer ${token}x` } })).status === 401);
  check("bearer of the wrong length → 401", (await call("/api/metrics", { headers: { authorization: "Bearer short" } })).status === 401);
  const m = await call("/api/metrics", { headers: { authorization: `Bearer ${token}` } });
  check("right bearer → 200 text/plain prometheus", m.status === 200 && /text\/plain/.test(m.headers.get("content-type") ?? "") && /crosswalk_|# HELP|# TYPE/.test(m.text), `${m.status}`);
  check("ADMIN session → 200", (await call("/api/metrics", { cookie: adminCookie })).status === 200);
  check("SALES_REP session → 401", (await call("/api/metrics", { cookie: alex })).status === 401);
  check("metrics body carries no secrets / connection strings", !/postgresql:\/\/|SESSION_SECRET|password/i.test(m.text));

  // ---- error mapping ----------------------------------------------------------------------------------
  const e1 = await call("/api/requests/clzzzzzzzzzzzzzzzzzzzzzz/export?format=csv", { cookie: analyst });
  check("xref export of an unknown request → 404 JSON (was an unhandled 500)", e1.status === 404 && /not found/i.test(e1.text), `${e1.status} ${e1.text.slice(0, 60)}`);
  const e2 = await call("/api/requests", { method: "POST", cookie: analyst, ...json({ hello: 1 }) });
  check("POST /api/requests with a JSON body → 400 (was an unhandled TypeError)", e2.status === 400, `${e2.status} ${e2.text.slice(0, 60)}`);
  const e3 = await call("/api/catalog/add", { method: "POST", cookie: analyst, ...json({}) });
  check("POST /api/catalog/add {} → 400 validation message", e3.status === 400 && !/Cannot read/.test(e3.text), `${e3.status} ${e3.text.slice(0, 60)}`);
  const e4 = await call("/api/contracts/renewals?days=abc", { cookie: analyst });
  check("GET /api/contracts/renewals?days=abc → 400 (was a 500 from NaN)", e4.status === 400, `${e4.status}`);
  const e5 = await call("/api/accounts?q=%00", { cookie: analyst });
  check("NUL in a search parameter → 400 (was a 500)", e5.status === 400, `${e5.status}`);
  const e6 = await call("/api/proposals", { method: "POST", cookie: analyst, headers: { "content-type": "application/json" }, body: "{bad" });
  check("malformed JSON → 400", e6.status === 400, `${e6.status} ${e6.text.slice(0, 60)}`);
}

async function proxyMode() {
  const secret = process.env.SSO_PROXY_SHARED_SECRET ?? "";
  check("dev sign-in is disabled once SSO is configured", (await call("/api/auth/dev")).status === 404);
  const me1 = await call("/api/auth/me", { headers: { "x-sso-subject": "admin@crosswalk.dev" } });
  check("/api/auth/me with x-sso-subject only → actor null", me1.status === 200 && /"actor":null/.test(me1.text), me1.text.slice(0, 80));
  check("GET /api/requests with x-sso-subject only → 401", (await call("/api/requests", { headers: { "x-sso-subject": "admin@crosswalk.dev" } })).status === 401);
  check("GET /api/requests with subject + wrong secret → 401", (await call("/api/requests", { headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": secret + "x" } })).status === 401);
  const good = await call("/api/auth/me", { headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": secret } });
  check("subject + right secret → the admin actor", good.status === 200 && /"email":"admin@crosswalk.dev"/.test(good.text), good.text.slice(0, 100));
  check("GET /api/requests with subject + right secret → 200", (await call("/api/requests", { headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": secret } })).status === 200);
  check("unknown subject with the right secret → 401", (await call("/api/requests", { headers: { "x-sso-subject": "nobody@nowhere.invalid", "x-sso-proxy-secret": secret } })).status === 401);
  check("a dev cookie is not a session in proxy mode", (await call("/api/requests", { cookie: "crosswalk_dev_user=abc.def" })).status === 401);
  const page = await call("/");
  check("CSP_REPORT_ONLY=true → content-security-policy-report-only on pages", Boolean(page.headers.get("content-security-policy-report-only")) && !page.headers.get("content-security-policy"), (page.headers.get("content-security-policy-report-only") ?? "").slice(0, 60));
  const csrf = await call("/api/notifications", { method: "POST", headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": secret, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
  check("proxy-asserted (header) sessions are not cookie sessions: no CSRF check applies, the proxy hop is the credential", csrf.status === 200, `${csrf.status}`);
}

(MODE === "proxy" ? proxyMode() : defaultMode()).then(async () => {
  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures ? 1 : 0);
}).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });

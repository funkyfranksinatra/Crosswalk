// Independent reviewer HTTP probe against the coordinator's production build (read-mostly).
// Usage: node http-probe.mjs  (cookies are obtained through POST /api/auth/dev)
const B = process.env.BASE ?? "http://127.0.0.1:3103";
const USERS = {
  REP: "cmuffqhm90000fs7df146esql", // Alex Rivera, SALES_REP, owner of Lakeshore (territory Northeast)
  STRANGER: "cmufftmlo0001sh7dmctqpuaz", // t2 rep, SALES_REP, no territory, owns nothing
  ADMIN: "cmuffqhoe0009fs7dn94dgcxu",
  CLINICAL: "cmuffqho70007fs7d7rw7mfnn",
  EXEC: "cmuffqhoi000afs7du0uhhrgv",
  DIRECTOR: "cmuffqhns0004fs7d7eaxlhrk",
};
const LAKESHORE = "cmufgd5pu00d1fc7dx36e6fls"; // owned by REP
const REQ2 = "cmufg8dni004pfc7dzpm1a0oe"; // REQ-0002: no account, created by ADMIN -> invisible to every rep
const REQ1 = "cmufg50yo000ufc7ddlfgrbk0"; // REQ-0001 on an unassigned account -> visible to reps
const PRP14 = "cmufg8i390050fc7dyfvweusn"; // DRAFT on MSK (unassigned)
const CONTRACT_LOCAL = "cmufg7wm60039fc7dqvih8e1e";
const cookies = {};
let pass = 0, fail = 0;
const out = [];
function log(s) { out.push(s); console.log(s); }
async function signin(name) {
  const r = await fetch(`${B}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: USERS[name] }) });
  const sc = r.headers.get("set-cookie") ?? "";
  const m = sc.match(/crosswalk_dev_user=([^;]+)/);
  if (!m) throw new Error(`no cookie for ${name}: ${r.status} ${sc}`);
  cookies[name] = `crosswalk_dev_user=${m[1]}`;
}
async function call(who, method, path, { body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (who && cookies[who]) h.cookie = cookies[who];
  let b;
  if (body !== undefined) { if (raw) b = body; else { b = JSON.stringify(body); h["content-type"] = "application/json"; } }
  const r = await fetch(`${B}${path}`, { method, headers: h, body: b, redirect: "manual" });
  const ct = r.headers.get("content-type") ?? "";
  let data = null, text = "";
  if (/json/.test(ct)) { try { data = await r.json(); } catch { data = null; } } else { text = await r.text(); }
  return { status: r.status, data, text, headers: r.headers };
}
function check(label, ok, detail) { if (ok) pass++; else fail++; log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`); }
const j = (x) => JSON.stringify(x)?.slice(0, 160);

async function main() {
  for (const n of Object.keys(USERS)) await signin(n);
  log(`# reviewer HTTP probe ${new Date().toISOString()} base=${B}`);

  // ---- WS4 routes: anonymous -> 401, missing permission -> 403, stranger -> 404
  let r;
  for (const [m, p] of [["GET", "/api/crosses"], ["GET", "/api/crosswalk/versions"], ["GET", "/api/catalog/enrich"], ["POST", "/api/catalog/add"], ["GET", "/api/contracts/renewals"], ["GET", `/api/accounts/${LAKESHORE}`], ["GET", "/api/proposals"], ["GET", `/api/proposals/${PRP14}`], ["GET", `/api/proposals/${PRP14}/scenarios`], ["GET", "/api/approvals"], ["DELETE", "/api/approvals/delegations/cmufg8i390050fc7dyfvweusn"], ["GET", `/api/requests/${REQ1}`], ["GET", `/api/requests/${REQ1}/export?type=xref&format=xlsx`], ["POST", "/api/requests"], ["GET", "/api/settings"], ["PATCH", "/api/competitor/cmufg8i390050fc7dyfvweusn"], ["POST", `/api/contracts/${CONTRACT_LOCAL}/entries`], ["PATCH", `/api/proposals/${PRP14}/lines/cmufg8i390050fc7dyfvweusn`]]) {
    r = await call(null, m, p, m === "GET" || m === "DELETE" ? {} : { body: {} });
    check(`anon ${m} ${p} -> 401`, r.status === 401, `${r.status} ${j(r.data)}`);
  }
  // missing permission -> 403
  r = await call("REP", "GET", "/api/catalog/enrich"); check("REP GET /api/catalog/enrich -> 403", r.status === 403, `${r.status} ${j(r.data)}`);
  r = await call("CLINICAL", "GET", "/api/catalog/enrich"); check("CLINICAL GET /api/catalog/enrich -> 403", r.status === 403, `${r.status}`);
  r = await call("ADMIN", "GET", "/api/catalog/enrich"); check("ADMIN GET /api/catalog/enrich -> 200", r.status === 200, `${r.status} ${j(r.data)}`);
  r = await call("REP", "POST", "/api/catalog/add", { body: {} }); check("REP POST /api/catalog/add -> 403", r.status === 403, `${r.status}`);
  r = await call("ADMIN", "POST", "/api/catalog/add", { body: {} }); check("ADMIN POST /api/catalog/add {} -> 400 validation", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", "/api/catalog/add", { body: { skus: "x".repeat(20001) } }); check("ADMIN POST /api/catalog/add 20001 chars -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("CLINICAL", "GET", "/api/crosses"); check("CLINICAL GET /api/crosses -> 200", r.status === 200, `${r.status}`);
  check("  ...and no price keys in the payload", r.status === 200 && !/"(price|cogs|margin|listPrice|unitPrice)"/i.test(JSON.stringify(r.data)), "");
  r = await call("CLINICAL", "GET", "/api/crosswalk/versions"); check("CLINICAL GET /api/crosswalk/versions -> 200", r.status === 200, `${r.status}`);
  r = await call("CLINICAL", "GET", "/api/approvals"); check("CLINICAL GET /api/approvals -> 403 (view_pricing)", r.status === 403, `${r.status}`);
  r = await call("CLINICAL", "PATCH", `/api/proposals/${PRP14}/lines/x`, { body: {} }); check("CLINICAL PATCH line -> 403", r.status === 403, `${r.status}`);
  r = await call("REP", "POST", `/api/contracts/${CONTRACT_LOCAL}/entries`, { body: {} }); check("REP POST contract entries -> 403 (edit_contract_pricing)", r.status === 403, `${r.status}`);
  r = await call("ADMIN", "POST", `/api/contracts/${CONTRACT_LOCAL}/entries`, { body: {} }); check("ADMIN POST contract entries {} -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/contracts/${CONTRACT_LOCAL}/entries`, { body: { entries: [{ sku: "174006", price: "0x10" }] } }); check("ADMIN POST contract entries price 0x10 -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("EXEC", "PATCH", "/api/competitor/cmufg8i390050fc7dyfvweusn", { body: { description: "x" } }); check("EXEC PATCH /api/competitor -> 403", r.status === 403, `${r.status}`);
  r = await call("REP", "GET", "/api/contracts/renewals?days=abc"); check("REP GET renewals?days=abc -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("REP", "GET", "/api/contracts/renewals?days=0"); check("REP GET renewals?days=0 -> 400", r.status === 400, `${r.status}`);
  r = await call("REP", "GET", "/api/contracts/renewals?days=30"); check("REP GET renewals?days=30 -> 200", r.status === 200, `${r.status}`);
  // stranger -> 404
  r = await call("STRANGER", "GET", `/api/accounts/${LAKESHORE}`); check("STRANGER GET Lakeshore account -> 404", r.status === 404, `${r.status} ${j(r.data)}`);
  r = await call("REP", "GET", `/api/accounts/${LAKESHORE}`); check("owner REP GET Lakeshore account -> 200", r.status === 200, `${r.status}`);
  r = await call("STRANGER", "PATCH", `/api/accounts/${LAKESHORE}`, { body: { name: "x" } }); check("STRANGER PATCH Lakeshore -> 404 (not 403/200)", r.status === 404, `${r.status} ${j(r.data)}`);
  r = await call("STRANGER", "GET", `/api/requests/${REQ2}`); check("STRANGER GET REQ-0002 (no account, admin-created) -> 404", r.status === 404, `${r.status} ${j(r.data)}`);
  r = await call("REP", "GET", `/api/requests/${REQ2}`); check("REP GET REQ-0002 -> 404 too (scope, not identity)", r.status === 404, `${r.status}`);
  r = await call("ADMIN", "GET", `/api/requests/${REQ2}`); check("ADMIN GET REQ-0002 -> 200", r.status === 200, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/requests/${REQ2}/export?type=xref&format=xlsx`); check("STRANGER export REQ-0002 -> 404", r.status === 404, `${r.status} ${j(r.data) || r.text.slice(0, 80)}`);
  r = await call("STRANGER", "GET", `/api/requests/${REQ2}/compare`); check("STRANGER compare REQ-0002 -> 404", r.status === 404, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/requests/${REQ2.replace(/.$/, "z")}`); check("STRANGER GET unknown id -> 404 (same as out of scope)", r.status === 404, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/requests//${REQ2}`); check("STRANGER GET //id (double slash) -> not 200", r.status !== 200, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/requests/${encodeURIComponent(REQ2)}%2F`); check("STRANGER GET id%2F -> not 200", r.status !== 200, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/requests/${REQ2}`, { headers: { "x-crosswalk-path": "/api/health" } }); check("STRANGER spoof x-crosswalk-path -> still 404", r.status === 404, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/requests/${REQ2}`, { headers: { "x-crosswalk-path": `/api/requests/${REQ1}` } }); check("STRANGER spoof x-crosswalk-path to a visible id -> still 404", r.status === 404, `${r.status}`);
  r = await call("STRANGER", "GET", `/api/accounts/${LAKESHORE}`, { headers: { "x-crosswalk-route": "GET /api/health", "x-request-id": "spoofed" } }); check("STRANGER spoof route/request-id headers -> 404", r.status === 404, `${r.status} rid=${r.headers.get("x-request-id")}`);
  check("  ...x-request-id in the response is not the spoofed one", r.headers.get("x-request-id") !== "spoofed", r.headers.get("x-request-id"));
  r = await call("ADMIN", "GET", `/api/requests/${REQ2.replace(/.$/, "z")}/export?type=offer&format=pdf`); check("ADMIN export unknown id -> 404 JSON", r.status === 404 && r.data, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "GET", `/api/requests/${REQ1}/export?type=bogus`); check("ADMIN export type=bogus -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", "/api/requests", { body: { a: 1 } }); check("ADMIN POST /api/requests JSON -> 400 multipart expected", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", "/api/intake/preview", { body: { a: 1 } }); check("ADMIN POST /api/intake/preview JSON -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "PATCH", `/api/proposals/${PRP14}/lines/cmufg8i390050fc7dyfvweusn`, { body: { notes: "x" } }); check("ADMIN PATCH unknown lineId -> 404 (not 500)", r.status === 404, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "PATCH", `/api/proposals/${PRP14}/scenarios/cmufg8i390050fc7dyfvweusn`, { body: {} }); check("ADMIN PATCH unknown scenario -> 404", r.status === 404, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" } }); check("ADMIN POST scenario kind=EVIL -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", "/api/crosses", { body: null, raw: true }); check("ADMIN POST /api/crosses body 'null' -> 400", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("REP", "DELETE", "/api/approvals/delegations/cmufg8i390050fc7dyfvweusn"); check("REP DELETE unknown delegation -> 404", r.status === 404, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "GET", "/api/accounts/x%00y"); check("GET /api/accounts/x%00y -> 400", r.status === 400, `${r.status}`);
  r = await call("ADMIN", "GET", "/api/accounts?q=%00"); check("GET /api/accounts?q=%00 -> 400 (not 500)", r.status === 400, `${r.status} ${j(r.data)}`);

  // ---- webhook / SSO header / CSRF
  r = await call(null, "POST", "/api/webhooks/salesforce", { body: { a: 1 } }); check("anon POST /api/webhooks/salesforce -> handler response (not proxy 401 'Sign in required')", r.status !== 401 || !/sign in/i.test(r.data?.error ?? ""), `${r.status} ${j(r.data)}`);
  r = await call(null, "GET", "/api/webhooks/salesforce"); check("anon GET /api/webhooks/salesforce -> 401 (gate)", r.status === 401, `${r.status}`);
  r = await call(null, "POST", "/api/webhooks/salesforce/", { body: {} }); check("anon POST /api/webhooks/salesforce/ (trailing slash) -> not a handler 2xx", r.status !== 200 && r.status !== 202, `${r.status}`);
  r = await call(null, "POST", "/api/webhooks/salesforce", { body: "x", raw: true, headers: { "content-length": String(300 * 1024) } }).catch((e) => ({ status: -1, data: String(e) }));
  check("webhook declared content-length 300 KB -> 413", r.status === 413, `${r.status} ${j(r.data)}`);
  r = await call(null, "GET", "/api/auth/me", { headers: { "x-sso-subject": "admin@crosswalk.dev" } }); check("x-sso-subject spoof on /api/auth/me -> actor null", r.status === 200 && (r.data?.actor ?? null) === null, `${r.status} ${j(r.data)}`);
  r = await call(null, "GET", "/api/settings", { headers: { "x-sso-subject": "admin@crosswalk.dev", "x-sso-proxy-secret": "x" } }); check("x-sso-subject + bogus secret on /api/settings -> 401", r.status === 401, `${r.status}`);
  r = await call("REP", "GET", "/api/auth/me", { headers: { "x-sso-subject": "admin@crosswalk.dev" } }); check("REP cookie + x-sso-subject admin -> still REP", r.data?.actor?.email === "alex.rep@crosswalk.dev", j(r.data?.actor?.email));
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { origin: "https://evil.example" } }); check("CSRF: POST with Origin evil + cookie -> 403", r.status === 403, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:3103" } }); check("CSRF: Sec-Fetch-Site cross-site -> 403", r.status === 403, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { "sec-fetch-site": "same-site", origin: "http://127.0.0.1:3103" } }); check("CSRF: Sec-Fetch-Site same-site -> 403", r.status === 403, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3103" } }); check("CSRF: same-origin -> passes gate (400 from validation)", r.status === 400, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { origin: "http://127.0.0.1:3103" } }); check("CSRF: Origin = addressed host, no sec-fetch-site -> passes gate", r.status === 400, `${r.status}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { origin: "https://evil.example", "x-forwarded-host": "evil.example" } }); check("CSRF: Origin evil + spoofed X-Forwarded-Host evil -> ?", r.status === 403, `${r.status} ${j(r.data)}`);
  r = await call("ADMIN", "POST", `/api/proposals/${PRP14}/scenarios`, { body: { kind: "EVIL" }, headers: { origin: "null" } }); check("CSRF: Origin null -> 403", r.status === 403, `${r.status}`);
  r = await call("ADMIN", "GET", `/api/proposals/${PRP14}`, { headers: { origin: "https://evil.example" } }); check("CSRF: GET unaffected", r.status === 200, `${r.status}`);
  check("  no CORS header on the reply", !r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-origin"));
  r = await call("ADMIN", "OPTIONS", `/api/proposals/${PRP14}`, { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }); check("CORS preflight from evil: no allow-origin", !r.headers.get("access-control-allow-origin"), `${r.status} ${r.headers.get("access-control-allow-origin")}`);

  // ---- settings as SALES_REP
  r = await call("REP", "GET", "/api/settings"); check("REP GET /api/settings -> 200", r.status === 200, `${r.status}`);
  check("  no `calls` / `baseURL` for a rep", r.data && !("calls" in r.data) && !("baseURL" in (r.data.llm ?? {})), `keys=${Object.keys(r.data ?? {}).join(",")} llm=${j(r.data?.llm)}`);
  r = await call("ADMIN", "GET", "/api/settings"); check("ADMIN GET /api/settings has calls", r.data && "calls" in r.data, `keys=${Object.keys(r.data ?? {}).join(",")}`);

  log(`\n# ${pass} passed, ${fail} failed`);
  const fs = await import("node:fs");
  fs.writeFileSync(new URL("./http-probe.txt", import.meta.url), out.join("\n") + "\n");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

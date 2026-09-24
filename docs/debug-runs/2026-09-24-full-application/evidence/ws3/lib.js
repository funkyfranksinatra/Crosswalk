/* Shared Playwright harness for the WS3 (frontend) debug run.
 *
 * Usage from any script in this folder:
 *   const { withBrowser, signIn, ROLES, BASE } = require("./lib");
 *
 * The server is the production build started with
 *   set -a; . ./.env.local.ws3; set +a; JOBS_WORKER=inline npx next start -p 3103
 * Override with BASE=http://localhost:3103.
 */
const fs = require("node:fs");
const path = require("node:path");
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
const playwright = require("playwright");
// PW_BROWSER=chromium|firefox|webkit selects the engine (default chromium); the scripts are engine-neutral.
const ENGINE = process.env.PW_BROWSER || "chromium";
const chromium = playwright[ENGINE];

const BASE = process.env.BASE || "http://localhost:3103";
const OUT = path.join(__dirname, "out", process.env.PW_BROWSER ? ENGINE : "");
if (!require("fs").existsSync(OUT)) require("fs").mkdirSync(OUT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

/** Role → dev user e-mail (prisma/seed.ts). */
const ROLES = {
  SALES_REP: "alex.rep@crosswalk.dev",
  REGIONAL_MANAGER: "maria.manager@crosswalk.dev",
  CONTRACTING_MANAGER: "sam.contracting@crosswalk.dev",
  PRICING_ANALYST: "priya.analyst@crosswalk.dev",
  PRICING_DIRECTOR: "dana.director@crosswalk.dev",
  PRICING_COMMITTEE: "committee@crosswalk.dev",
  PRODUCT_MARKETING: "lee.marketing@crosswalk.dev",
  CLINICAL_REVIEWER: "dr.clinical@crosswalk.dev",
  FINANCE: "finance@crosswalk.dev",
  ADMIN: "admin@crosswalk.dev",
  EXECUTIVE: "exec@crosswalk.dev",
};

const PAGES = [
  "/", "/requests", "/requests/new", "/requests/[id]", "/proposals", "/proposals/[id]", "/approvals", "/accounts", "/accounts/[id]",
  "/contracts", "/contracts/[id]", "/intelligence", "/intelligence/bids", "/intelligence/extractions/[id]", "/analytics",
  "/catalog", "/catalog/gudid", "/crosses", "/notifications", "/settings", "/settings/integrations", "/settings/pricing",
];

let usersCache = null;
async function devUsers() {
  if (usersCache) return usersCache;
  const r = await fetch(`${BASE}/api/auth/dev`);
  if (!r.ok) throw new Error(`GET /api/auth/dev → ${r.status}`);
  usersCache = await r.json();
  return usersCache;
}

/** Returns the signed dev cookie value for a role (or an e-mail). Cached per e-mail: the
 * auth rate class allows 20 requests a minute, so one sign-in per role is all we spend. */
const cookieCache = new Map();
async function cookieFor(roleOrEmail) {
  const email = ROLES[roleOrEmail] || roleOrEmail;
  if (cookieCache.has(email)) return cookieCache.get(email);
  const users = await devUsers();
  const u = users.find((x) => x.email === email);
  if (!u) throw new Error(`no dev user ${email}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: u.id }) });
    if (r.status === 429) { const wait = Number(r.headers.get("retry-after") || 30) * 1000; process.stderr.write(`sign-in rate limited, waiting ${wait} ms\n`); await new Promise((res) => setTimeout(res, wait)); continue; }
    const sc = r.headers.get("set-cookie") || "";
    const m = sc.match(/crosswalk_dev_user=([^;]+)/);
    if (!m) throw new Error(`no cookie for ${email}: HTTP ${r.status} ${sc}`);
    const c = { name: "crosswalk_dev_user", value: m[1], user: u };
    cookieCache.set(email, c);
    return c;
  }
  throw new Error(`sign-in for ${email} kept being rate limited`);
}

/** Curl-style fetch as a role (no browser). */
async function apiAs(role, url, init = {}) {
  const c = role ? await cookieFor(role) : null;
  const headers = Object.assign({}, init.headers || {}, c ? { cookie: `${c.name}=${c.value}` } : {});
  return fetch(`${BASE}${url}`, { ...init, headers, redirect: "manual" });
}

/** New browser context signed in as `role` (null = signed out). Collects console errors, page errors, failed requests and CSP violations. */
async function contextAs(browser, role, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, baseURL: BASE, acceptDownloads: true });
  if (role) {
    const c = await cookieFor(role);
    await context.addCookies([{ name: c.name, value: c.value, domain: "localhost", path: "/", httpOnly: true, secure: BASE.startsWith("https:"), sameSite: "Lax" }]);
  }
  const page = await context.newPage();
  const log = { console: [], errors: [], failed: [], csp: [], responses: [] };
  page.on("console", (m) => {
    const t = m.type();
    const text = m.text();
    if (/Content Security Policy|Refused to/i.test(text)) log.csp.push(text);
    if (t === "error" || t === "warning") log.console.push({ type: t, text });
  });
  page.on("pageerror", (e) => {
    const msg = String(e.message || e);
    // WebKit reports a same-origin fetch/RSC prefetch cancelled by a navigation as a page error
    // ("<url> due to access control checks."); Chromium/Firefox report the same event as a failed
    // request (net::ERR_ABORTED). Classify it the same way so engines are comparable.
    if (ENGINE === "webkit" && /^\/?localhost:\d+\/.* due to access control checks\.$/.test(msg)) { log.failed.push({ url: msg.replace(/ due to access control checks\.$/, ""), err: "cancelled (webkit access control)" }); return; }
    log.errors.push(msg);
  });
  page.on("requestfailed", (r) => log.failed.push({ url: r.url(), err: r.failure()?.errorText }));
  page.on("response", (r) => { if (r.status() >= 400) log.responses.push({ url: r.url().replace(BASE, ""), status: r.status() }); });
  return { context, page, log };
}

async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: true });
  if (process.env.PW_BROWSER) console.log(`[engine] ${ENGINE} ${browser.version()}`);
  try { return await fn(browser); } finally { await browser.close(); }
}

/** Resolve sample ids for the dynamic routes via the API (as ADMIN). */
async function sampleIds() {
  const j = async (u) => (await apiAs("ADMIN", u)).json();
  const requests = await j("/api/requests");
  const proposals = await j("/api/proposals");
  const accounts = await j("/api/accounts");
  const contracts = await j("/api/contracts");
  const request = requests.find((r) => r.status === "complete") || requests[0];
  return {
    request: request?.id ?? null,
    proposal: proposals[0]?.id ?? null,
    account: accounts[0]?.id ?? null,
    contract: contracts[0]?.id ?? null,
    extraction: null,
  };
}

function resolvePath(p, ids) {
  return p.replace("/requests/[id]", `/requests/${ids.request}`).replace("/proposals/[id]", `/proposals/${ids.proposal}`).replace("/accounts/[id]", `/accounts/${ids.account}`).replace("/contracts/[id]", `/contracts/${ids.contract}`).replace("/intelligence/extractions/[id]", `/intelligence/extractions/${ids.extraction ?? "missing0000000000000000"}`);
}

function writeJson(name, data) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2)); }
function writeText(name, data) { fs.writeFileSync(path.join(OUT, name), data); }
function sanitize(s) { return String(s).replace(/crosswalk_dev_user=[^;\s"]+/g, "crosswalk_dev_user=***"); }

module.exports = { BASE, OUT, ROLES, PAGES, devUsers, cookieFor, apiAs, contextAs, withBrowser, sampleIds, resolvePath, writeJson, writeText, sanitize };

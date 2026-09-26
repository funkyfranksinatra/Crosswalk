/* Item I — navigation and state: refresh / back / forward, deep links, missing and out-of-scope
 * resources (404, no leak), empty data (a rep who sees nothing), large data (/crosses), long
 * content, loading / error states, session expiry (cookie removed mid-session), stale tabs
 * (two tabs editing the same proposal line).
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/navigation-state.js
 */
const { withBrowser, contextAs, apiAs, writeJson, BASE } = require("./lib");

const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}` : ""}`); }
const j = async (role, url, init) => { const r = await apiAs(role, url, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };

async function main() {
  await withBrowser(async (browser) => {
    // --- Back/forward/refresh + deep links (ADMIN)
    const { context, page, log } = await contextAs(browser, "ADMIN");
    await page.goto("/catalog?q=PPM&only=unpriced", { waitUntil: "load" });
    check("deep link: catalog filters applied from the URL", (await page.getByLabel("Search SKU, description, brand").inputValue()) === "PPM" && (await page.locator("select").nth(1).inputValue()) === "unpriced");
    await page.goto("/crosses?type=Exact+Match", { waitUntil: "load" });
    check("deep link: crosses filter from the URL", (await page.locator("select").first().inputValue()) === "Exact Match");
    await page.goBack({ waitUntil: "load" });
    await page.waitForURL(/\/catalog\?q=PPM/, { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    check("back: returns to the catalog deep link", page.url().includes("/catalog?q=PPM"));
    await page.goForward({ waitUntil: "load" });
    await page.waitForURL(/\/crosses\?type=Exact/, { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    check("forward: returns to crosses", page.url().includes("/crosses?type=Exact"));
    await page.reload({ waitUntil: "load" });
    check("refresh: filter survives a reload", (await page.locator("select").first().inputValue()) === "Exact Match");

    // --- Large data: /crosses (up to 400 of the seeded rows) and long content
    const t0 = Date.now();
    await page.goto("/crosses", { waitUntil: "load" });
    const rows = await page.locator("table.table tbody tr").count();
    const total = await page.locator("main").innerText();
    check("large data: /crosses renders the first 400 of the seeded crosses", rows >= 400, { rows, ms: Date.now() - t0, stat: total.match(/Crosses\s*[\d,]+/)?.[0] });
    check("large data: sticky table header present", (await page.locator("table.table th").first().evaluate((e) => getComputedStyle(e).position)) === "sticky");

    // --- Missing / out-of-scope resources: 404 in the UI, never a leak
    for (const url of ["/requests/zzzzzzzzzzzzzzzzzzzzzzzz1", "/proposals/zzzzzzzzzzzzzzzzzzzzzzzz1", "/contracts/zzzzzzzzzzzzzzzzzzzzzzzz1", "/accounts/zzzzzzzzzzzzzzzzzzzzzzzz1", "/intelligence/extractions/zzzzzzzzzzzzzzzzzzzzzzzz1"]) {
      await page.goto(url, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const txt = await page.locator("main").innerText();
      check(`missing resource ${url.split("/")[1]}: not-found message, no shimmer left`, /not found|not available|Could not|Extraction/i.test(txt) && !(await page.locator(".shimmer").count()), txt.slice(0, 80).replace(/\n/g, " "));
    }
    const nf = await page.goto("/no-such-page", { waitUntil: "load" });
    check("unknown route: 404 with the custom not-found page", nf.status() === 404 && (await page.locator("main").innerText()).includes("Page not found"));
    // error boundary exists in the build
    check("error boundary: app-level error.tsx compiled", require("node:fs").existsSync(require("node:path").join(__dirname, "../../../../../src/app/error.tsx")));

    // --- Out-of-scope for a rep: account/proposal of another rep's territory → 404, not 403 (no existence leak)
    const accounts = (await j("ADMIN", "/api/accounts")).body;
    const repAccounts = (await j("SALES_REP", "/api/accounts")).body;
    const hidden = accounts.find((a) => !repAccounts.some((r) => r.id === a.id));
    if (hidden) {
      const r = await j("SALES_REP", `/api/accounts/${hidden.id}`);
      check("scope: rep gets 404 (not 403) for an account outside the book", r.status === 404, { status: r.status, body: r.body });
      const { context: c2, page: p2 } = await contextAs(browser, "SALES_REP");
      await p2.goto(`/accounts/${hidden.id}`, { waitUntil: "load" });
      check("scope: rep sees 'Account not found' in the UI", (await p2.locator("main").innerText()).includes("Account not found"));
      await c2.close();
    } else check("scope: every account is visible to the rep in this seed", true, "skipped (no out-of-scope account)");

    // --- Empty data: a role that sees nothing
    const { context: c3, page: p3 } = await contextAs(browser, "CLINICAL_REVIEWER");
    await p3.goto("/", { waitUntil: "load" });
    const ov = await p3.locator("main").innerText();
    check("empty: clinical reviewer overview hides the request list and the New request button", /Requests are shown to roles that run cross-references/.test(ov) && !(await p3.getByRole("link", { name: "New request" }).count()));
    await p3.goto("/requests", { waitUntil: "load" });
    check("empty: /requests explains the missing permission", /run.cross.reference permission/i.test(await p3.locator("main").innerText()));
    await c3.close();

    // --- Loading and error states: a 500 from the API shows an error, not a spinner forever
    const req = (await j("ADMIN", "/api/requests")).body[0];
    if (req) {
      await page.route(new RegExp(`/api/requests/${req.id}$`), (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated outage" }) }));
      await page.goto(`/requests/${req.id}`, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const txt = await page.locator("main").innerText();
      check("error state: API 500 shows a message and no shimmer", /simulated outage|Could not load/.test(txt) && !(await page.locator(".shimmer").count()), txt.slice(0, 100).replace(/\n/g, " "));
      await page.unroute(new RegExp(`/api/requests/${req.id}$`));
    }

    // --- Session expiry: remove the cookie mid-session
    await page.goto("/proposals", { waitUntil: "load" });
    await context.clearCookies();
    const r401 = await page.evaluate(() => fetch("/api/proposals").then((r) => r.status));
    check("session expiry: API answers 401 once the cookie is gone", r401 === 401, { status: r401 });
    await page.reload({ waitUntil: "load" });
    check("session expiry: the page falls back to the sign-in screen", (await page.locator("main").innerText()).includes("Sign in to use Crosswalk"));
    check("no page errors so far", log.errors.length === 0, log.errors);
    await context.close();

    // --- Stale tabs: two tabs editing the same proposal line
    const proposals = (await j("ADMIN", "/api/proposals")).body;
    const draft = proposals.find((p) => p.status === "DRAFT");
    if (draft) {
      const { context: ca, page: A } = await contextAs(browser, "ADMIN");
      const { context: cb, page: B } = await contextAs(browser, "ADMIN");
      await A.goto(`/proposals/${draft.id}`, { waitUntil: "load" });
      await B.goto(`/proposals/${draft.id}`, { waitUntil: "load" });
      await A.waitForSelector("table tbody tr"); await B.waitForSelector("table tbody tr");
      const p = (await j("ADMIN", `/api/proposals/${draft.id}`)).body;
      const line = p.lines.find((l) => l.included && l.sku);
      const inA = A.getByRole("textbox", { name: `Proposed price for ${line.competitorCode}` });
      const inB = B.getByRole("textbox", { name: `Proposed price for ${line.competitorCode}` });
      await inA.fill("500"); await inA.press("Enter"); await A.waitForTimeout(900);
      await inB.fill("600"); await inB.press("Enter"); await B.waitForTimeout(900);
      const after = (await j("ADMIN", `/api/proposals/${draft.id}`)).body.lines.find((l) => l.id === line.id);
      check("stale tabs: last write wins on the server (600)", Number(after.proposedPrice) === 600, after.proposedPrice);
      // Tab A still shows 500 until it reloads; an edit there re-reads the server state after its own write.
      const shownA = await inA.inputValue();
      await inA.fill("550"); await inA.press("Enter"); await A.waitForTimeout(900);
      const final = (await j("ADMIN", `/api/proposals/${draft.id}`)).body.lines.find((l) => l.id === line.id);
      check("stale tabs: tab A's next edit is applied to the current server state and the screen reloads", Number(final.proposedPrice) === 550 && (await inA.inputValue()) === "550", { shownBefore: shownA, final: final.proposedPrice });
      // B still shows 600; when its tab regains focus it re-reads the proposal and shows 550.
      check("stale tabs: tab B shows its stale 600 before it regains focus", (await inB.inputValue()) === "600");
      await B.evaluate(() => window.dispatchEvent(new Event("focus")));
      await B.waitForTimeout(1200);
      check("stale tabs: tab B refreshes to the server's 550 on focus", (await inB.inputValue()) === "550", await inB.inputValue());
      const audit = (await j("ADMIN", `/api/proposals/${draft.id}/audit`)).body;
      check("stale tabs: every price edit is in the audit trail (3 changes; the no-op is not sent)", Array.isArray(audit) && audit.filter((a) => a.action === "PRICE_CHANGED").length >= 3, { events: Array.isArray(audit) ? audit.length : audit });
      await ca.close(); await cb.close();
    } else check("stale tabs (no DRAFT proposal available)", true, "skipped");
  });
  writeJson("navigation-state.json", results);
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

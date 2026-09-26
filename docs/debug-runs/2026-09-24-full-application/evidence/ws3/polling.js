/* Item K — polling behaviour. Counts network requests to each polled endpoint while the page
 * is open, after navigating away (10 s), and while the tab is hidden; and checks the
 * stale-response ordering on the request page by delaying one poll reply so it arrives after
 * a newer one (the UI must keep the newer state).
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/polling.js
 */
const { withBrowser, contextAs, apiAs, writeJson } = require("./lib");

const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}` : ""}`); }

async function countFor(page, pattern, ms) {
  let n = 0;
  const h = (r) => { if (pattern.test(r.url())) n++; };
  page.on("request", h);
  await page.waitForTimeout(ms);
  page.off("request", h);
  return n;
}

async function main() {
  const role = "ADMIN";
  const reqs = await (await apiAs(role, "/api/requests")).json();
  const req = reqs[0];
  await withBrowser(async (browser) => {
    const { context, page } = await contextAs(browser, role);

    // Bell: 30 s while visible — over 8 s we expect exactly the initial fetch.
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(2500); // hydration + the initial fetch
    const bell = await countFor(page, /\/api\/notifications\?unread=1/, 8000);
    check("bell: no extra poll within 8 s (30 s cadence)", bell === 0, { requests: bell });

    // System card: 20 s cadence; navigating away must stop it.
    await page.goto("/settings", { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const sys1 = await countFor(page, /\/api\/system$/, 21000);
    check("system card: one poll in ~21 s (20 s cadence)", sys1 >= 1 && sys1 <= 2, { requests: sys1 });
    await page.goto("/catalog", { waitUntil: "load" });
    const sysAfter = await countFor(page, /\/api\/system$/, 22000);
    check("system card: polling stops after navigating away (22 s)", sysAfter === 0, { requests: sysAfter });

    // Hidden tab: the system card and the request page skip polls while hidden.
    await page.goto("/settings", { waitUntil: "load" });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    const sysHidden = await countFor(page, /\/api\/system$/, 22000);
    check("system card: no poll while the tab is hidden (22 s)", sysHidden === 0, { requests: sysHidden });
    const back = countFor(page, /\/api\/system$/, 2500);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    const sysBack = await back;
    check("system card: catches up when the tab becomes visible", sysBack >= 1, { requests: sysBack });

    if (req) {
      // Request page: not running → no 1.2 s polling at all.
      await page.goto(`/requests/${req.id}`, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const idle = await countFor(page, new RegExp(`/api/requests/${req.id}$`), 5000);
      check("request page: no polling while the run is not active", idle === 0, { requests: idle, status: req.status });

      // Stale ordering: the 2nd GET of the request (fired by the first checkbox click) is
      // delayed 2.5 s and marked "STALE REPLY"; the 3rd GET (second click) answers at once.
      // The late reply must not overwrite the fresh state.
      let n = 0;
      await page.route(new RegExp(`/api/requests/${req.id}$`), async (route) => {
        n++;
        const res = await route.fetch();
        const json = await res.json();
        if (n === 2) { await new Promise((r) => setTimeout(r, 2500)); return route.fulfill({ response: res, json: { ...json, status: "running", progress: 10, stage: "STALE REPLY" } }); }
        return route.fulfill({ response: res, json });
      });
      await page.goto(`/requests/${req.id}`, { waitUntil: "load" });
      await page.waitForSelector("table tbody tr", { timeout: 15000 });
      const box = page.getByRole("checkbox", { name: /Line 1 reviewed/ });
      await box.click();
      await page.waitForTimeout(150);
      await box.click();
      await page.waitForTimeout(4000);
      const text = await page.locator("main").innerText();
      check("request page: a stale (delayed) reply never overwrites the fresh state", n >= 3 && !text.includes("STALE REPLY"), { gets: n, sawStale: text.includes("STALE REPLY") });
      await page.unroute(new RegExp(`/api/requests/${req.id}$`));
    } else check("request page polling (no request available)", true, "skipped");

    // Enrich: 1.5 s while the panel is open, stops when closed.
    await page.goto("/catalog", { waitUntil: "load" });
    await page.getByRole("button", { name: "Enrich from GUDID" }).click();
    const enrichOpen = await countFor(page, /\/api\/catalog\/enrich$/, 4000);
    check("enrich: polls every 1.5 s while the panel is open", enrichOpen >= 2 && enrichOpen <= 3, { requests: enrichOpen });
    await page.keyboard.press("Escape");
    const enrichClosed = await countFor(page, /\/api\/catalog\/enrich$/, 4000);
    check("enrich: polling stops when the panel closes (Escape)", enrichClosed === 0, { requests: enrichClosed });

    await context.close();
  });
  writeJson("polling.json", results);
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

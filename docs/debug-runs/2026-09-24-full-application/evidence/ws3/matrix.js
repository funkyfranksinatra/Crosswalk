/* Page × role matrix (item G). Loads every page as every role (and signed out), records
 * the document status, console/page errors, hydration errors, failed requests, CSP
 * violations, the visible controls and whether any price is rendered.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/matrix.js [outfile.csv]
 */
const path = require("node:path");
const fs = require("node:fs");
const { withBrowser, contextAs, ROLES, PAGES, sampleIds, resolvePath, OUT, sanitize } = require("./lib");

const ROLE_LIST = ["SIGNED_OUT", ...Object.keys(ROLES)];
const CONTROL_SEL = "button, a.btn-primary, a.btn-secondary, a.btn-ghost, label.btn-secondary, label.btn-ghost, input[type=file]";

async function main() {
  const out = process.argv[2] || path.join(OUT, "matrix.csv");
  const ids = await sampleIds();
  const rows = [["role", "page", "url", "status", "h1", "console_errors", "page_errors", "hydration", "failed_requests", "http_4xx_5xx", "csp", "has_price", "sign_in_screen", "controls"]];
  await withBrowser(async (browser) => {
    for (const role of ROLE_LIST) {
      const { context, page, log } = await contextAs(browser, role === "SIGNED_OUT" ? null : role);
      for (const p of PAGES) {
        const url = resolvePath(p, ids);
        for (const k of Object.keys(log)) log[k].length = 0;
        let status = "ERR";
        const t0 = Date.now();
        try {
          const res = await page.goto(url, { waitUntil: "load", timeout: 20000 }); await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
          status = res ? res.status() : "none";
          await page.waitForTimeout(400);
        } catch (e) { status = `ERR ${String(e.message).slice(0, 60)}`; }
        const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "").catch(() => "");
        const signIn = await page.evaluate(() => document.body.innerText.includes("Sign in to use Crosswalk")).catch(() => false);
        const controls = await page.locator(CONTROL_SEL).evaluateAll((els) => els.filter((e) => e.offsetParent !== null || e.tagName === "INPUT").map((e) => ((e.textContent || e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40) + (e.disabled ? " (disabled)" : ""))).filter(Boolean));
        const bodyText = await page.evaluate(() => document.querySelector("main")?.textContent || "").catch(() => "");
        const hasPrice = /\$\s?\d[\d,]*(\.\d+)?/.test(bodyText);
        const hydration = log.console.filter((c) => /hydrat|did not match|Text content does not match/i.test(c.text)).length + log.errors.filter((e) => /hydrat/i.test(e)).length;
        const consoleErrors = log.console.filter((c) => c.type === "error").map((c) => sanitize(c.text).slice(0, 120));
        rows.push([role, p, url, status, h1.trim().replace(/\s+/g, " ").slice(0, 60), consoleErrors.join(" | "), log.errors.map(sanitize).join(" | "), hydration, log.failed.map((f) => `${f.url.replace(/^https?:\/\/[^/]+/, "")} ${f.err}`).join(" | "), log.responses.map((r) => `${r.status} ${r.url}`).join(" | "), log.csp.length, hasPrice ? 1 : 0, signIn ? 1 : 0, [...new Set(controls)].join(" ; ")]);
        process.stdout.write(`${role} ${p} → ${status} ${Date.now() - t0}ms ${h1.trim().slice(0, 30)}${hydration ? " HYDRATION" : ""}${log.errors.length ? " PAGEERR" : ""}\n`);
      }
      await context.close();
    }
  });
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  fs.writeFileSync(out, csv);
  console.log(`wrote ${out} (${rows.length - 1} rows)`);
}
main().catch((e) => { console.error(e); process.exit(1); });

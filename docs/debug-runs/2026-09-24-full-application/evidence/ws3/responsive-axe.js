/* Item J — responsive + accessibility pass. For every page (as ADMIN) at 1440 / 1024 / 768 / 390:
 * horizontal page overflow (document.scrollWidth > clientWidth), sticky sidebar sanity, then
 * axe-core (node_modules/axe-core/axe.min.js) and the
 * violations grouped by impact. axe is loaded through CDP evaluation (not a script tag), so the
 * production CSP stays untouched. Writes out/responsive.csv and out/axe.json.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/responsive-axe.js [role]
 */
const fs = require("node:fs");
const path = require("node:path");
const { withBrowser, contextAs, PAGES, sampleIds, resolvePath, OUT } = require("./lib");

const WIDTHS = [1440, 1024, 768, 390];
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

async function main() {
  const role = process.argv[2] || "ADMIN";
  const ids = await sampleIds();
  const rows = [["page", "width", "status", "scrollWidth", "clientWidth", "hScroll", "sidebarVisible"]];
  const axe = {};
  await withBrowser(async (browser) => {
    for (const w of WIDTHS) {
      const { context, page } = await contextAs(browser, role, { viewport: { width: w, height: 900 } });
      for (const p of PAGES) {
        const url = resolvePath(p, ids);
        let status = "ERR";
        try { const r = await page.goto(url, { waitUntil: "load", timeout: 20000 }); status = r?.status(); await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined); } catch (e) { status = String(e.message).slice(0, 40); }
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sidebar: Boolean(document.querySelector("aside")?.offsetParent !== null) }));
        rows.push([p, w, status, m.sw, m.cw, m.sw > m.cw ? 1 : 0, m.sidebar ? 1 : 0]);
        if (m.sw > m.cw) {
          const offenders = await page.evaluate(() => { const cw = document.documentElement.clientWidth; return [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > cw + 1 && getComputedStyle(e).position !== "fixed").slice(0, 6).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ").slice(0, 3).join(".")}`); });
          rows[rows.length - 1].push(offenders.join(" | "));
          console.log(`HSCROLL ${p} @${w}: ${m.sw} > ${m.cw} — ${offenders.join(", ")}`);
        }
        if (w === 1440 || w === 390) {
          const shot = path.join(OUT, `shot-${w}-${p.replace(/[^a-z0-9]+/gi, "_") || "root"}.png`);
          // Firefox/WebKit cap a screenshot at 32,767 px; a very tall page falls back to the viewport.
          try { await page.screenshot({ path: shot, fullPage: w === 1440 }); } catch { await page.screenshot({ path: shot, fullPage: false }); }
        }
        if (w === 1440) {
          try {
            // CDP evaluation is not subject to the page CSP (no inline script is inserted), so
            // axe runs against the production CSP exactly as shipped.
            await page.evaluate(AXE);
            const r = await page.evaluate(async () => { const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }); return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })); });
            axe[p] = r;
            const counts = r.reduce((a, v) => { a[v.impact] = (a[v.impact] || 0) + 1; return a; }, {});
            console.log(`AXE ${p}: ${r.length} rule violations ${JSON.stringify(counts)} ${r.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id).join(",")}`);
          } catch (e) { axe[p] = { error: String(e.message) }; console.log(`AXE ${p}: error ${e.message}`); }
        }
      }
      await context.close();
    }
  });
  fs.writeFileSync(path.join(OUT, "responsive.csv"), rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n"));
  fs.writeFileSync(path.join(OUT, "axe.json"), JSON.stringify(axe, null, 2));
  const summary = {};
  for (const [p, v] of Object.entries(axe)) if (Array.isArray(v)) for (const x of v) { summary[x.impact] = summary[x.impact] || {}; summary[x.impact][x.id] = (summary[x.impact][x.id] || 0) + x.nodes; }
  console.log("axe summary by impact (rule → nodes):", JSON.stringify(summary, null, 1));
  console.log(`horizontal-scroll pages: ${rows.slice(1).filter((r) => r[5] === 1).length} of ${rows.length - 1}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

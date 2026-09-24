/* Item J — keyboard-only pass on the main journeys (as ADMIN): skip link, Tab order into the
 * sidebar and page, visible focus rings, menus and popovers opened with Enter, Escape closing
 * them with focus restored, the side-by-side dialog's focus trap.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/keyboard.js
 */
const { withBrowser, contextAs, apiAs, writeJson } = require("./lib");
const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}` : ""}`); }
const active = (page) => page.evaluate(() => { const e = document.activeElement; if (!e) return null; const cs = getComputedStyle(e); return { tag: e.tagName, text: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 40), outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0, inDialog: Boolean(e.closest("[role=dialog]")) }; });

async function main() {
  const req = (await (await apiAs("ADMIN", "/api/requests")).json()).find((r) => r.status === "complete");
  await withBrowser(async (browser) => {
    const { context, page } = await contextAs(browser, "ADMIN");
    await page.goto(`/requests/${req.id}`, { waitUntil: "load" });
    await page.waitForSelector("table tbody tr");
    await page.keyboard.press("Tab");
    let a = await active(page);
    check("first Tab lands on the skip link", a?.text === "Skip to content", a);
    check("skip link has a visible focus ring", a?.outline, a);
    await page.keyboard.press("Enter");
    a = await active(page);
    check("skip link moves focus to main", a?.tag === "MAIN", a);
    await page.keyboard.press("Tab");
    a = await active(page);
    check("Tab from main reaches page content (eyebrow link), not the sidebar", a?.text === "Requests", a);
    // Reload and walk the sidebar order
    await page.goto(`/requests/${req.id}`, { waitUntil: "load" });
    await page.waitForSelector("table tbody tr");
    const order = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); order.push((await active(page)).text); }
    check("sidebar Tab order: skip link, logo, Overview, Cross-reference, Proposals, Deal desk", order[0] === "Skip to content" && order[1].startsWith("Crosswalk") && order.slice(2).join(" > ") === "Overview > Cross-reference > Proposals > Deal desk", order);
    const rings = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); rings.push((await active(page)).outline); }
    check("every focused control shows a focus ring", rings.every(Boolean), rings);
    // Download menu via keyboard
    const dl = page.getByRole("button", { name: /Download/ });
    await dl.focus();
    await page.keyboard.press("Enter");
    check("Enter opens the Download menu", (await page.getByRole("menu", { name: "Download" }).count()) === 1);
    await page.keyboard.press("Tab");
    a = await active(page);
    check("Tab moves into the menu items", a?.tag === "A" && /workbook/i.test(a.text), a);
    await page.keyboard.press("Escape");
    a = await active(page);
    check("Escape closes the menu and restores focus to the trigger", (await page.getByRole("menu").count()) === 0 && /Download/.test(a?.text || ""), a);
    // Side-by-side dialog: open with keyboard, trap, close
    await page.getByRole("button", { name: /Expand line 1 / }).focus();
    await page.keyboard.press("Enter");
    const sbs = page.getByRole("button", { name: "Side-by-side" }).first();
    await sbs.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Side-by-side" });
    await dialog.waitFor();
    await page.waitForSelector("[role=dialog] table");
    a = await active(page);
    check("dialog: focus moves inside on open", a?.inDialog, a);
    const trapped = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); trapped.push((await active(page)).inDialog); }
    check("dialog: Tab stays inside (focus trap)", trapped.every(Boolean), trapped);
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab");
    check("dialog: Shift+Tab stays inside", (await active(page)).inDialog);
    await page.keyboard.press("Escape");
    a = await active(page);
    check("dialog: Escape closes and restores focus to the opener", (await page.getByRole("dialog", { name: "Side-by-side" }).count()) === 0 && a?.text === "Side-by-side", a);
    // New contract popover via keyboard
    await page.goto("/contracts", { waitUntil: "load" });
    const nc = page.getByRole("button", { name: "New contract" });
    await nc.focus(); await page.keyboard.press("Enter");
    a = await active(page);
    check("popover: opens on Enter with focus in the first field", a?.tag === "INPUT" && a.inDialog, a);
    await page.keyboard.press("Escape");
    a = await active(page);
    check("popover: Escape closes and restores focus to the trigger", (await page.getByRole("dialog").count()) === 0 && a?.text === "New contract", a);
    // Sidebar menu at phone width is operable by keyboard
    const { context: c2, page: p2 } = await contextAs(browser, "ADMIN", { viewport: { width: 390, height: 800 } });
    await p2.goto("/", { waitUntil: "load" });
    const menu = p2.locator("button[aria-controls=sidebar-nav]");
    check("phone: Menu button visible, nav hidden", (await menu.isVisible()) && !(await p2.getByRole("link", { name: "Cross-reference" }).isVisible()));
    await menu.focus(); await p2.keyboard.press("Enter");
    check("phone: Enter opens the nav (aria-expanded)", (await menu.getAttribute("aria-expanded")) === "true" && (await p2.getByRole("link", { name: "Cross-reference" }).isVisible()));
    check("phone: section headings present in the open nav", (await p2.locator("#nav-section-commercial").isVisible()) && (await p2.locator("#nav-section-reference").isVisible()));
    await c2.close();
    await context.close();
  });
  writeJson("keyboard.json", results);
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

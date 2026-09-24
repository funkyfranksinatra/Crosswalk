/* WS3-F11 — "Create proposal" on a request that carries no account number: the popover asks
 * which account the quote is for (search via /api/accounts?q=) and posts accountId.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/journey-noaccount.js
 */
const { withBrowser, contextAs, apiAs, writeJson } = require("./lib");
const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}` : ""}`); }

async function main() {
  // A request with pasted cells and no account number (the API accepts that; the proposal API cannot infer an account).
  const fd = new FormData();
  fd.append("csvText", "code,qty\n1190500,4\nB12LTH,2\n"); fd.append("csvName", "no-account.csv"); fd.append("reportType", "Competitive Cross Reference"); fd.append("accountType", "Sold-To"); fd.append("useLlm", "false");
  const created = await (await apiAs("ADMIN", "/api/requests", { method: "POST", body: fd })).json();
  check("request created without an account number", Boolean(created.id), { id: created.id, lines: created.lines });
  let status = "";
  for (let i = 0; i < 60; i++) { status = (await (await apiAs("ADMIN", `/api/requests/${created.id}`)).json()).status; if (["complete", "failed"].includes(status)) break; await new Promise((r) => setTimeout(r, 1000)); }
  check("request ran to complete", status === "complete", status);
  const direct = await apiAs("ADMIN", "/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: created.id }) });
  check("API without accountId refuses with the account message", direct.status === 400 && /Choose an account/.test((await direct.json()).error || ""));
  await withBrowser(async (browser) => {
    const { context, page, log } = await contextAs(browser, "ADMIN");
    await page.goto(`/requests/${created.id}`, { waitUntil: "load" });
    await page.waitForSelector("table tbody tr");
    await page.getByRole("button", { name: "Create proposal" }).click();
    const dlg = page.getByRole("dialog", { name: "Choose the account for this proposal" });
    await dlg.waitFor({ timeout: 5000 });
    check("account picker opens instead of failing", true);
    await dlg.getByRole("textbox", { name: "Search accounts" }).fill("Memorial");
    await page.waitForTimeout(900);
    const hits = await dlg.getByRole("list", { name: "Matching accounts" }).getByRole("button").count();
    check("search lists matching accounts", hits >= 1, { hits });
    await dlg.getByRole("list", { name: "Matching accounts" }).getByRole("button").first().click();
    await page.waitForURL(/\/proposals\/[a-z0-9]+$/, { timeout: 20000 });
    const pid = page.url().split("/").pop();
    const p = await (await apiAs("ADMIN", `/api/proposals/${pid}`)).json();
    check("proposal created for the chosen account", p.request?.id === created.id && /Memorial/.test(p.account?.name || ""), { account: p.account?.name, lines: p.lines?.length });
    check("no page errors", log.errors.length === 0, log.errors);
    await context.close();
  });
  writeJson("journey-noaccount.json", results);
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

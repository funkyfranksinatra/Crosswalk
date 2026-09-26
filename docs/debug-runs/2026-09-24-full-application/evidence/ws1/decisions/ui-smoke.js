const { withBrowser, contextAs, apiAs } = require("../../ws3/lib.js");
const OUT = "./out";
withBrowser(async (browser) => {
  // 1. Crosswalk page as PRODUCT_MARKETING: the queue, then Keep on the soft row and Replace on the hard row.
  const { page, log, context } = await contextAs(browser, "PRODUCT_MARKETING");
  await page.goto("/crosses", { waitUntil: "networkidle" });
  const card = page.locator("section", { has: page.getByRole("heading", { name: /Evidence conflicts/ }) });
  await card.waitFor();
  await card.screenshot({ path: `${OUT}/ui-conflicts-queue.png` });
  const rows = await card.locator("tbody tr").count();
  console.log("queue rows:", rows, "heading:", await card.getByRole("heading").first().textContent());
  const softRow = card.locator("tbody tr", { hasText: "UISMOKE-D11LT" });
  await softRow.getByLabel(/Decision note/).fill("Sales engineering confirmed");
  await softRow.getByRole("button", { name: "Keep" }).click();
  await page.getByRole("status").filter({ hasText: /Row kept/ }).waitFor({ timeout: 10000 });
  console.log("after Keep:", await page.getByRole("status").first().textContent());
  const hardRow = card.locator("tbody tr", { hasText: "UISMOKE-2B5XT" });
  const replaceBtn = hardRow.getByRole("button", { name: /Replace with ONB5LGF/ });
  console.log("replace button:", await replaceBtn.textContent(), "title:", await replaceBtn.getAttribute("title"));
  await replaceBtn.click();
  await page.getByRole("status").filter({ hasText: /Replaced with ONB5LGF/ }).waitFor({ timeout: 10000 });
  console.log("after Replace:", await page.getByRole("status").first().textContent());
  await page.waitForTimeout(500);
  console.log("queue rows after:", await card.locator("tbody tr").count(), "| empty text:", (await card.textContent()).includes("No curated row disagrees"));
  await card.screenshot({ path: `${OUT}/ui-conflicts-empty.png` });
  // API state
  const r = await apiAs("PRODUCT_MARKETING", "/api/crosses?q=UISMOKE");
  const j = await r.json();
  console.log("rows:", j.map((k) => `${k.competitorCode}→${k.ownSku} ${k.approvalStatus} ${k.source} conflict=${k.conflictStatus}`).join(" | "));
  // 2. A rep cannot decide (403), and cannot read the queue payload beyond CROSSWALK_READ semantics.
  const forbid = await apiAs("SALES_REP", `/api/crosses/${j[0].id}/conflict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "RETIRE" }) });
  console.log("rep POST conflict →", forbid.status);
  await context.close();
  // 3. Settings as ADMIN: the visibility control renders and saves.
  const admin = await contextAs(browser, "ADMIN");
  await admin.page.goto("/settings", { waitUntil: "networkidle" });
  const sel = admin.page.getByLabel(/Account visibility/);
  console.log("settings select value:", await sel.inputValue());
  await sel.screenshot({ path: `${OUT}/ui-settings-scope.png` });
  await sel.selectOption("inherit");
  await admin.page.getByRole("button", { name: /^Save$/ }).click();
  await admin.page.getByRole("button", { name: /Saved/ }).waitFor({ timeout: 10000 });
  const s = await (await apiAs("ADMIN", "/api/settings")).json();
  console.log("saved scopeUnassignedParent:", s.scopeUnassignedParent);
  await sel.selectOption("own");
  await admin.page.getByRole("button", { name: /^Save$/ }).click();
  await admin.page.getByRole("button", { name: /Saved/ }).waitFor({ timeout: 10000 });
  console.log("restored:", (await (await apiAs("ADMIN", "/api/settings")).json()).scopeUnassignedParent);
  const rankingCard = admin.page.locator("section", { has: admin.page.getByRole("heading", { name: "Ranking" }) });
  await rankingCard.screenshot({ path: `${OUT}/ui-settings-card.png` });
  console.log("console errors:", log.errors.concat(admin.log.errors), "csp:", log.csp.length + admin.log.csp.length, "4xx/5xx:", log.responses.concat(admin.log.responses).filter((x) => !/UISMOKE|conflict$/.test(x.url)));
  await admin.context.close();
});

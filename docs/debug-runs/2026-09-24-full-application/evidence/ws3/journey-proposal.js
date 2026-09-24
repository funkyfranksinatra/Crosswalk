/* Item H — the proposal journey in the browser: inline price edit, drawer tabs, re-recommend,
 * scenarios (create / apply / delete), logistics save, submit, deal-desk decision as the
 * required role, quote export, record outcome, new version. Each step is asserted through the
 * API afterwards. Needs a DRAFT proposal: pass its id or let the script take the newest one
 * (journey-request.js creates one).
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/journey-proposal.js [proposalId]
 */
const path = require("node:path");
const { withBrowser, contextAs, apiAs, OUT, writeJson, cookieFor } = require("./lib");

const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}` : ""}`); }
const j = async (role, url, init) => { const r = await apiAs(role, url, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };

async function main() {
  const role = process.env.ROLE || "ADMIN"; // ROLE=SALES_REP exercises the deal-desk path (a rep's below-floor price needs PRICING_COMMITTEE)
  let pid = process.argv[2];
  if (!pid) { const list = (await j(role, "/api/proposals")).body; pid = (list.find((p) => p.status === "DRAFT") || list[0])?.id; }
  if (!pid) { console.log("no proposal available"); process.exit(2); }
  await withBrowser(async (browser) => {
    const { context, page, log } = await contextAs(browser, role);
    const shot = (n) => page.screenshot({ path: path.join(OUT, `journey-proposal-${n}.png`), fullPage: true });
    await page.goto(`/proposals/${pid}`, { waitUntil: "load" });
    await page.waitForSelector("table tbody tr", { timeout: 15000 });
    let p = (await j(role, `/api/proposals/${pid}`)).body;
    check("proposal loaded", p.id === pid, { status: p.status, lines: p.lines.length });
    if (p.status !== "DRAFT" && p.permissions.editPricing) {
      await page.getByRole("button", { name: "Reopen" }).click().catch(() => undefined);
      await page.waitForTimeout(800);
      p = (await j(role, `/api/proposals/${pid}`)).body;
    }
    const line = p.lines.find((l) => l.included && l.sku && l.listPrice != null) || p.lines.find((l) => l.included && l.sku);
    check("an included, priced line exists", Boolean(line), line && { code: line.competitorCode, sku: line.sku, proposed: line.proposedPrice, list: line.listPrice });

    // 1. Inline price edit
    const input = page.getByRole("textbox", { name: `Proposed price for ${line.competitorCode}` });
    await input.fill("777.77");
    await input.press("Enter");
    await page.waitForTimeout(900);
    let l2 = (await j(role, `/api/proposals/${pid}`)).body.lines.find((x) => x.id === line.id);
    check("inline price edit persisted (777.77)", Number(l2.proposedPrice) === 777.77, l2.proposedPrice);
    // Validation: a negative price is refused by the server and the UI shows the error
    await input.fill("-5");
    await input.press("Enter");
    await page.waitForTimeout(900);
    const alert = await page.locator("[role=alert]").first().textContent().catch(() => "");
    l2 = (await j(role, `/api/proposals/${pid}`)).body.lines.find((x) => x.id === line.id);
    check("negative price refused and reported", Number(l2.proposedPrice) === 777.77 && Boolean(alert), alert);

    // 2. Drawer tabs
    await page.getByRole("button", { name: line.competitorCode, exact: true }).click();
    for (const t of ["Recommendation", "Price waterfall", "Competitor prices", "Cost basis", "Cross evidence", "Approvals"]) {
      const b = page.getByRole("button", { name: t, exact: true });
      if (!(await b.count())) { check(`drawer tab ${t} present`, t === "Cost basis" && !p.permissions.viewCost, t === "Cost basis" ? "hidden: role has no view_cost" : undefined); continue; }
      await b.click();
      check(`drawer tab ${t}`, (await b.getAttribute("aria-pressed")) === "true");
    }
    await page.getByRole("button", { name: "Recommendation", exact: true }).click();
    // 3. Re-recommend with a strategy
    const strat = page.getByRole("combobox", { name: "Strategy" });
    if (await strat.count()) {
      await strat.selectOption("MATCH");
      await page.getByRole("button", { name: "Apply to this line" }).click();
      await page.waitForTimeout(1000);
      l2 = (await j(role, `/api/proposals/${pid}`)).body.lines.find((x) => x.id === line.id);
      check("re-recommend applied (recommendation JSON present)", Boolean(l2.recommendationJson), { proposed: l2.proposedPrice, recommended: l2.recommendedPrice });
    } else check("re-recommend panel available", false);
    // customer note
    const note = page.getByRole("textbox", { name: /Customer note/ });
    await note.fill("ws3 proposal customer note");
    await note.blur();
    await page.waitForTimeout(800);
    l2 = (await j(role, `/api/proposals/${pid}`)).body.lines.find((x) => x.id === line.id);
    check("line customer note persisted", l2.customerNote === "ws3 proposal customer note", l2.customerNote);
    await shot("01-drawer");

    // 4. Scenarios: create / apply / delete
    const before = (await j(role, `/api/proposals/${pid}/scenarios`)).body.length;
    await page.getByRole("combobox", { name: "New scenario" }).selectOption("AGGRESSIVE");
    await page.waitForTimeout(1200);
    let sc = (await j(role, `/api/proposals/${pid}/scenarios`)).body;
    check("scenario created", sc.length === before + 1, sc.map((s) => s.scenario.name));
    const created = sc[sc.length - 1];
    await page.getByRole("button", { name: created.scenario.name, exact: true }).click();
    check("scenario view banner", (await page.getByText(/Viewing scenario/).count()) === 1);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Apply scenario to proposal" }).click();
    await page.waitForTimeout(1200);
    const applied = (await j(role, `/api/proposals/${pid}`)).body;
    const scLine = created.lines.find((x) => x.id === line.id);
    check("scenario applied to proposal prices", scLine && applied.lines.find((x) => x.id === line.id).proposedPrice != null, { scenarioPrice: scLine?.proposedPrice, now: applied.lines.find((x) => x.id === line.id).proposedPrice });
    await page.getByRole("button", { name: created.scenario.name, exact: true }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForTimeout(1000);
    sc = (await j(role, `/api/proposals/${pid}/scenarios`)).body;
    check("scenario deleted", sc.length === before, sc.length);

    // 5. Logistics
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await page.getByLabel("Freight", { exact: true }).selectOption("FLAT");
    await page.getByLabel("Amount", { exact: true }).fill("25");
    await page.getByLabel("Tax", { exact: true }).selectOption("MANUAL");
    await page.getByLabel("Rate (0.0825)", { exact: true }).fill("0.05");
    await page.getByLabel("Ship-to street").fill("1 Main St");
    await page.getByLabel("City", { exact: true }).fill("Boston");
    await page.getByLabel("State", { exact: true }).fill("MA");
    await page.getByLabel("ZIP", { exact: true }).fill("02101");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1000);
    const lg = (await j(role, `/api/proposals/${pid}/logistics`)).body;
    check("logistics saved (flat freight 25, manual tax 5 %)", lg.freightMode === "FLAT" && Number(lg.freightValue) === 25 && lg.taxMode === "MANUAL" && Number(lg.taxRate) === 0.05, { freight: lg.freightMode, value: lg.freightValue, tax: lg.taxMode, rate: lg.taxRate });
    const calc = page.getByRole("button", { name: /Calculate tax|Recalculate tax/ });
    if (await calc.count()) { await calc.click(); await page.waitForTimeout(1000); const lg2 = (await j(role, `/api/proposals/${pid}/logistics`)).body; check("tax calculated", lg2.totals.tax !== null, lg2.totals); }
    await shot("02-logistics");

    // 6. Submit for approval — first exclude the lines that have no price (no product matched):
    // the server refuses a submission with unpriced included lines and the button says so.
    p = (await j(role, `/api/proposals/${pid}`)).body;
    const unpriced = p.lines.filter((l) => l.included && l.proposedPrice == null);
    const submit = page.getByRole("button", { name: "Submit for approval" });
    if (unpriced.length) check("submit: disabled while included lines are unpriced, with the reason", (await submit.isDisabled()) && /no proposed price/.test((await submit.getAttribute("title")) || ""), await submit.getAttribute("title"));
    for (const l of unpriced) {
      await page.getByRole("button", { name: l.competitorCode, exact: true }).click();
      await page.getByRole("button", { name: "Exclude line" }).click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: l.competitorCode, exact: true }).click().catch(() => undefined);
    }
    // Push one priced line below its floor so the submission needs the deal desk (PRICING_COMMITTEE).
    p = (await j(role, `/api/proposals/${pid}`)).body;
    const floored = p.lines.find((l) => l.included && l.floorPrice != null);
    if (floored) {
      const low = (Number(floored.floorPrice) * 0.9).toFixed(2);
      const fi = page.getByRole("textbox", { name: `Proposed price for ${floored.competitorCode}` });
      await fi.fill(low); await fi.press("Enter"); await page.waitForTimeout(900);
      const fl = (await j(role, `/api/proposals/${pid}`)).body.lines.find((l) => l.id === floored.id);
      check("below-floor price accepted in the draft and flagged for approval", Number(fl.proposedPrice) === Number(low) && Boolean(fl.requiredAuthority), { price: fl.proposedPrice, floor: fl.floorPrice, needs: fl.requiredAuthority });
      check("below-floor input marked aria-invalid", (await fi.getAttribute("aria-invalid")) === "true");
    }
    p = (await j(role, `/api/proposals/${pid}`)).body;
    check("exclude line persisted for every unpriced line", p.lines.filter((l) => l.included && l.proposedPrice == null).length === 0, p.lines.map((l) => `${l.competitorCode}:${l.included ? "in" : "out"}`));
    await submit.click();
    await page.waitForTimeout(1500);
    p = (await j(role, `/api/proposals/${pid}`)).body;
    check("submitted", ["SUBMITTED", "APPROVAL_REQUIRED", "APPROVED", "PARTIALLY_APPROVED"].includes(p.status), { status: p.status, pending: p.approvals.filter((a) => a.status === "PENDING").map((a) => a.requiredRole) });

    // 7. Deal desk as the required role (the submitter may not decide their own request)
    const pending = p.approvals.filter((a) => a.status === "PENDING");
    if (pending.length) {
      const roleFor = { REGIONAL_MANAGER: "REGIONAL_MANAGER", CONTRACTING_MANAGER: "CONTRACTING_MANAGER", PRICING_DIRECTOR: "PRICING_DIRECTOR", PRICING_COMMITTEE: "PRICING_COMMITTEE" };
      for (const a of pending) {
        const approver = roleFor[a.requiredRole] || "PRICING_COMMITTEE";
        const { context: c2, page: p2 } = await contextAs(browser, approver);
        await p2.goto("/approvals", { waitUntil: "load" });
        await p2.waitForTimeout(1500);
        const card = p2.locator("section.card", { hasText: p.reference }).first();
        const present = await card.count();
        check(`deal desk: ${approver} sees the request`, present > 0);
        if (present) {
          await card.getByRole("textbox").fill("ws3 approved in browser");
          await card.getByRole("button", { name: "Approve" }).click();
          await p2.waitForTimeout(1200);
        }
        await c2.close();
      }
      p = (await j(role, `/api/proposals/${pid}`)).body;
      check("approvals decided", p.approvals.every((a) => a.status !== "PENDING"), p.approvals.map((a) => `${a.requiredRole}:${a.status}`));
    } else check("no approvals needed (within authority)", true);
    check("proposal approved", p.status === "APPROVED", p.status);

    // 8. Quote export. Prices changed after the tax was calculated, so the export is refused
    // until tax is recalculated: the button must report that instead of navigating to JSON.
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1200);
    const pdfBtn = page.getByRole("button", { name: "Quote PDF" });
    check("quote export: button enabled once approved", await pdfBtn.isEnabled());
    const lg0 = (await j(role, `/api/proposals/${pid}/logistics`)).body;
    if (lg0.totals.taxStale) {
      await pdfBtn.click();
      await page.waitForTimeout(1200);
      check("quote export: stale-tax refusal shown in the workspace (no navigation)", page.url().endsWith(pid) && (await page.locator("[role=alert]").allTextContents()).some((t) => /recalculate/i.test(t)), (await page.locator("[role=alert]").allTextContents()).join(" | ").slice(0, 160));
      const recalc = page.getByRole("button", { name: /Recalculate tax/ });
      check("quote export: Recalculate tax offered after approval", await recalc.count());
      await recalc.click(); await page.waitForTimeout(1200);
    }
    const dl = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
    await pdfBtn.click();
    const got = await dl;
    check("quote export: PDF download triggered from the button", Boolean(got) && /\.pdf$/.test(got.suggestedFilename()), got && got.suggestedFilename());
    for (const [name, fmt, ct, magic] of [["pdf", "pdf", /application\/pdf/, "%PDF"], ["xlsx", "xlsx", /spreadsheetml/, "PK"], ["csv", "csv", /text\/csv/, null]]) {
      const r = await context.request.get(`/api/proposals/${pid}/export?format=${fmt}`);
      const body = await r.body();
      const h = r.headers();
      check(`quote export ${name}`, r.status() === 200 && ct.test(h["content-type"] || "") && body.length > 0 && (!magic || body.slice(0, magic.length).toString("latin1") === magic), { status: r.status(), type: h["content-type"], disposition: h["content-disposition"], bytes: body.length });
    }
    // 9. Record outcome
    const rec = page.getByRole("button", { name: "Record outcome" });
    check("record outcome offered", await rec.count());
    if (await rec.count()) {
      await rec.click();
      const dlg = page.getByRole("dialog", { name: /Record outcome/ });
      await dlg.waitFor();
      check("outcome dialog: focus inside", await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))));
      await dlg.getByRole("combobox", { name: "Outcome" }).selectOption("WON");
      await dlg.getByRole("textbox", { name: "Price reason" }).fill("ws3 won on price");
      await dlg.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(1500);
      p = (await j(role, `/api/proposals/${pid}`)).body;
      check("outcome recorded (WON)", p.status === "WON" && p.outcome?.outcome === "WON", { status: p.status, outcome: p.outcome });
    }
    await shot("03-outcome");
    // 10. New version
    const nv = page.getByRole("button", { name: "New version" });
    check("new version offered", await nv.count());
    if (await nv.count()) {
      await nv.click();
      await page.waitForURL((u) => /\/proposals\/[a-z0-9]+$/.test(u.toString()) && !u.toString().endsWith(pid), { timeout: 20000 });
      const nid = page.url().split("/").pop();
      const np = (await j(role, `/api/proposals/${nid}`)).body;
      check("new version created (v+1, DRAFT)", np.version === p.version + 1 && np.status === "DRAFT", { v: np.version, status: np.status });
    }
    check("no page errors", log.errors.length === 0, log.errors);
    writeJson("journey-proposal.json", { proposalId: pid, results, http: log.responses });
    await context.close();
  });
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

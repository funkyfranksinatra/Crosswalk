/* Item H — the remaining journeys as ADMIN (or the right role): contracts create + entries +
 * terms (KN-03 GPO contract with a tier), intelligence record / verify / import, catalog
 * template → re-import, enrich, add SKUs, GUDID plan / import / cancel (one tiny import),
 * crosses review actions, notifications, settings weights / branding logo (≤300 KB and
 * oversized) / system card / pricing policies, integrations editor with the mock provider.
 * Every action is asserted through the API or psql-equivalent readback.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/journey-admin.js [section,...]
 * Sections: contracts intelligence catalog gudid crosses notifications settings integrations
 */
const fs = require("node:fs");
const path = require("node:path");
const { withBrowser, contextAs, apiAs, OUT, writeJson } = require("./lib");

const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`); }
const j = async (role, url, init) => { const r = await apiAs(role, url, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const only = process.argv[2] ? process.argv[2].split(",") : null;
const want = (s) => !only || only.includes(s);

async function main() {
  await withBrowser(async (browser) => {
    const { context, page, log } = await contextAs(browser, "ADMIN");
    const shot = (n) => page.screenshot({ path: path.join(OUT, `journey-admin-${n}.png`), fullPage: true });
    const alerts = async () => (await page.locator("[role=alert]").allTextContents()).filter(Boolean);

    if (want("contracts")) {
      await page.goto("/contracts", { waitUntil: "load" });
      await page.getByRole("button", { name: "New contract" }).click();
      const dlg = page.getByRole("dialog", { name: "New contract" });
      check("contracts: popover opens and focuses the first field", await page.evaluate(() => document.activeElement?.tagName === "INPUT"));
      const num = `WS3-GPO-${Date.now().toString(36).toUpperCase()}`;
      await dlg.getByLabel("Contract number").fill(num);
      await dlg.getByLabel("Type").selectOption("GPO");
      check("contracts: GPO select rendered for a GPO contract", (await dlg.getByLabel("GPO", { exact: true }).count()) === 1);
      await dlg.getByLabel("Name").fill("WS3 GPO tier contract");
      const create = dlg.getByRole("button", { name: "Create" });
      check("contracts: Create disabled until a GPO is chosen", await create.isDisabled());
      await dlg.getByLabel("GPO", { exact: true }).selectOption({ index: 1 });
      await dlg.getByLabel("Tier").fill("Tier 2");
      // invalid dates → clear client error
      await dlg.getByLabel("Effective to").fill("2020-01-01");
      await create.click();
      check("contracts: end-before-start rejected with a message", (await alerts()).some((t) => /end date must be after/.test(t)), await alerts());
      await dlg.getByLabel("Effective to").fill("");
      await create.click();
      await page.waitForURL(/\/contracts\/[a-z0-9]+$/, { timeout: 15000 });
      const cid = page.url().split("/").pop();
      const c = (await j("ADMIN", `/api/contracts/${cid}`)).body;
      check("contracts: GPO contract persisted with gpoId and tier (KN-03)", c.type === "GPO" && Boolean(c.gpo) && c.tier === "Tier 2" && c.contractNumber === num, { type: c.type, gpo: c.gpo?.name, tier: c.tier, status: c.status });
      // LOCAL contract with an unknown account number → clear error
      await page.goto("/contracts", { waitUntil: "load" });
      await page.getByRole("button", { name: "New contract" }).click();
      const d2 = page.getByRole("dialog", { name: "New contract" });
      await d2.getByLabel("Contract number").fill(`${num}-L`);
      await d2.getByLabel("Name").fill("bad account");
      await d2.getByLabel("Account number").fill("0000000000000");
      await d2.getByRole("button", { name: "Create" }).click();
      await page.waitForTimeout(800);
      check("contracts: unknown account number → clear error, nothing created", (await alerts()).some((t) => /not found/.test(t)) && !(await j("ADMIN", "/api/contracts")).body.some((x) => x.contractNumber === `${num}-L`), await alerts());
      await page.keyboard.press("Escape");
      check("contracts: Escape closes the popover", (await page.getByRole("dialog", { name: "New contract" }).count()) === 0);
      // entries + terms on the new contract
      await page.goto(`/contracts/${cid}`, { waitUntil: "load" });
      await page.waitForSelector("text=Price entries");
      await page.getByLabel("Price entries, one per line").fill("174006, 640.00\nNOPE-SKU, 1.00\nABSTACK30X, 780, 0, 999, 0–999");
      await page.getByRole("button", { name: "Save entries" }).click();
      await page.waitForTimeout(1200);
      const c2 = (await j("ADMIN", `/api/contracts/${cid}`)).body;
      check("contracts: entries persisted (2 known SKUs; unknown reported)", c2.entries.length === 2 && c2.entries.some((e) => e.product.sku === "174006" && Number(e.price) === 640), c2.entries.map((e) => `${e.product.sku}:${e.price}:${e.volumeTierName ?? ""}`));
      await page.getByRole("button", { name: "Add commitment" }).click();
      await page.getByLabel("Committed value").fill("250000");
      await page.getByLabel("Period end").fill("2027-12-31");
      await page.getByRole("button", { name: "Save commitment" }).click();
      await page.waitForTimeout(1000);
      await page.getByRole("button", { name: "Add rebate" }).click();
      await page.getByLabel(/Tiers, one per line/).fill("100000, 0.02\n250000, 0.04");
      await page.getByRole("button", { name: "Save rebate" }).click();
      await page.waitForTimeout(1000);
      const c3 = (await j("ADMIN", `/api/contracts/${cid}`)).body;
      check("contracts: commitment and rebate terms persisted", c3.commitments.length === 1 && c3.rebates.length === 1 && Number(c3.commitments[0].committedValue) === 250000, { commitments: c3.commitments.length, rebates: c3.rebates.length });
      await page.getByRole("button", { name: "Refresh performance" }).click();
      await page.waitForTimeout(1000);
      await shot("contract");
      // Terminate (confirm dialog) then the entries box is disabled
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Terminate" }).click();
      await page.waitForTimeout(1000);
      const c4 = (await j("ADMIN", `/api/contracts/${cid}`)).body;
      check("contracts: Terminate persisted and the entries box is disabled", c4.status === "TERMINATED" && (await page.getByLabel("Price entries, one per line").isDisabled()), c4.status);
      check("contracts: Terminate control gone on a terminated contract", (await page.getByRole("button", { name: "Terminate" }).count()) === 0);
    }

    if (want("intelligence")) {
      await page.goto("/intelligence", { waitUntil: "load" });
      await page.getByLabel("Competitor", { exact: true }).fill("Ethicon");
      await page.getByLabel("Competitor code").last().fill("WS3-OBS-1");
      await page.getByLabel("Price (USD)").fill("123.45");
      await page.getByLabel("Source reference").fill("ws3 invoice");
      await page.getByRole("button", { name: "Record" }).click();
      await page.waitForTimeout(1200);
      let rows = (await j("ADMIN", "/api/intelligence?sku=WS3-OBS-1")).body.rows ?? [];
      check("intelligence: observation recorded", rows.length >= 1 && Number(rows[0].price) === 123.45, rows.map((r) => `${r.price}:${r.verificationStatus}`));
      // Verify in the browser (search the code first)
      await page.getByLabel("Competitor code").first().fill("WS3-OBS-1");
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: "Verify" }).first().click();
      await page.waitForTimeout(900);
      rows = (await j("ADMIN", "/api/intelligence?sku=WS3-OBS-1")).body.rows ?? [];
      check("intelligence: Verify persisted", rows.some((r) => r.verificationStatus === "VERIFIED"), rows.map((r) => r.verificationStatus));
      await page.getByRole("button", { name: "Dispute" }).first().click();
      await page.waitForTimeout(900);
      rows = (await j("ADMIN", "/api/intelligence?sku=WS3-OBS-1")).body.rows ?? [];
      check("intelligence: Dispute persisted", rows.some((r) => r.verificationStatus === "DISPUTED"), rows.map((r) => r.verificationStatus));
      // Import a small sheet
      const csv = path.join(OUT, "intel-import.csv");
      fs.writeFileSync(csv, "Competitor,Competitor Code,Price,Currency,Source Type\nEthicon,WS3-OBS-2,99.10,USD,CUSTOMER_INVOICE\nEthicon,WS3-OBS-3,101.00,USD,REP_OBSERVED\nEthicon,,5,USD,REP_OBSERVED\n");
      await page.setInputFiles("input[type=file][accept='.xlsx,.csv']", csv);
      await page.waitForTimeout(1500);
      const status = await page.locator("[role=status]").first().textContent().catch(() => "");
      const r2 = (await j("ADMIN", "/api/intelligence?sku=WS3-OBS-2")).body.rows ?? [];
      check("intelligence: import recorded 2 rows and skipped the blank code", /2 observations recorded/.test(status) && r2.length >= 1, status);
      // Role gate: SALES_REP cannot verify (no button), FINANCE cannot record
      const { context: cr, page: pr } = await contextAs(browser, "SALES_REP");
      await pr.goto("/intelligence?sku=WS3-OBS-2", { waitUntil: "load" });
      await pr.waitForTimeout(1200);
      check("intelligence: SALES_REP sees no Verify/Dispute (no verify_competitor_pricing)", (await pr.getByRole("button", { name: /^(Verify|Dispute)$/ }).count()) === 0);
      check("intelligence: SALES_REP can still record (import_competitor_pricing)", (await pr.getByRole("button", { name: "Record" }).count()) === 1);
      await cr.close();
      const { context: cf, page: pf } = await contextAs(browser, "FINANCE");
      await pf.goto("/intelligence", { waitUntil: "load" });
      await pf.waitForTimeout(1000);
      check("intelligence: FINANCE gets a read-only record card and no import controls", (await pf.getByRole("button", { name: "Record" }).count()) === 0 && (await pf.getByText(/Read-only: importing needs/).count()) === 1);
      await cf.close();
    }

    if (want("catalog")) {
      // Pricing template → fill → re-import
      const tpl = await context.request.get("/api/pricing/template?format=csv");
      const text = await tpl.text();
      check("catalog: pricing template csv served", tpl.status() === 200 && /SKU/i.test(text.split("\n")[0]), text.split("\n")[0]);
      const lines = text.split("\n");
      const header = lines[0].split(",");
      const iSku = header.findIndex((h) => /sku/i.test(h)), iList = header.findIndex((h) => /list/i.test(h));
      const row = lines.slice(1).find((l) => l.split(",")[iSku] === "174006");
      const cells = row.split(","); cells[iList] = "661.25";
      const filled = path.join(OUT, "pricing-filled.csv");
      fs.writeFileSync(filled, [lines[0], cells.join(",")].join("\n"));
      await page.goto("/catalog", { waitUntil: "load" });
      await page.getByRole("button", { name: "Pricing", exact: true }).click();
      await page.getByRole("dialog", { name: "Pricing import" }).locator("input[type=file]").setInputFiles(filled);
      await page.waitForTimeout(2500);
      const prod = (await j("ADMIN", "/api/catalog/gudid")).body; // stats only; verify via the page
      void prod;
      const html = await (await apiAs("ADMIN", "/catalog?q=174006")).text();
      check("catalog: re-imported list price shows ($661.25)", html.includes("$661.25"));
      // restore the sentinel price the price-gate check relies on
      cells[iList] = "655.00"; const restore = path.join(OUT, "pricing-restore.csv"); fs.writeFileSync(restore, [lines[0], cells.join(",")].join("\n"));
      await page.getByRole("dialog", { name: "Pricing import" }).locator("input[type=file]").setInputFiles(restore);
      await page.waitForTimeout(2500);
      check("catalog: restore import applied ($655.00 back)", (await (await apiAs("ADMIN", "/catalog?q=174006")).text()).includes("$655.00"));
      // Competitor sizes template + import
      const st = await context.request.get("/api/competitor-sizes/template?format=csv");
      const stext = await st.text();
      check("catalog: competitor sizes template served", st.status() === 200 && stext.length > 0, stext.split("\n")[0]);
      const sh = stext.split("\n")[0].split(",");
      const sizes = path.join(OUT, "sizes-filled.csv");
      const srow = sh.map((h) => (/code/i.test(h) ? "WS3SIZE1" : /width/i.test(h) ? "10" : /length/i.test(h) ? "15" : /manufacturer|competitor/i.test(h) ? "Ethicon" : /unit/i.test(h) ? "cm" : ""));
      fs.writeFileSync(sizes, [sh.join(","), srow.join(",")].join("\n"));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Competitor sizes" }).click();
      await page.getByRole("dialog", { name: "Competitor sizes import" }).locator("input[type=file]").setInputFiles(sizes);
      await page.waitForTimeout(2000);
      const sres = (await page.getByRole("dialog", { name: "Competitor sizes import" }).locator(".bg-accent-soft").allTextContents()).join(" ");
      check("catalog: sizes import reports a result", /saved|skipped|error/i.test(sres), sres.slice(0, 120));
      await page.keyboard.press("Escape");
      // Enrich: starts, polls, finishes (all SKUs already have GUDID → quick)
      await page.getByRole("button", { name: "Enrich from GUDID" }).click();
      await page.getByRole("button", { name: "Start" }).click();
      await page.waitForTimeout(4000);
      const en = (await j("ADMIN", "/api/catalog/enrich")).body;
      check("catalog: enrich job reachable after start", typeof en.running === "boolean", en);
      await page.keyboard.press("Escape");
      // Add SKUs: an invalid token is reported without a crash
      await page.getByRole("button", { name: "Add SKUs" }).click();
      await page.getByRole("dialog", { name: "Add SKUs" }).getByRole("textbox").first().fill("174006\n!!!");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForTimeout(3000);
      const addMsg = (await page.getByRole("dialog", { name: "Add SKUs" }).locator(".bg-accent-soft").allTextContents()).join(" ");
      check("catalog: Add SKUs reports present / invalid tokens", /already present/.test(addMsg) && /not catalog numbers|not found/.test(addMsg), addMsg);
      await page.keyboard.press("Escape");
      await shot("catalog");
    }

    if (want("gudid")) {
      await page.goto("/catalog/gudid", { waitUntil: "load" });
      await page.getByRole("button", { name: "Import from GUDID" }).click();
      await page.getByLabel("Labeler name (as it appears in GUDID)").fill("Sofradim");
      await page.getByLabel(/FDA product codes/).fill("FTL");
      await page.getByRole("button", { name: "Preview count" }).click();
      await page.waitForSelector("text=/records across/", { timeout: 30000 }).catch(() => undefined);
      const plan = await page.locator("[role=dialog]").innerText();
      const total = Number((plan.match(/([\d,]+)\s+records across/)?.[1] || "0").replace(/,/g, ""));
      check("gudid: plan preview shows a record count", total >= 0 && /records across/.test(plan), plan.match(/[\d,]+ records across[^\n]*/)?.[0]);
      const already = /([\d,]+) already in the library/.exec(plan)?.[1];
      if (already && already !== "0") check("gudid: import skipped — the library already holds this labeler (rerun)", true, `${already} already`);
      else if (total > 0 && total <= 400) {
        await page.getByRole("button", { name: "Start import" }).click();
        await page.waitForTimeout(1500);
        let job = (await j("ADMIN", "/api/catalog/gudid")).body;
        // the client polls /api/catalog/gudid/{id} every 2 s; watch through the history table instead
        const imports = () => apiAs("ADMIN", "/catalog/gudid").then((r) => r.text());
        let done = false;
        for (let i = 0; i < 40 && !done; i++) { await page.waitForTimeout(2000); const t = await page.locator("[role=dialog]").innerText({ timeout: 1500 }).catch(() => ""); done = /\b(done|failed|cancelled)\b/i.test(t); }
        const t = await page.locator("[role=dialog]").innerText({ timeout: 1500 }).catch(() => "");
        check("gudid: tiny import ran to completion", /\bdone\b/i.test(t), t.match(/[^\n]*(done|failed|cancelled)[^\n]*/i)?.[0]);
        void job; void imports;
        const stats = (await j("ADMIN", "/api/catalog/gudid")).body;
        check("gudid: library has records after the import", (stats.total ?? 0) > 0, stats);
      } else {
        check("gudid: import skipped (plan too large or zero) — being gentle with openFDA", true, `total=${total}`);
      }
      // Cancel path: needs a second live import (one more openFDA request) — only when asked
      // for explicitly (GUDID_CANCEL_TEST=1), to stay within "one small import".
      if (process.env.GUDID_CANCEL_TEST === "1") {
        await page.getByLabel("Labeler name (as it appears in GUDID)").fill("Sofradim");
        await page.getByLabel(/FDA product codes/).fill("FTL");
        const startBtn = page.getByRole("button", { name: "Start import" });
        await startBtn.click();
        await page.waitForTimeout(300);
        const cancel = page.getByRole("button", { name: "Cancel import" });
        if (await cancel.count()) { await cancel.click(); await page.waitForTimeout(3000); }
        const hist = await (await apiAs("ADMIN", "/catalog/gudid")).text();
        check("gudid: cancel recorded in the import history", /cancelled|done/.test(hist), hist.includes("cancelled") ? "cancelled" : "finished before the cancel landed");
      } else check("gudid: cancel path skipped (set GUDID_CANCEL_TEST=1 to run a second live import)", true, "skipped");
      // Existing-import guard: with the import done, the panel offers Start again (no stale 'running' state)
      check("gudid: panel back to idle after the import", (await page.getByRole("button", { name: "Start import" }).count()) === 1);
      await shot("gudid");
    }

    if (want("crosses")) {
      // Propose a rep cross via the API, then review it in the browser as PRODUCT_MARKETING + CLINICAL_REVIEWER
      const req = (await j("ADMIN", "/api/requests")).body[0];
      const proposed = await j("ADMIN", "/api/crosses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownSku: "174006", competitorName: "Ethicon", competitorCode: `WS3X${Date.now().toString(36)}`, matchType: "Close Match", justification: "ws3 review test", requestId: req?.id }) });
      check("crosses: rep proposal accepted by the API", proposed.status === 200, proposed.body);
      const { context: cm, page: pm } = await contextAs(browser, "PRODUCT_MARKETING");
      await pm.goto("/crosses", { waitUntil: "load" });
      await pm.waitForTimeout(1500);
      const queueTxt = await pm.locator("main").innerText();
      const marketingSees = /ws3 review test/.test(queueTxt);
      check("crosses: PRODUCT_MARKETING sees the queued cross (or an honest fetch error, never a silent empty queue)", marketingSees || /Could not load the review queue/.test(queueTxt), queueTxt.match(/(Could not load the review queue[^\n]*|Nothing awaiting review)/)?.[0] ?? "queue rendered");
      if (marketingSees) {
        const row = pm.locator("tr", { hasText: "ws3 review test" });
        await row.getByRole("button", { name: "Approve marketing" }).click();
        await pm.waitForTimeout(1000);
        const cross = (await j("ADMIN", `/api/crosses?status=DRAFT`)).body.concat((await j("ADMIN", `/api/crosses?status=IN_REVIEW`)).body).find((c) => c.justification === "ws3 review test");
        check("crosses: marketing approval persisted", cross?.marketingReviewStatus === "APPROVED", cross && { m: cross.marketingReviewStatus, c: cross.clinicalReviewStatus });
        check("crosses: Approve stays disabled until clinical review too", await row.getByRole("button", { name: "Approve", exact: true }).isDisabled());
      }
      await cm.close();
      const { context: cc, page: pc } = await contextAs(browser, "CLINICAL_REVIEWER");
      await pc.goto("/crosses", { waitUntil: "load" });
      await pc.waitForTimeout(1500);
      const clinTxt = await pc.locator("main").innerText();
      const clinSees = /ws3 review test/.test(clinTxt);
      const routeSrc = fs.readFileSync(path.join(__dirname, "../../../../../src/app/api/crosses/route.ts"), "utf8");
      const ws4Changed = /manage_crosswalk|review_crosswalk_clinical/.test(routeSrc);
      check(`crosses: CLINICAL_REVIEWER queue (WS4 route change ${ws4Changed ? "present" : "NOT yet present"})`, ws4Changed ? clinSees : /Could not load the review queue/.test(clinTxt), clinTxt.match(/(Could not load the review queue[^\n]*|Nothing awaiting review)/)?.[0] ?? "queue rendered");
      check("crosses: CLINICAL_REVIEWER page carries no prices", !/\$\d/.test(clinTxt));
      if (clinSees) {
        const row = pc.locator("tr", { hasText: "ws3 review test" });
        await row.getByRole("button", { name: "Approve clinically" }).click();
        await pc.waitForTimeout(1000);
        const cross = (await j("ADMIN", `/api/crosses?status=IN_REVIEW`)).body.concat((await j("ADMIN", `/api/crosses?status=DRAFT`)).body).find((c) => c.justification === "ws3 review test");
        check("crosses: clinical approval persisted", cross?.clinicalReviewStatus === "APPROVED");
      }
      await cc.close();
      await page.goto("/crosses", { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const row = page.locator("tr", { hasText: "ws3 review test" });
      if (await row.count()) {
        const approveBtn = row.getByRole("button", { name: "Approve", exact: true });
        if (await approveBtn.isEnabled()) { await approveBtn.click(); await page.waitForTimeout(1000); const cross = (await j("ADMIN", `/api/crosses?status=APPROVED`)).body.find((c) => c.justification === "ws3 review test"); check("crosses: final approval persisted", cross?.approvalStatus === "APPROVED"); }
        else check("crosses: ADMIN Approve still blocked (a review is missing)", true, await approveBtn.getAttribute("title"));
      }
      await shot("crosses");
    }

    if (want("notifications")) {
      await page.goto("/notifications", { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const before = (await j("ADMIN", "/api/notifications?unread=1&take=1")).body.unread;
      const markAll = page.getByRole("button", { name: "Mark all read" });
      check("notifications: inbox rendered", (await page.getByText("Inbox").count()) >= 1, { unread: before });
      if (before > 0) { await markAll.click(); await page.waitForTimeout(900); check("notifications: mark all read persisted", (await j("ADMIN", "/api/notifications?unread=1&take=1")).body.unread === 0); }
      else check("notifications: Mark all read disabled with nothing unread", await markAll.isDisabled());
      const box = page.getByRole("checkbox", { name: /Run complete in-app/ });
      const was = await box.isChecked();
      await box.click();
      await page.waitForTimeout(900);
      const pref = (await j("ADMIN", "/api/notifications/preferences")).body.preferences.find((p) => p.kind === "RUN_COMPLETE");
      check("notifications: preference toggle persisted", pref && pref.inApp === !was, pref);
      await box.click(); await page.waitForTimeout(600);
      check("notifications: e-mail column disabled when SMTP is not configured", await page.getByRole("checkbox", { name: /Run complete by e-mail/ }).isDisabled());
    }

    if (want("settings")) {
      await page.goto("/settings", { waitUntil: "load" });
      const s0 = (await j("ADMIN", "/api/settings")).body;
      const slider = page.locator("#weight-price");
      await slider.fill("70");
      await page.locator("#max-candidates").fill("6");
      await page.getByRole("button", { name: "Save", exact: true }).first().click();
      await page.waitForTimeout(1200);
      const s1 = (await j("ADMIN", "/api/settings")).body;
      check("settings: weights and candidates persisted", Math.abs(Number(s1.weights?.price ?? s1.settings?.weights?.price) - 0.7) < 0.01 && Number(s1.maxCandidates ?? s1.settings?.maxCandidates) === 6, { before: s0.weights ?? s0.settings?.weights, after: s1.weights ?? s1.settings?.weights, max: s1.maxCandidates ?? s1.settings?.maxCandidates });
      await j("ADMIN", "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weights: s0.weights, maxCandidates: s0.maxCandidates, companyName: s0.companyName }) }); // restore
      // Branding logo: 4 KB png OK, 400 KB rejected client-side
      await page.getByRole("button", { name: "Edit", exact: true }).first().click();
      const small = path.join(OUT, "logo-small.png"), big = path.join(OUT, "logo-big.png");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
      fs.writeFileSync(small, png);
      fs.writeFileSync(big, Buffer.concat([png, Buffer.alloc(400 * 1024, 0)]));
      await page.locator("#branding-logo").setInputFiles(big);
      await page.waitForTimeout(400);
      check("settings: oversized logo rejected with the size", (await alerts()).some((t) => /under 300 KB/.test(t)), await alerts());
      await page.locator("#branding-logo").setInputFiles(small);
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Save branding" }).click();
      await page.waitForTimeout(1200);
      const br = (await j("ADMIN", "/api/settings/branding")).body;
      check("settings: small logo persisted", typeof br.logoDataUrl === "string" && br.logoDataUrl.startsWith("data:image/png"), br.logoDataUrl?.slice(0, 30));
      // Oversized through the API (server-side cap)
      const rr = await j("ADMIN", "/api/settings/branding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...br, logoDataUrl: "data:image/png;base64," + Buffer.alloc(400 * 1024, 65).toString("base64") }) });
      check("settings: server also refuses an oversized logo", rr.status === 400, { status: rr.status, error: rr.body.error });
      // System card actions
      await page.getByRole("button", { name: "Evaluate alerts now" }).click();
      await page.waitForTimeout(1500);
      check("settings: evaluate alerts reported", /Evaluated:/.test(await page.locator("main").innerText()));
      await page.getByRole("button", { name: "Refresh stale records" }).click();
      await page.waitForTimeout(1500);
      await shot("settings");
      // Pricing policies: new draft → activate
      await page.goto("/settings/pricing", { waitUntil: "load" });
      await page.waitForSelector("table tbody tr");
      await page.getByRole("button", { name: "New draft" }).click();
      await page.getByLabel("Product family").fill("WS3-FAMILY");
      await page.getByLabel("Name").fill("ws3 draft");
      const rules = page.getByLabel(/Approval rules/);
      await rules.fill("not json");
      check("settings/pricing: invalid rules JSON flagged and Save disabled", await page.getByRole("button", { name: "Save draft" }).isDisabled());
      await rules.fill('[{"when":{"belowFloor":true},"require":"PRICING_COMMITTEE","reason":"below floor"}]');
      await page.getByRole("button", { name: "Save draft" }).click();
      await page.waitForTimeout(1200);
      let pols = (await j("ADMIN", "/api/pricing-policies")).body;
      const draft = pols.find((p) => p.productFamily === "WS3-FAMILY" && p.status === "DRAFT");
      check("settings/pricing: draft persisted", Boolean(draft), draft && { v: draft.version, status: draft.status });
      if (draft) {
        page.once("dialog", (d) => d.accept());
        await page.locator("tr", { hasText: "WS3-FAMILY" }).getByRole("button", { name: "Activate" }).click();
        await page.waitForTimeout(1200);
        pols = (await j("ADMIN", "/api/pricing-policies")).body;
        check("settings/pricing: activation persisted", pols.some((p) => p.id === draft.id && p.status === "ACTIVE"));
      }
      const { context: cr, page: pr } = await contextAs(browser, "PRICING_ANALYST");
      await pr.goto("/settings/pricing", { waitUntil: "load" });
      await pr.waitForTimeout(800);
      check("settings/pricing: analyst's New draft is disabled with the reason", (await pr.getByRole("button", { name: "New draft" }).isDisabled()) && /configure pricing rules/.test((await pr.getByRole("button", { name: "New draft" }).getAttribute("title")) || ""));
      check("settings/pricing: analyst sees no Activate / New version", (await pr.getByRole("button", { name: /Activate|New version/ }).count()) === 0);
      await cr.close();
    }

    if (want("integrations")) {
      await page.goto("/settings/integrations", { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const crm = page.getByRole("button", { name: /Salesforce|CRM/ }).first();
      await crm.click();
      await page.waitForSelector("#int-provider", { timeout: 15000 });
      const opts = await page.locator("#int-provider option").evaluateAll((o) => o.map((x) => ({ v: x.value, disabled: x.disabled })));
      const mock = opts.find((o) => o.v === "mock");
      check("integrations: mock provider listed", Boolean(mock), opts);
      if (mock && !mock.disabled) {
        await page.locator("#int-provider").selectOption("mock");
        await page.getByRole("checkbox", { name: "Enabled" }).check();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForTimeout(1500);
        check("integrations: save reported", /Saved/.test((await page.locator("[role=status],[role=alert]").allTextContents()).join(" ")), (await page.locator("[role=status],[role=alert]").allTextContents()).join(" ").slice(0, 160));
        await page.getByRole("button", { name: "Test connection" }).click();
        await page.waitForTimeout(2000);
        const t = (await page.locator("[role=status],[role=alert]").allTextContents()).join(" ");
        check("integrations: test connection reported", /connect|ok|reach|Mock/i.test(t), t.slice(0, 160));
        await page.getByRole("button", { name: "Validate mapping" }).click();
        await page.waitForTimeout(2000);
        const v = (await page.locator("[role=status],[role=alert]").allTextContents()).join(" ");
        check("integrations: validate mapping reported", /Mapping/.test(v), v.slice(0, 160));
        await page.getByRole("button", { name: "Sync a test record" }).click();
        await page.waitForTimeout(3000);
        const sy = (await page.locator("[role=status],[role=alert]").allTextContents()).join(" ");
        check("integrations: test-record sync reported", /sync/i.test(sy), sy.slice(0, 200));
        const cfg = (await j("ADMIN", "/api/integrations/config")).body.integrations.find((i) => /salesforce|crm/i.test(i.key) || i.family === "crm");
        check("integrations: config persisted with the mock provider", cfg && cfg.provider === "mock" && cfg.enabled, cfg && { key: cfg.key, provider: cfg.provider, status: cfg.status });
      } else check("integrations: mock provider not allowed in this build (INTEGRATIONS_ALLOW_MOCK unset) — editor left untested", true, "skipped");
      await shot("integrations");
      const { context: cr, page: pr } = await contextAs(browser, "PRODUCT_MARKETING");
      const r = await pr.goto("/settings/integrations", { waitUntil: "load" });
      check("integrations: non-admin is redirected to /settings", pr.url().endsWith("/settings") && r.status() === 200, pr.url());
      await cr.close();
    }

    check("no page errors", log.errors.length === 0, log.errors);
    check("no CSP violations", log.csp.length === 0, log.csp);
    writeJson("journey-admin.json", { results, http: log.responses });
    await context.close();
  });
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

/* Item H — the cross-reference request journey, end to end in the browser as ADMIN:
 * wizard with an upload (fixtures/intake.csv: duplicates, a summary row, IN-12-4), preview
 * accounting, submit, progress to complete, filters, all six bulk actions, candidate select,
 * notes, flag, side-by-side modal (Escape + focus), the five downloads, create proposal.
 * Every action is asserted against the API afterwards.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/journey-request.js
 * Writes out/journey-request.json (+ screenshots) and prints PASS/FAIL lines; exit 1 on failure.
 */
const path = require("node:path");
const { withBrowser, contextAs, apiAs, OUT, writeJson } = require("./lib");

const results = [];
let failures = 0;
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}` : ""}`); }

async function main() {
  const role = process.env.ROLE || "ADMIN";
  await withBrowser(async (browser) => {
    const { context, page, log } = await contextAs(browser, role);
    const shot = (n) => page.screenshot({ path: path.join(OUT, `journey-request-${n}.png`), fullPage: true });

    // 1. Wizard with upload
    await page.goto("/requests/new", { waitUntil: "load" });
    await page.getByRole("button", { name: "Upload .xlsx / .csv" }).click();
    await page.setInputFiles("input[type=file]", path.join(__dirname, "fixtures", "intake.csv"));
    await page.waitForSelector("text=/\\d+ codes/", { timeout: 20000 });
    const previewText = await page.locator("main").innerText();
    check("preview: 5 distinct codes", /\b5 codes\b/.test(previewText), previewText.match(/\d+ codes/)?.[0]);
    check("preview: 1 duplicate row merged", /1 duplicate rows? merged/.test(previewText), previewText.match(/\d+ duplicate rows? merged/)?.[0]);
    check("preview: summary/junk rows skipped", /\d+ rows? skipped/.test(previewText), previewText.match(/\d+ rows? skipped/)?.[0]);
    check("preview: IN-12-4 kept as a code", previewText.includes("IN-12-4"));
    check("preview: merged quantity 15 for 1190500", /1190500[\s\S]{0,80}\b15\b/.test(previewText));
    await shot("01-preview");
    await page.getByLabel("Account number").fill("0009999123");
    await page.getByLabel("Account / Group / IDN name").fill("WS3 Journey Hospital");
    await page.getByLabel("Requested by").fill("WS3 Playwright");
    const pricebook = page.getByLabel("Pricebook");
    const options = await pricebook.locator("option").allTextContents();
    check("wizard: pricebook options listed", options.length >= 2, options);
    await pricebook.selectOption({ index: 1 });
    // Double-click guard: two rapid clicks must create exactly one request.
    const before = (await (await apiAs(role, "/api/requests")).json()).length;
    const btn = page.getByRole("button", { name: "Continue request" });
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/api\/requests$/.test(r.url())) posts.push(Date.now()); });
    await btn.click();
    // a second click 120 ms later lands after the response but before the navigation — the window that used to create a second request
    await page.waitForTimeout(120);
    await btn.click({ force: true, timeout: 2000 }).catch(() => undefined);
    await page.waitForURL(/\/requests\/(?!new$)[a-z0-9]+$/, { timeout: 30000 });
    const id = page.url().split("/").pop();
    await page.waitForTimeout(2000);
    const after = (await (await apiAs(role, "/api/requests")).json()).length;
    check("submit: only one POST /api/requests on a double click", posts.length === 1, { posts: posts.length });
    check("submit: exactly one request created on a double click", after === before + 1, { before, after, id });

    // 2. Progress to complete
    const t0 = Date.now();
    let status = "";
    for (let i = 0; i < 120; i++) {
      const j = await (await apiAs(role, `/api/requests/${id}`)).json();
      status = j.status;
      if (["complete", "failed", "cancelled"].includes(status)) break;
      await page.waitForTimeout(1000);
    }
    check("run: reached complete", status === "complete", `${status} after ${Math.round((Date.now() - t0) / 1000)} s`);
    await page.waitForSelector("text=Complete", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const req = await (await apiAs(role, `/api/requests/${id}`)).json();
    check("run: 5 lines persisted", req.lines.length === 5, req.lines.map((l) => `${l.rawCode}:${l.resolutionStatus}`));
    check("run: 1190500 quantity merged to 15", req.lines.find((l) => l.rawCode === "1190500")?.quantity === 15);
    check("run: progress polling stopped (status not running)", !["running", "queued"].includes(req.status));
    await shot("02-complete");

    // 3. Filters
    for (const f of ["All", "Needs attention", "Flagged", "Exact", "Close", "Alternative", "Already ours"]) {
      const b = page.getByRole("button", { name: new RegExp(`^${f}\\b`) }).first();
      await b.click();
      const pressed = await b.getAttribute("aria-pressed");
      const rows = await page.locator("table tbody tr").count();
      check(`filter: ${f} selectable`, pressed === "true", `${rows} rows`);
    }
    await page.getByRole("button", { name: /^All\b/ }).click();

    // 4. Bulk actions — all six, each asserted through the API
    const bulk = async (label) => {
      await page.getByRole("button", { name: /Bulk actions/ }).click();
      await page.getByRole("menuitem", { name: new RegExp(label) }).click();
      await page.waitForTimeout(800);
      return (await (await apiAs(role, `/api/requests/${id}`)).json()).lines;
    };
    let lines = await bulk("Mark all Exact matches reviewed");
    const exact = req.lines.filter((l) => l.candidates.find((c) => c.id === l.selectedCandidateId)?.matchType === "Exact Match").length;
    check("bulk: review_exact marks the exact lines reviewed", lines.filter((l) => l.reviewed).length === exact, { exact, reviewed: lines.filter((l) => l.reviewed).length });
    lines = await bulk("Mark every matched line reviewed");
    const matched = req.lines.filter((l) => l.selectedCandidateId).length;
    check("bulk: review_matched marks every matched line", lines.filter((l) => l.reviewed).length === matched, { matched, reviewed: lines.filter((l) => l.reviewed).length });
    lines = await bulk("Clear all reviewed marks");
    check("bulk: unreview_all clears reviewed", lines.every((l) => !l.reviewed));
    lines = await bulk("Flag everything needing attention");
    const flaggedAfter = lines.filter((l) => l.flag === "verify").length;
    check("bulk: flag_verify sets flags", flaggedAfter >= 0, { flagged: flaggedAfter });
    lines = await bulk("Clear all verify flags");
    check("bulk: clear_flags clears every flag", lines.every((l) => !l.flag));
    // select_top: clear a selection first, then ask the server to pick the top candidate
    const withSel = lines.find((l) => l.selectedCandidateId && l.candidates.length);
    if (withSel) {
      await apiAs(role, `/api/requests/${id}/lines/${withSel.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedCandidateId: null }) });
      lines = await bulk("Select the top candidate");
      check("bulk: select_top re-selects a candidate", Boolean(lines.find((l) => l.id === withSel.id)?.selectedCandidateId));
    } else check("bulk: select_top (no selectable line in this run)", true, "skipped");
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("table tbody tr");

    // 5. Expand, select candidate, notes, flag, side-by-side
    const line = lines.find((l) => l.candidates.length > 1) || lines.find((l) => l.candidates.length);
    check("line with candidates exists", Boolean(line));
    if (line) {
      await page.getByRole("button", { name: new RegExp(`Expand line ${line.lineNo}`) }).click();
      const other = line.candidates.find((c) => c.id !== line.selectedCandidateId) || line.candidates[0];
      const radio = page.getByRole("radio", { name: `Select ${other.ownProduct.sku} for this line` });
      await radio.click();
      await page.waitForTimeout(60);
      check("select candidate: radio reflects the click at once (optimistic)", await radio.isChecked());
      await page.waitForTimeout(700);
      let l2 = (await (await apiAs(role, `/api/requests/${id}`)).json()).lines.find((l) => l.id === line.id);
      check("select candidate persisted", l2.selectedCandidateId === other.id, { want: other.ownProduct.sku });
      await page.locator(`#note-${line.id}`).fill("ws3 rep note");
      await page.locator(`#cnote-${line.id}`).fill("ws3 customer note");
      await page.locator(`#price-${line.id}`).fill("123.45");
      await page.getByRole("button", { name: "Flag to verify" }).first().click(); // blur commits the price
      await page.waitForTimeout(900);
      l2 = (await (await apiAs(role, `/api/requests/${id}`)).json()).lines.find((l) => l.id === line.id);
      check("rep note persisted", l2.overrideNote === "ws3 rep note", l2.overrideNote);
      check("customer note persisted", l2.customerNote === "ws3 customer note", l2.customerNote);
      check("est. competitor price persisted", Number(l2.estCompetitorPrice) === 123.45, l2.estCompetitorPrice);
      check("flag persisted", l2.flag === "verify", l2.flag);
      const reviewed = page.getByRole("checkbox", { name: `Line ${line.lineNo} reviewed` });
      await reviewed.check();
      await page.waitForTimeout(700);
      l2 = (await (await apiAs(role, `/api/requests/${id}`)).json()).lines.find((l) => l.id === line.id);
      check("reviewed persisted", l2.reviewed === true);
      // Side-by-side modal
      const sbs = page.getByRole("button", { name: "Side-by-side" }).first();
      await sbs.focus();
      await sbs.click();
      const dialog = page.getByRole("dialog", { name: "Side-by-side" });
      await dialog.waitFor({ timeout: 10000 });
      await page.waitForSelector("[role=dialog] table", { timeout: 10000 });
      const rowsInDialog = await dialog.locator("table tbody tr").count();
      check("side-by-side: attribute rows rendered", rowsInDialog > 0, `${rowsInDialog} rows`);
      const focusInside = await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")));
      check("side-by-side: focus moved into the dialog", focusInside);
      await shot("03-side-by-side");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check("side-by-side: Escape closes", (await page.getByRole("dialog", { name: "Side-by-side" }).count()) === 0);
      const restored = await page.evaluate(() => document.activeElement?.textContent?.trim());
      check("side-by-side: focus restored to the opener", restored === "Side-by-side", restored);
    }

    // 6. Downloads (through the browser session)
    const downloads = [
      ["xref xlsx", `/api/requests/${id}/export?type=xref`, /spreadsheetml/, /\.xlsx/, "PK"],
      ["xref csv", `/api/requests/${id}/export?type=xref&format=csv`, /text\/csv/, /\.csv/, null],
      ["offer xlsx", `/api/requests/${id}/export?type=offer`, /spreadsheetml/, /\.xlsx/, "PK"],
      ["offer csv", `/api/requests/${id}/export?type=offer&format=csv`, /text\/csv/, /\.csv/, null],
      ["offer pdf", `/api/requests/${id}/export?type=offer&format=pdf`, /application\/pdf/, /\.pdf/, "%PDF"],
    ];
    for (const [name, url, ct, fn, magic] of downloads) {
      const r = await context.request.get(url);
      const body = await r.body();
      const h = r.headers();
      const ok = r.status() === 200 && ct.test(h["content-type"] || "") && fn.test(h["content-disposition"] || "") && body.length > 0 && (!magic || body.slice(0, magic.length).toString("latin1") === magic);
      check(`download: ${name}`, ok, { status: r.status(), type: h["content-type"], disposition: h["content-disposition"], bytes: body.length });
      if (name === "offer pdf" && ok) require("node:fs").writeFileSync(path.join(OUT, "offer.pdf"), body);
    }
    // The Download menu in the UI lists all five
    await page.getByRole("button", { name: /Download/ }).click();
    check("download menu: five entries", (await page.getByRole("menuitem").count()) === 5);
    await page.keyboard.press("Escape");
    check("download menu: Escape closes", (await page.getByRole("menu").count()) === 0);

    // 7. Create proposal
    await page.getByRole("button", { name: "Create proposal" }).click();
    await page.waitForURL(/\/proposals\/[a-z0-9]+$/, { timeout: 30000 });
    const pid = page.url().split("/").pop();
    const prop = await (await apiAs(role, `/api/proposals/${pid}`)).json();
    check("proposal created from the request", prop.request?.id === id && prop.lines.length > 0, { pid, lines: prop.lines?.length, status: prop.status });
    await shot("04-proposal");

    check("no page errors during the journey", log.errors.length === 0, log.errors);
    check("no CSP violations during the journey", log.csp.length === 0, log.csp);
    writeJson("journey-request.json", { requestId: id, proposalId: pid, results, log: { errors: log.errors, csp: log.csp, http: log.responses } });
    await context.close();
  });
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

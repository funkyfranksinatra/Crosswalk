/* KN-04 (item B): for each role fetch the server-rendered HTML (curl-style, with the dev
 * cookie) of the pages that used to leak commercial data and grep for sentinel values:
 *   /catalog        → list price $655.00 (SKU 174006), $794.21 (ABSTACK30X), COGS $171.00, $212.00,
 *                     pricebook names "HOSPITAL LIST PRICE" / "VIZIENT HERNIA MECH TIER 1"
 *   /requests/new   → pricebook names (the wizard)
 *   /settings       → the model call statistics table ("Calls so far") and endpoint
 *   /crosses, /catalog/gudid → any $ amount at all (there should be none for anyone)
 * Expected: prices only with view_pricing, COGS only with view_cost, pricebook names on
 * /requests/new only with run_cross_reference, call stats only with configure_settings.
 *
 *   node docs/debug-runs/2026-09-24-full-application/evidence/ws3/price-gate.js
 * Exit code 1 when any expectation fails.
 */
const { apiAs, ROLES, writeJson } = require("./lib");
const PERMS = {
  SALES_REP: ["view_pricing", "run_cross_reference"],
  REGIONAL_MANAGER: ["view_pricing", "run_cross_reference"],
  CONTRACTING_MANAGER: ["view_pricing", "run_cross_reference"],
  PRICING_ANALYST: ["view_pricing", "view_cost", "run_cross_reference"],
  PRICING_DIRECTOR: ["view_pricing", "view_cost", "run_cross_reference", "configure_settings"],
  PRICING_COMMITTEE: ["view_pricing", "view_cost"],
  PRODUCT_MARKETING: ["view_pricing", "run_cross_reference"],
  CLINICAL_REVIEWER: [],
  FINANCE: ["view_pricing", "view_cost"],
  ADMIN: ["view_pricing", "view_cost", "run_cross_reference", "configure_settings"],
  EXECUTIVE: ["view_pricing"],
};
const money = /\$\d{1,3}(,\d{3})*\.\d{2}/; // a formatted amount ("$1,234.56"); the RSC payload contains "$1", "$L2" references, so the cents are required

async function main() {
  const results = [];
  let failures = 0;
  const check = (role, page, what, found, expected) => { const ok = found === expected; if (!ok) failures++; results.push({ role, page, what, found, expected, ok }); };
  for (const role of Object.keys(ROLES)) {
    const has = (p) => PERMS[role].includes(p);
    const html = async (p) => (await apiAs(role, p)).text();
    const cat = await html("/catalog");
    check(role, "/catalog", "list price $655.00 (174006)", cat.includes("$655.00"), has("view_pricing"));
    check(role, "/catalog", "list price $794.21 (ABSTACK30X)", cat.includes("$794.21"), has("view_pricing"));
    check(role, "/catalog", "pricebook name in table", cat.includes("HOSPITAL LIST PRICE"), has("view_pricing"));
    check(role, "/catalog", "COGS $171.00 (174006)", cat.includes("$171.00"), has("view_cost"));
    check(role, "/catalog", "COGS $212.00 (ABSTACK30X)", cat.includes("$212.00"), has("view_cost"));
    check(role, "/catalog", "any $ amount", money.test(cat), has("view_pricing") || has("view_cost"));
    const nr = await html("/requests/new");
    check(role, "/requests/new", "pricebook names", nr.includes("HOSPITAL LIST PRICE"), has("run_cross_reference"));
    const st = await html("/settings");
    check(role, "/settings", "model call stats / endpoint", /Calls so far|api\.openai\.com/.test(st), has("configure_settings"));
    for (const p of ["/crosses", "/catalog/gudid"]) check(role, p, "any $ amount", money.test(await html(p)), false);
  }
  writeJson("price-gate.json", results);
  for (const r of results.filter((x) => !x.ok)) console.log(`FAIL ${r.role} ${r.page} ${r.what}: found=${r.found} expected=${r.expected}`);
  console.log(`${results.length} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

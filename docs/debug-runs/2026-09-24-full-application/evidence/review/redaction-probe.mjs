// Reviewer redaction probe: SALES_REP vs ADMIN through real HTTP on :3103 (GETs only).
import ExcelJS from "exceljs";
import fs from "node:fs";
const B = process.env.BASE ?? "http://127.0.0.1:3103";
const USERS = { REP: "cmuffqhm90000fs7df146esql", ADMIN: "cmuffqhoe0009fs7dn94dgcxu", DIRECTOR: "cmuffqhns0004fs7d7eaxlhrk" };
const REQ1 = "cmufg50yo000ufc7ddlfgrbk0";
const PRP = "cmufg8d13004hfc7dwquv6omt"; // PRP-0001-v3 DRAFT owned by REP
const PRP_WON = "cmufg5emu002dfc7dynkg6kgp";
const COGS = process.argv[2].split(/\s+/).filter(Boolean).map((s) => Number(s));
const cookies = {}; const out = []; let pass = 0, fail = 0;
const log = (s) => { out.push(s); console.log(s); };
const check = (l, ok, d) => { ok ? pass++ : fail++; log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? `  -- ${d}` : ""}`); };
async function signin(n) { const r = await fetch(`${B}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: USERS[n] }) }); cookies[n] = `crosswalk_dev_user=${(r.headers.get("set-cookie") ?? "").match(/crosswalk_dev_user=([^;]+)/)[1]}`; }
async function get(who, path) { const r = await fetch(`${B}${path}`, { headers: { cookie: cookies[who] } }); const ct = r.headers.get("content-type") ?? ""; if (/json/.test(ct)) return { status: r.status, data: await r.json() }; return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; }
const MARGIN_RE = /margin[^0-9]{0,12}-?\d+(\.\d+)?\s*%|-?\d+(\.\d+)?\s*%[^0-9]{0,12}margin/i;
function numbersIn(s) { return (s.match(/-?\d+(\.\d+)?/g) ?? []).map(Number); }
function leakReport(label, text) {
  const s = typeof text === "string" ? text : JSON.stringify(text);
  const margin = s.match(MARGIN_RE);
  const cogsHits = COGS.filter((c) => numbersIn(s).some((n) => n === c));
  const keyHits = (s.match(/"(cogs|grossProfit|marginPct|blendedMarginPct|floorPrice|scoreMargin|unitCost|costOfGoods)":\s*(?!null)[^,}]+/g) ?? []).slice(0, 5);
  return { margin: margin?.[0] ?? null, cogsHits, keyHits };
}
async function xlsxText(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const cells = [];
  wb.eachSheet((ws) => ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => { const v = c.value; cells.push({ sheet: ws.name, addr: c.address, v: typeof v === "object" && v !== null ? (v.richText ? v.richText.map((t) => t.text).join("") : v.result ?? v.text ?? JSON.stringify(v)) : v }); })));
  return cells;
}
async function main() {
  for (const n of Object.keys(USERS)) await signin(n);
  log(`# reviewer redaction probe ${new Date().toISOString()} COGS set: ${COGS.join(",")}`);
  const paths = [`/api/requests/${REQ1}`, `/api/requests/${REQ1}/compare`, `/api/proposals/${PRP}`, `/api/proposals/${PRP}/scenarios`, `/api/proposals/${PRP}/audit`, `/api/proposals/${PRP}/drift`, `/api/proposals/${PRP_WON}`, `/api/proposals`, `/api/approvals`, `/api/accounts/cmufg5elt002cfc7dhn2zn9l8`, `/api/catalog`, `/api/analytics/pricing`];
  for (const p of paths) {
    const rep = await get("REP", p); const adm = await get("ADMIN", p);
    const rl = rep.data !== undefined ? leakReport(p, rep.data) : { margin: null, cogsHits: [], keyHits: [] };
    const al = adm.data !== undefined ? leakReport(p, adm.data) : { margin: null, cogsHits: [], keyHits: [] };
    check(`REP ${p} ${rep.status}: no margin figure / COGS value / cost keys`, rep.status !== 200 || (!rl.margin && !rl.cogsHits.length && !rl.keyHits.length), `${JSON.stringify(rl).slice(0, 300)}`);
    log(`      ADMIN ${p} ${adm.status}: margin=${al.margin} cogsHits=${al.cogsHits.join(",")} keys=${al.keyHits.length}`);
  }
  // xlsx exports
  for (const q of ["type=xref&format=xlsx", "type=offer&format=xlsx"]) {
    const rep = await get("REP", `/api/requests/${REQ1}/export?${q}`);
    check(`REP export ${q} -> 200 xlsx`, rep.status === 200 && rep.buf, `${rep.status}`);
    if (rep.buf) {
      const cells = await xlsxText(rep.buf);
      const marginCells = cells.filter((c) => typeof c.v === "string" && MARGIN_RE.test(c.v));
      const cogsCells = cells.filter((c) => (typeof c.v === "number" && COGS.includes(c.v)) || (typeof c.v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(c.v) && COGS.includes(Number(c.v))));
      const costHeaders = cells.filter((c) => typeof c.v === "string" && /\b(cogs|cost|margin|floor)\b/i.test(c.v) && c.v.length < 60);
      check(`  xlsx (${q}) has no 'margin N%' cell`, marginCells.length === 0, JSON.stringify(marginCells.slice(0, 3)));
      check(`  xlsx (${q}) has no cell equal to a COGS value`, cogsCells.length === 0, JSON.stringify(cogsCells.slice(0, 5)));
      log(`      sheets=${[...new Set(cells.map((c) => c.sheet))].join("|")} cells=${cells.length} cost/margin-ish headers=${JSON.stringify(costHeaders.map((c) => c.v).slice(0, 8))}`);
      fs.writeFileSync(new URL(`./rep-${q.replace(/[^a-z]/g, "")}.xlsx`, import.meta.url), rep.buf);
    }
    const adm = await get("ADMIN", `/api/requests/${REQ1}/export?${q}`);
    if (adm.buf) { const cells = await xlsxText(adm.buf); const cogsCells = cells.filter((c) => typeof c.v === "number" && COGS.includes(c.v)); const marginCells = cells.filter((c) => typeof c.v === "string" && MARGIN_RE.test(c.v)); log(`      ADMIN xlsx (${q}): COGS cells=${cogsCells.length} margin cells=${marginCells.length} e.g. ${JSON.stringify(cogsCells.slice(0, 2))} ${JSON.stringify(marginCells.slice(0, 1))}`); }
    const csv = await get("REP", `/api/requests/${REQ1}/export?${q.replace("xlsx", "csv")}`);
    if (csv.buf) { const s = csv.buf.toString("utf8"); check(`  csv (${q.replace("xlsx", "csv")}) no margin figure / COGS`, !MARGIN_RE.test(s) && !COGS.some((c) => s.split(/[,\n]/).some((f) => Number(f.replace(/"/g, "")) === c && f.trim() !== "")), s.match(MARGIN_RE)?.[0] ?? ""); }
  }
  // proposal quote exports for the rep (may be refused by state)
  for (const q of ["format=xlsx", "format=csv", "format=pdf"]) { const r = await get("REP", `/api/proposals/${PRP_WON}/export?${q}`); log(`      REP proposal export ${q}: ${r.status} ${r.data ? JSON.stringify(r.data).slice(0, 120) : `${r.buf.length} bytes`}`); if (r.buf && q !== "format=pdf") { const s = q === "format=csv" ? r.buf.toString() : (await xlsxText(r.buf)).map((c) => String(c.v)).join("\n"); check(`  quote ${q}: no margin/COGS`, !MARGIN_RE.test(s) && !COGS.some((c) => s.split(/\n|,/).some((f) => Number(f) === c)), ""); } }
  log(`\n# ${pass} passed, ${fail} failed`);
  fs.writeFileSync(new URL("./redaction-probe.txt", import.meta.url), out.join("\n") + "\n");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

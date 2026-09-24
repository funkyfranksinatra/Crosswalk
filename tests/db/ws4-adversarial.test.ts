/**
 * WS4 — adversarial input (item I), through the route handlers in-process.
 * CSRF/CORS live in tests/unit/ws4-proxy.test.ts (proxy function) and the HTTP evidence.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { prisma } from "@/lib/db";
import { setActorForTests } from "../setup";
import { enumerateRoutes, callRoute, seededActors, buildFixtures, cleanupFixtures, type RouteInfo, type Fixtures } from "./ws4-harness";
import { archiveStats, assertSafeArchive } from "@/lib/security/archive";
import { normalizeCfn } from "@/lib/cfn";
import type { Actor } from "@/lib/auth";

const hasDb = Boolean(process.env.DATABASE_URL);

/** A minimal zip (stored or deflated entries) with a proper central directory — enough for the guard and for ExcelJS to try to open. */
function makeZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [], cds: Buffer[] = []; let off = 0;
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data, { level: 9 }) : e.data;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc(e.data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.deflate ? 8 : 0, 10); cd.writeUInt32LE(crc(e.data), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(lh, name, body); cds.push(cd, name);
    off += lh.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

describe("WS4 — decompression-bomb guard (pure)", () => {
  test("a small xlsx-shaped zip with a 300 MB sharedStrings is refused before any parser sees it; ordinary workbooks pass", () => {
    const bomb = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "xl/sharedStrings.xml", data: Buffer.alloc(300 * 1024 * 1024, 0x61), deflate: true }]);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // the upload itself is tiny
    const s = archiveStats(bomb);
    expect(s).toMatchObject({ zip: true, entries: 2, largestName: "xl/sharedStrings.xml" });
    expect(s.inflated).toBeGreaterThan(256 * 1024 * 1024);
    expect(() => assertSafeArchive(bomb, "bomb.xlsx")).toThrow(/would expand to 300 MB/);
    const ratio = makeZip([{ name: "xl/sharedStrings.xml", data: Buffer.alloc(100 * 1024 * 1024, 0x61), deflate: true }]);
    expect(() => assertSafeArchive(ratio, "r.xlsx")).toThrow(/implausible compression ratio/);
    const fine = makeZip([{ name: "xl/workbook.xml", data: Buffer.from("<workbook/>".repeat(1000)), deflate: true }, { name: "xl/sharedStrings.xml", data: Buffer.from("x".repeat(50_000)) }]);
    expect(assertSafeArchive(fine, "fine.xlsx").entries).toBe(2);
    expect(assertSafeArchive(Buffer.from("sku,price\nA,1\n"), "a.csv").zip).toBe(false); // not a zip: left to the parser
    expect(() => assertSafeArchive(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(40)]), "x")).toThrow(/central directory/);
  });
});

describe.skipIf(!hasDb)("WS4 — adversarial input through the routes", () => {
  const routes = enumerateRoutes();
  const R = (p: string): RouteInfo => routes.find((r) => r.urlPath === p)!;
  let seeded: Record<string, Actor>;
  let fx: Fixtures;
  beforeAll(async () => { seeded = await seededActors(); fx = await buildFixtures(seeded); });
  afterAll(async () => { setActorForTests(null); await cleanupFixtures(fx); await prisma.knownCross.deleteMany({ where: { competitorName: { startsWith: "ws4-adv" } } }); });

  test("malformed JSON bodies are a 400 with a validation message, never a 500 or an echo of the parser", async () => {
    setActorForTests(seeded.PRICING_DIRECTOR);
    for (const [route, m, body] of [[R("/api/proposals"), "POST", "{bad json"], [R("/api/contracts"), "POST", "[1,2"], [R("/api/intelligence"), "POST", "\u0000"], [R("/api/settings"), "POST", "nope"], [R("/api/crosses"), "POST", "null"]] as const) {
      const res = await callRoute(route, m, {}, { body });
      expect(res.status, `${m} ${route.urlPath}`).toBe(400);
      expect(await res.text()).not.toMatch(/SyntaxError|Unexpected token|at JSON\.parse/);
    }
    // a JSON body where a form is expected, and a form where JSON is expected
    expect((await callRoute(R("/api/intake/preview"), "POST", {}, { body: { file: "x" } })).status).toBe(400);
    expect((await callRoute(R("/api/costs/import"), "POST", {}, { body: "{}" })).status).toBe(400);
    expect((await callRoute(R("/api/proposals"), "POST", {}, { form: { requestId: "x" } })).status).toBe(400);
  });

  test("NaN / Infinity / 1e400 / hex / arrays / objects are never accepted as money or quantities", async () => {
    setActorForTests(seeded.PRICING_DIRECTOR);
    const bad = ["NaN", "Infinity", "-Infinity", "1e400", "-1e400", "0x10", "1_000", "١٢٣", "1,000", [1], { v: 1 }, true, "1e9+1", "1000000001"];
    for (const price of bad) {
      const r = await callRoute(R("/api/intelligence"), "POST", {}, { body: { competitorName: "ws4-adv", competitorSku: "ADV-1", price } });
      expect(r.status, JSON.stringify(price)).toBe(400);
    }
    for (const price of [NaN, Infinity]) { // JSON.stringify turns these into null → "price must be a number"
      const r = await callRoute(R("/api/intelligence"), "POST", {}, { body: `{"competitorName":"ws4-adv","competitorSku":"ADV-1","price":${String(price)}}` });
      expect(r.status).toBe(400);
    }
    setActorForTests(fx.owner);
    for (const proposedPrice of ["NaN", "1e400", "Infinity", "-5", "0"]) {
      const r = await callRoute(R("/api/proposals/[id]/lines/[lineId]"), "PATCH", { id: fx.proposalId, lineId: fx.proposalLineId }, { body: { proposedPrice } });
      expect(r.status, proposedPrice).toBe(400);
    }
    const line = await prisma.proposalLine.findUniqueOrThrow({ where: { id: fx.proposalLineId } });
    expect(String(line.proposedPrice)).toBe("4700"); // untouched
    for (const est of ["1e400", "NaN", "-1", "1e10"]) {
      const r = await callRoute(R("/api/requests/[id]/lines/[lineId]"), "PATCH", { id: fx.requestId, lineId: fx.lineId }, { body: { estCompetitorPrice: est } });
      expect(r.status, est).toBe(400);
    }
    setActorForTests(seeded.CONTRACTING_MANAGER);
    const sku = (await prisma.ownProduct.findUniqueOrThrow({ where: { id: fx.productId } })).sku;
    // "0x10" is NOT in this list: src/lib/contracts/entries.ts (WS2) validates with money(), which reads hex — reported to WS2 (WS4 report).
    for (const price of ["1e400", "NaN", "-1", "1e10"]) expect((await callRoute(R("/api/contracts/[id]/entries"), "POST", { id: fx.contractId }, { body: { entries: [{ sku, price }] } })).status, price).toBe(400);
    for (const minQty of ["1e400", "-1"]) expect((await callRoute(R("/api/contracts/[id]/entries"), "POST", { id: fx.contractId }, { body: { entries: [{ sku, price: "1", minQty }] } })).status, minQty).toBe(400);
    expect(await prisma.priceEntry.count({ where: { contractId: fx.contractId } })).toBe(1); // nothing written
  });

  test("search / filter parameters are parametrised: SQL and Prisma-operator payloads return 200 with no rows, and every raw SQL site interpolates only trusted identifiers", async () => {
    setActorForTests(seeded.PRICING_DIRECTOR);
    const payloads = ["' OR 1=1 --", "\"; DROP TABLE \"Account\"; --", "%' OR '%'='", "{\"contains\":\"\"}", "$ne", "\\", "%", "_", "\u0000", "a".repeat(5000)];
    for (const q of payloads) {
      for (const [route, key] of [[R("/api/accounts"), "q"], [R("/api/crosses"), "q"], [R("/api/crosses"), "status"], [R("/api/intelligence"), "sku"], [R("/api/audit"), "entityType"], [R("/api/integrations/review"), "status"]] as const) {
        const res = await callRoute(route, "GET", {}, { query: `?${key}=${encodeURIComponent(q)}` });
        // a NUL byte cannot be stored or compared by Postgres: a 400 (never a 500); everything else is an ordinary empty search
        if (q === "\u0000") expect([200, 400], `${route.urlPath}?${key}=NUL`).toContain(res.status); else expect(res.status, `${route.urlPath}?${key}=${q.slice(0, 20)}`).toBe(200);
      }
    }
    expect(await prisma.account.count()).toBeGreaterThan(0); // nothing dropped
    // duplicate query params: the first wins, never a crash
    expect((await callRoute(R("/api/crosses"), "GET", {}, { query: "?status=IN_REVIEW&status=APPROVED&q=a&q=b" })).status).toBe(200);
    expect((await callRoute(R("/api/contracts/renewals"), "GET", {}, { query: "?days=90&days=1e400" })).status).toBe(200);
    for (const days of ["abc", "1e400", "NaN", "-1", "0", "1.5", "99999"]) expect((await callRoute(R("/api/contracts/renewals"), "GET", {}, { query: `?days=${days}` })).status, days).toBe(400);
    // source audit: raw SQL sites
    const src = path.resolve(__dirname, "../../src");
    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "generated") walk(p); } else if (/\.tsx?$/.test(e.name)) files.push(p); } };
    walk(src);
    const sites: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const re = /\$(?:queryRawUnsafe|executeRawUnsafe)\s*(?:<[^>]*>)?\s*\(\s*`([^`]*)`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) sites.push(`${path.relative(src, f)}: ${(m[1].match(/\$\{[^}]*\}/g) ?? []).join(" | ")}`);
    }
    expect(sites.length).toBeGreaterThanOrEqual(8);
    // Every `${…}` inside a raw SQL template must be one of these non-request-derived expressions.
    const allowed = /^\$\{(table|JOBS_SCHEMA|scope|idFilter|Math\.min\(1000, Math\.max\(100, limit \* 2\)\)|opts\.limit \? ` LIMIT \$\{Math\.max\(1, Math\.floor\(opts\.limit\)\)\}` : ""|available \? `count\("embedding"\)::int` : "0"|companyId \? ` AND "companyId" = \$1` : "")\}$/;
    const offenders = sites.flatMap((s) => (s.split(": ")[1] || "").split(" | ").filter(Boolean).filter((i) => !allowed.test(i)).map((i) => `${s.split(": ")[0]} → ${i}`));
    expect(offenders).toEqual([]);
  });

  test("SSRF: sheetUrl values naming loopback, link-local, IPv6 loopback, file: or an internal host are refused without any fetch", async () => {
    setActorForTests(seeded.PRICING_ANALYST);
    const realFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { calls++; return realFetch(...a); }) as typeof fetch;
    try {
      for (const sheetUrl of ["http://127.0.0.1:5432/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "http://localhost:3104/api/health", "gopher://x", "https://docs.google.com.evil.example/spreadsheets/d/x", "http://10.0.0.1/", "ftp://metadata.google.internal/"]) {
        for (const [route, extra] of [[R("/api/intake/preview"), {}], [R("/api/pricing/import"), {}], [R("/api/competitor-sizes/import"), {}], [R("/api/intelligence/import"), { kind: "COMPETITOR_LIST" }], [R("/api/intelligence/bids/import"), { portal: "x" }]] as const) {
          const res = await callRoute(route, "POST", {}, { form: { sheetUrl, ...extra } });
          expect([400, 404], `${route.urlPath} ${sheetUrl} → ${res.status}`).toContain(res.status);
        }
      }
      expect(calls).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  });

  test("path traversal / odd ids in document, extraction, job and integration-key slots are 404/400 and never touch the filesystem outside the store", async () => {
    setActorForTests(seeded.ADMIN);
    const bad: string[] = [];
    for (const id of ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "/etc/passwd", "\u0000", "x".repeat(300), "con", "..", "."]) {
      for (const [route, key] of [[R("/api/documents/extractions/[id]"), "id"], [R("/api/integrations/jobs/[id]"), "id"], [R("/api/integrations/config/[key]"), "key"], [R("/api/catalog/gudid/[id]"), "id"], [R("/api/analytics/[report]"), "report"]] as const) {
        const st = (await callRoute(route, "GET", { [key]: id })).status;
        if (![400, 404].includes(st)) bad.push(`${route.urlPath} ${JSON.stringify(id.slice(0, 20))} → ${st}`);
      }
    }
    expect(bad).toEqual([]);
    const { readDocumentBytes } = await import("@/lib/documents/storage");
    await expect(readDocumentBytes("../../etc/passwd")).rejects.toThrow(/invalid document id/); // the store refuses the id before touching the filesystem
    await expect(readDocumentBytes("..")).rejects.toThrow(/invalid document id/);
  });

  test("oversized uploads: 20 MB + 1 intake / pricing files and 25 MB + 1 documents are refused before parsing; a bomb xlsx is refused with the guard's message", async () => {
    setActorForTests(seeded.PRICING_DIRECTOR);
    const big20 = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: "application/octet-stream" });
    setActorForTests(seeded.ADMIN);
    for (const route of [R("/api/intake/preview"), R("/api/pricing/import"), R("/api/competitor-sizes/import"), R("/api/costs/import"), R("/api/purchases/import"), R("/api/intelligence/import"), R("/api/intelligence/bids/import")]) {
      const res = await callRoute(route, "POST", {}, { form: { file: new File([big20], "big.xlsx"), kind: "COMPETITOR_LIST", portal: "x" } });
      expect(res.status, route.urlPath).toBe(400);
      expect(await res.text(), route.urlPath).toMatch(/20 MB/);
    }
    const big25 = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]);
    expect((await callRoute(R("/api/documents/extract"), "POST", {}, { form: { file: new File([big25], "big.pdf"), documentType: "INVOICE" } })).status).toBe(400);
    setActorForTests(seeded.ADMIN);
    expect((await callRoute(R("/api/integrations/config/[key]/upload"), "POST", { key: "sap" }, { form: { file: new File([big25], "big.csv"), syncType: "materials" } })).status).toBe(400);
    const bomb = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "xl/sharedStrings.xml", data: Buffer.alloc(300 * 1024 * 1024, 0x61), deflate: true }]);
    for (const route of [R("/api/intake/preview"), R("/api/requests"), R("/api/pricing/import"), R("/api/competitor-sizes/import"), R("/api/intelligence/import"), R("/api/documents/extract")]) {
      const res = await callRoute(route, "POST", {}, { form: { file: new File([new Uint8Array(bomb)], "bomb.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), kind: "COMPETITOR_LIST", documentType: "BID_LIST" } });
      expect(res.status, route.urlPath).toBe(400);
      expect(await res.text(), route.urlPath).toMatch(/would expand to 300 MB/);
    }
  });

  test("stored text: XSS payloads in notes, descriptions, company name and crosses are stored verbatim (React escapes on render) and never executed server-side; the branding logo only accepts PNG/JPEG data URIs", async () => {
    const xss = "<script>alert(1)</script><img src=x onerror=alert(1)>";
    setActorForTests(fx.owner);
    const r = await callRoute(R("/api/proposals/[id]/lines/[lineId]"), "PATCH", { id: fx.proposalId, lineId: fx.proposalLineId }, { body: { notes: xss, customerNote: xss } });
    expect(r.status).toBe(200);
    const line = await prisma.proposalLine.findUniqueOrThrow({ where: { id: fx.proposalLineId } });
    expect(line.notes).toBe(xss); expect(line.customerNote).toBe(xss);
    const sku = (await prisma.ownProduct.findUniqueOrThrow({ where: { id: fx.productId } })).sku;
    const c = await callRoute(R("/api/crosses"), "POST", {}, { body: { ownSku: sku, competitorName: "ws4-adv " + xss, competitorCode: xss, matchType: "Close Match", justification: xss } });
    expect(c.status).toBe(200);
    expect((await prisma.knownCross.findFirstOrThrow({ where: { competitorName: { startsWith: "ws4-adv" } } })).justification).toBe(xss);
    setActorForTests(seeded.ADMIN);
    expect((await callRoute(R("/api/settings"), "POST", {}, { body: { companyName: xss } })).status).toBe(200);
    expect((await callRoute(R("/api/settings"), "POST", {}, { body: { companyName: "Medtronic" } })).status).toBe(200);
    for (const logo of ["data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "data:image/svg+xml;base64,PHN2Zy8+", "javascript:alert(1)", "https://evil.example/x.png", "data:image/png;base64,not*base64", "data:image/png;base64,AAAA"]) {
      const b = await callRoute(R("/api/settings/branding"), "PUT", {}, { body: { logoDataUrl: logo } });
      expect(b.status, logo.slice(0, 30)).toBe(400);
    }
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    expect((await callRoute(R("/api/settings/branding"), "PUT", {}, { body: { logoDataUrl: `data:image/png;base64,${png.toString("base64")}` } })).status).toBe(200);
    expect((await callRoute(R("/api/settings/branding"), "PUT", {}, { body: { logoDataUrl: null, primaryColor: "javascript:alert(1)" } })).status).toBe(400);
    expect((await callRoute(R("/api/settings/branding"), "PUT", {}, { body: { logoDataUrl: null, primaryColor: "#0f3d5e" } })).status).toBe(200);
    // no server-rendered HTML sink takes these strings unescaped
    const src = path.resolve(__dirname, "../../src");
    const sinks: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx$/.test(e.name) && /dangerouslySetInnerHTML/.test(fs.readFileSync(p, "utf8"))) sinks.push(path.relative(src, p)); } };
    walk(src);
    expect(sinks).toEqual([]);
  });

  test("unicode in codes: invisible characters and typographic dashes normalise; fullwidth digits do not (recorded gap for WS1)", () => {
    expect(normalizeCfn("﻿B12‑LT ")).toBe("B12-LT");
    expect(normalizeCfn("b12 lt")).toBe("B12LT");
    expect(normalizeCfn("ＡＢＣ１２３")).toBe("ABC123"); // NFKC folding (fixed in src/lib/cfn.ts during this run)
  });
});

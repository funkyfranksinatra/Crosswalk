/**
 * Public bid intelligence (Tier 3.10). Awards and bid records from public sources become
 * PublicAward rows (who won what, where, for how much) and — when a record carries a
 * competitor code and a unit price — CompetitorPriceObservation rows with the PUBLIC_BID_DB
 * source type, so they flow into the same price summaries reps already see.
 *
 * Sources:
 *   sam          SAM.gov Contract Opportunities API v2, award notices (needs SAM_API_KEY; the
 *                public key is rate-limited to a handful of calls a day, so one call per NAICS)
 *   usaspending  USAspending.gov award search (no key; contracts by NAICS / PSC / keywords)
 *   bid file     a CSV / XLSX drop (state and hospital-system portals are HTML; the rep saves
 *                the tabulation as a sheet and imports it — no scraping)
 *
 * Every pull is a FeedRun (feed `bids-<source>`) so Settings → System shows it like the
 * other feeds. Fetch is injectable for tests; nothing here ever calls the network under test.
 */
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { toDb, money } from "@/lib/money";
import { normalizeCfn, isPlaceholderSku } from "@/lib/cfn";
import { recordObservation } from "./index";

export const BID_SOURCES = ["sam", "usaspending"] as const;
export type BidSource = (typeof BID_SOURCES)[number];

export type BidSettings = { keywords: string[]; naics: string[]; psc: string[]; lookbackDays: number; minAmount: number };
export const DEFAULT_BID_SETTINGS: BidSettings = {
  keywords: ["surgical stapler", "trocar", "hernia mesh", "laparoscopic", "endomechanical", "vessel sealing", "suture"],
  naics: ["339112", "339113"], // surgical & medical instrument manufacturing; surgical appliance & supplies
  psc: ["6515"], // medical and surgical instruments, equipment and supplies
  lookbackDays: 30,
  minAmount: 0,
};

export async function bidSettings(): Promise<BidSettings> {
  const row = await prisma.setting.findUnique({ where: { key: "bidIntel" } });
  if (!row) return DEFAULT_BID_SETTINGS;
  try { return sanitizeBidSettings(JSON.parse(row.value)); } catch { return DEFAULT_BID_SETTINGS; }
}

export function sanitizeBidSettings(input: unknown): BidSettings {
  const o = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof BidSettings, unknown>>;
  const list = (v: unknown, max: number, re: RegExp) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n;]+/) : []).map((x) => String(x).trim()).filter((x) => x && re.test(x)).slice(0, max);
  return {
    keywords: list(o.keywords ?? DEFAULT_BID_SETTINGS.keywords, 25, /^[\w .'&/-]{2,60}$/),
    naics: list(o.naics ?? DEFAULT_BID_SETTINGS.naics, 8, /^\d{2,6}$/),
    psc: list(o.psc ?? DEFAULT_BID_SETTINGS.psc, 8, /^[A-Z0-9]{1,4}$/i).map((x) => x.toUpperCase()),
    lookbackDays: Math.max(1, Math.min(365, Number(o.lookbackDays ?? DEFAULT_BID_SETTINGS.lookbackDays) || 30)),
    minAmount: Math.max(0, Number(o.minAmount ?? 0) || 0),
  };
}

export async function saveBidSettings(input: unknown): Promise<BidSettings> {
  const s = sanitizeBidSettings(input);
  await prisma.setting.upsert({ where: { key: "bidIntel" }, create: { key: "bidIntel", value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } });
  return s;
}

/** Which sources can run here: USAspending needs nothing; SAM.gov needs a key. */
export async function bidSourcesConfigured(): Promise<BidSource[]> {
  const out: BidSource[] = [];
  if (process.env.SAM_API_KEY?.trim()) out.push("sam");
  if ((process.env.BIDS_USASPENDING ?? "on").toLowerCase() !== "off") out.push("usaspending");
  return out;
}

// ---------------------------------------------------------------------------
// HTTP (injectable)
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike | null = null;
export function setBidFetchForTests(fn: FetchLike | null) { fetchImpl = fn; }
const doFetch: FetchLike = (url, init) => (fetchImpl ?? fetch)(url, init);

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await doFetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(Number(process.env.BIDS_TIMEOUT_MS ?? 45_000)) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON response (${text.slice(0, 80)})`); }
}

// ---------------------------------------------------------------------------
// Normalised award record
// ---------------------------------------------------------------------------

export type AwardRecord = {
  source: "SAM" | "USASPENDING" | "BIDFILE";
  externalId: string;
  title: string | null;
  agency: string | null;
  awardee: string | null;
  awardeeId: string | null;
  naics: string | null;
  psc: string | null;
  amount: unknown;
  currency?: string;
  awardDate: Date | null;
  postedDate: Date | null;
  description: string | null;
  url: string | null;
  raw: unknown;
  /** Optional line-level price the record carries (bid files). */
  lines?: { competitorName: string; competitorCode: string; unitPrice: unknown; quantity?: unknown; uom?: string }[];
};

const mmddyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dateOrNull = (v: unknown) => { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };

/** SAM.gov award notices for each configured NAICS code in the window (one request per code, up to 3 pages). */
export async function pullSam(settings: BidSettings, opts: { from: Date; to: Date }): Promise<AwardRecord[]> {
  const key = process.env.SAM_API_KEY?.trim();
  if (!key) throw new Error("SAM_API_KEY is not set");
  const base = process.env.SAM_API_URL?.trim() || "https://api.sam.gov/opportunities/v2/search";
  const out: AwardRecord[] = [];
  const codes = settings.naics.length ? settings.naics : [""];
  for (const ncode of codes) {
    for (let offset = 0, page = 0; page < 3; page++, offset += 1000) {
      const params = new URLSearchParams({ api_key: key, postedFrom: mmddyyyy(opts.from), postedTo: mmddyyyy(opts.to), ptype: "a", limit: "1000", offset: String(offset) });
      if (ncode) params.set("ncode", ncode);
      const data = (await getJson(`${base}?${params}`)) as { totalRecords?: number; opportunitiesData?: Record<string, unknown>[] };
      const items = data.opportunitiesData ?? [];
      for (const it of items) {
        const award = (it.award ?? {}) as { date?: string; number?: string; amount?: string | number; awardee?: { name?: string; ueiSAM?: string } };
        out.push({
          source: "SAM", externalId: String(it.noticeId ?? award.number ?? createHash("sha1").update(JSON.stringify(it)).digest("hex")),
          title: (it.title as string) ?? null, agency: (it.fullParentPathName as string) ?? null,
          awardee: award.awardee?.name ?? null, awardeeId: award.awardee?.ueiSAM ?? null,
          naics: (it.naicsCode as string) ?? null, psc: (it.classificationCode as string) ?? null,
          amount: award.amount ?? null, awardDate: dateOrNull(award.date), postedDate: dateOrNull(it.postedDate),
          description: (it.solicitationNumber ? `Solicitation ${it.solicitationNumber}` : null), url: (it.uiLink as string) ?? null, raw: it,
        });
      }
      if (items.length < 1000 || (data.totalRecords ?? 0) <= offset + items.length) break;
    }
  }
  return out;
}

/** USAspending contract awards by NAICS / PSC / keywords in the window (paged, up to 10 pages). */
export async function pullUsaspending(settings: BidSettings, opts: { from: Date; to: Date }): Promise<AwardRecord[]> {
  const base = process.env.USASPENDING_API_URL?.trim() || "https://api.usaspending.gov/api/v2/search/spending_by_award/";
  const out: AwardRecord[] = [];
  const filters: Record<string, unknown> = {
    time_period: [{ start_date: iso(opts.from), end_date: iso(opts.to) }],
    award_type_codes: ["A", "B", "C", "D"], // contracts: BPA call, purchase order, delivery order, definitive contract
    ...(settings.naics.length ? { naics_codes: { require: settings.naics } } : {}),
    ...(settings.psc.length ? { psc_codes: { require: settings.psc.map((p) => [p]) } } : {}),
    ...(settings.keywords.length && !settings.naics.length && !settings.psc.length ? { keywords: settings.keywords } : {}),
  };
  const fields = ["Award ID", "Recipient Name", "Award Amount", "Start Date", "End Date", "Awarding Agency", "Awarding Sub Agency", "Description", "NAICS", "PSC", "generated_internal_id", "recipient_id"];
  for (let page = 1; page <= 10; page++) {
    const data = (await getJson(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filters, fields, page, limit: 100, sort: "Award Amount", order: "desc", subawards: false }) })) as { results?: Record<string, unknown>[]; page_metadata?: { hasNext?: boolean } };
    for (const r of data.results ?? []) {
      const gid = String(r.generated_internal_id ?? r.internal_id ?? "");
      out.push({
        source: "USASPENDING", externalId: gid || String(r["Award ID"] ?? createHash("sha1").update(JSON.stringify(r)).digest("hex")),
        title: (r["Description"] as string) ?? null, agency: [r["Awarding Agency"], r["Awarding Sub Agency"]].filter(Boolean).join(" · ") || null,
        awardee: (r["Recipient Name"] as string) ?? null, awardeeId: (r.recipient_id as string) ?? null,
        naics: r["NAICS"] == null ? null : String(r["NAICS"]), psc: r["PSC"] == null ? null : String(r["PSC"]),
        amount: r["Award Amount"] ?? null, awardDate: dateOrNull(r["Start Date"]), postedDate: null,
        description: r["Award ID"] ? `Award ${r["Award ID"]}` : null, url: gid ? `https://www.usaspending.gov/award/${gid}` : null, raw: r,
      });
    }
    if (!data.page_metadata?.hasNext) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching + persistence
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Competitor whose name or alias appears in the awardee name (longest match wins). */
export async function matchCompetitor(awardee: string | null, competitors?: { id: string; name: string; aliasesJson: string }[]): Promise<string | null> {
  if (!awardee) return null;
  const list = competitors ?? (await prisma.competitor.findMany({ select: { id: true, name: true, aliasesJson: true } }));
  const hay = ` ${norm(awardee)} `;
  let best: { id: string; len: number } | null = null;
  for (const c of list) {
    const names = [c.name, ...(JSON.parse(c.aliasesJson || "[]") as string[])].map(norm).filter((n) => n.length >= 3);
    for (const n of names) if (hay.includes(` ${n} `) || hay.startsWith(`${n} `) || hay.includes(` ${n}`)) if (!best || n.length > best.len) best = { id: c.id, len: n.length };
  }
  return best?.id ?? null;
}

function keywordsHit(rec: AwardRecord, settings: BidSettings): string[] {
  const text = norm([rec.title, rec.description, rec.awardee].filter(Boolean).join(" "));
  const hits = settings.keywords.filter((k) => text.includes(norm(k)));
  if (rec.naics && settings.naics.some((n) => rec.naics!.startsWith(n))) hits.push(`NAICS ${rec.naics}`);
  if (rec.psc && settings.psc.some((p) => rec.psc!.toUpperCase().startsWith(p))) hits.push(`PSC ${rec.psc}`);
  return hits;
}

export async function upsertAwards(records: AwardRecord[], settings: BidSettings): Promise<{ created: number; updated: number; skipped: number; matched: number }> {
  const competitors = await prisma.competitor.findMany({ select: { id: true, name: true, aliasesJson: true } });
  let created = 0, updated = 0, skipped = 0, matched = 0;
  for (const r of records) {
    const amount = money(r.amount as never);
    if (amount && settings.minAmount && amount.lt(settings.minAmount)) { skipped++; continue; }
    const competitorId = await matchCompetitor(r.awardee, competitors);
    if (competitorId) matched++;
    const hits = keywordsHit(r, settings);
    const data = { title: r.title?.slice(0, 500) ?? null, agency: r.agency?.slice(0, 300) ?? null, awardee: r.awardee?.slice(0, 300) ?? null, awardeeId: r.awardeeId ?? null, naics: r.naics ?? null, psc: r.psc ?? null, amount: toDb(amount), currency: r.currency ?? "USD", awardDate: r.awardDate, postedDate: r.postedDate, description: r.description?.slice(0, 2000) ?? null, url: r.url, competitorId, keywordsMatched: hits.length ? hits.join(", ") : null, rawJson: JSON.stringify(r.raw).slice(0, 20_000) };
    const existing = await prisma.publicAward.findUnique({ where: { source_externalId: { source: r.source, externalId: r.externalId } }, select: { id: true } });
    if (existing) { await prisma.publicAward.update({ where: { id: existing.id }, data }); updated++; }
    else { await prisma.publicAward.create({ data: { source: r.source, externalId: r.externalId, ...data } }); created++; }
  }
  return { created, updated, skipped, matched };
}

/** One scheduled / manual pull from a public source, recorded as a FeedRun (`bids-<source>`). */
export async function ingestPublicAwards(source: BidSource, opts: { trigger: "schedule" | "manual"; actorUserId?: string | null; jobId?: string | null; lookbackDays?: number }) {
  const settings = await bidSettings();
  const to = new Date();
  const from = new Date(to.getTime() - (opts.lookbackDays ?? settings.lookbackDays) * 86_400_000);
  const run = await prisma.feedRun.create({ data: { feed: `bids-${source}`, trigger: opts.trigger, sourceRef: source === "sam" ? "api.sam.gov/opportunities/v2" : "api.usaspending.gov/v2/search/spending_by_award", jobId: opts.jobId ?? null } });
  try {
    const records = source === "sam" ? await pullSam(settings, { from, to }) : await pullUsaspending(settings, { from, to });
    const res = await upsertAwards(records, settings);
    await prisma.feedRun.update({ where: { id: run.id }, data: { status: "OK", rows: records.length, created: res.created, updated: res.updated, skipped: res.skipped, finishedAt: new Date(), reportJson: JSON.stringify({ ...res, from: from.toISOString(), to: to.toISOString(), naics: settings.naics, psc: settings.psc }) } });
    log.info("bids.ingested", { source, rows: records.length, ...res });
    return { runId: run.id, rows: records.length, ...res };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.feedRun.update({ where: { id: run.id }, data: { status: "FAILED", error: error.slice(0, 1000), finishedAt: new Date() } });
    log.error("bids.failed", { source, error });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Bid-file import (portals that only give you a tabulation)
// ---------------------------------------------------------------------------

export type BidFileResult = { awards: number; observations: number; rows: number; skipped: { row: number; reason: string }[] };

function readGrid(ws: ExcelJS.Worksheet): (string | number | null)[][] {
  const grid: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => { const cells: (string | number | null)[] = []; row.eachCell({ includeEmpty: true }, (cell, c) => { const v = cell.value; cells[c - 1] = typeof v === "number" ? v : v == null ? null : v instanceof Date ? v.toISOString() : typeof v === "object" && "result" in v ? (v.result as string | number) : String(v); }); grid[r - 1] = cells; });
  return grid;
}

export async function importBidFileXlsx(actorUserId: string, buffer: Buffer, sourceRef?: string | null) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0]; if (!ws) throw new Error("Workbook has no sheets");
  return importBidFileRows(actorUserId, readGrid(ws), sourceRef);
}

/**
 * Columns (loose, case-insensitive): Source | Bid Id | Title | Buyer/Agency | Awardee/Vendor | Award Date | Amount |
 * NAICS | Competitor | Competitor Code | Unit Price | Qty | UOM | URL | Notes.
 * A row with a competitor code and a unit price also records a price observation (PUBLIC_BID_DB).
 */
export async function importBidFileRows(actorUserId: string, grid: (string | number | null | undefined)[][], sourceRef?: string | null): Promise<BidFileResult> {
  const header = (grid[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const col = (re: RegExp) => { const i = header.findIndex((h) => re.test(h)); return i < 0 ? null : i; };
  const cSrc = col(/^(source|portal|system)$/), cId = col(/^(bid|award|solicitation|contract)?\s*(id|number|no\.?)$/), cTitle = col(/title|description of (bid|award)|^description$/), cBuyer = col(/buyer|agency|hospital|system|customer/), cVendor = col(/awardee|vendor|winner|supplier|recipient/), cDate = col(/date/), cAmt = col(/^(amount|award amount|total|value)$/), cNaics = col(/naics/), cComp = col(/^(competitor|manufacturer)( name)?$/), cCode = col(/competitor code|cfn|catalog|part|sku|item number/), cPrice = col(/unit price|price each|^price$/), cQty = col(/qty|quantity/), cUom = col(/uom|unit of measure/), cUrl = col(/url|link/), cNotes = col(/note/);
  if (cId === null && cTitle === null) throw new Error("Need a Bid Id or Title column");
  const res: BidFileResult = { awards: 0, observations: 0, rows: 0, skipped: [] };
  const settings = await bidSettings();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? []; const at = (i: number | null) => (i === null ? null : row[i] ?? null);
    if (!at(cId) && !at(cTitle)) continue; res.rows++;
    try {
      const portal = at(cSrc) ? String(at(cSrc)) : sourceRef ?? "bid file";
      const idRaw = at(cId) ? String(at(cId)) : null;
      const title = at(cTitle) ? String(at(cTitle)) : null;
      const externalId = `${norm(portal)}:${idRaw ?? createHash("sha1").update(`${title}|${at(cBuyer)}|${at(cDate)}`).digest("hex").slice(0, 16)}`;
      const compName = at(cComp) ? String(at(cComp)) : at(cVendor) ? String(at(cVendor)) : null;
      const rec: AwardRecord = { source: "BIDFILE", externalId, title, agency: at(cBuyer) ? String(at(cBuyer)) : null, awardee: at(cVendor) ? String(at(cVendor)) : compName, awardeeId: null, naics: at(cNaics) ? String(at(cNaics)) : null, psc: null, amount: at(cAmt), awardDate: dateOrNull(at(cDate)), postedDate: null, description: [portal, at(cNotes)].filter(Boolean).join(" · ") || null, url: at(cUrl) ? String(at(cUrl)) : null, raw: Object.fromEntries(header.map((h, i) => [h, row[i] ?? null])) };
      const up = await upsertAwards([rec], { ...settings, minAmount: 0 });
      res.awards += up.created + up.updated;
      const code = at(cCode) ? normalizeCfn(at(cCode)) : "";
      const price = money(at(cPrice) as never);
      if (code && !isPlaceholderSku(code) && price && price.gt(0) && compName) {
        await recordObservation(actorUserId, { competitorName: compName, competitorSku: code, price, currency: "USD", uom: at(cUom) ? String(at(cUom)) : "EA", observedAt: dateOrNull(at(cDate)) ?? new Date(), sourceType: "PUBLIC_BID_DB", sourceRef: `${portal}${idRaw ? ` ${idRaw}` : ""}`, notes: [title, at(cQty) ? `qty ${at(cQty)}` : null].filter(Boolean).join(" · ") || null });
        res.observations++;
      }
    } catch (e) { res.skipped.push({ row: r + 1, reason: e instanceof Error ? e.message : String(e) }); }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Reads for the page
// ---------------------------------------------------------------------------

export async function listAwards(opts: { q?: string | null; source?: string | null; competitorId?: string | null; sinceDays?: number | null; take?: number } = {}) {
  const take = Math.max(1, Math.min(500, opts.take ?? 200));
  const since = opts.sinceDays ? new Date(Date.now() - opts.sinceDays * 86_400_000) : null;
  const q = opts.q?.trim();
  const rows = await prisma.publicAward.findMany({
    where: {
      ...(opts.source ? { source: opts.source.toUpperCase() } : {}),
      ...(opts.competitorId ? { competitorId: opts.competitorId } : {}),
      ...(since ? { OR: [{ awardDate: { gte: since } }, { awardDate: null, importedAt: { gte: since } }] } : {}),
      ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { awardee: { contains: q, mode: "insensitive" } }, { agency: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ awardDate: { sort: "desc", nulls: "last" } }, { importedAt: "desc" }],
    take,
  });
  const competitors = await prisma.competitor.findMany({ select: { id: true, name: true } });
  const byId = new Map(competitors.map((c) => [c.id, c.name]));
  const runs = await prisma.feedRun.findMany({ where: { feed: { startsWith: "bids-" } }, orderBy: { startedAt: "desc" }, take: 10 });
  const totals = await prisma.publicAward.groupBy({ by: ["source"], _count: { _all: true } });
  return { awards: rows.map((r) => ({ ...r, competitorName: r.competitorId ? byId.get(r.competitorId) ?? null : null, rawJson: undefined })), runs, totals: totals.map((t) => ({ source: t.source, count: t._count._all })), competitors };
}

/**
 * Competitor GPO contract-price ingestion (2.6). Every row is validated before it becomes a
 * CompetitorPriceObservation; anything ambiguous goes to the review queue instead of the
 * intelligence model. Existing observations are never overwritten — a changed price for the
 * same contract/tier/period is a new observation plus a PRICE_EXCEPTION for a person to look
 * at, and an overlapping validity period is flagged as OVERLAP, so historical pricing survives.
 */
import { prisma } from "@/lib/db";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { money } from "@/lib/money";
import { recordObservation } from "@/lib/intelligence";
import type { CompetitorPriceImportRecord } from "../types";
import type { JobContext } from "../core/jobs";
import { queueReview } from "../core/review";
import { ValidationError } from "../core/errors";
import { normalizeUom } from "./mapping";

export type ContractIngestOptions = {
  /** Extra UOM aliases from the integration config (lowercase key → canonical). */
  uomAliases?: Record<string, string>;
  /** Allowed ISO currencies (default: USD, CAD, EUR, GBP, MXN, AUD, JPY, CHF). */
  currencies?: string[];
  /** When a competitor is unknown: queue for review (default) or create it. Creation is opt-in per company. */
  unknownCompetitor?: "review" | "create";
  /** Treat rows with an expiration date before this day as expired (skipped, counted). Default: today. */
  today?: Date;
  /** Keep expired rows as historical observations instead of skipping them. Default false. */
  keepExpired?: boolean;
  sourceSystem?: string;
  /** Set by review resolution: a person has looked at the conflict, so a differing price or an overlap is written as a new observation (history untouched). */
  acceptKnownConflicts?: boolean;
};

const DEFAULT_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "MXN", "AUD", "JPY", "CHF"];

export type ContractRowOutcome = { row: string | null; sku: string; result: "recorded" | "duplicate" | "review" | "expired" | "error"; reason?: string };

/** Validate + write one batch of contract-price rows. Row failures never abort the batch. */
export async function ingestContractPrices(ctx: JobContext, records: CompetitorPriceImportRecord[], opts: ContractIngestOptions = {}): Promise<ContractRowOutcome[]> {
  const today = opts.today ?? new Date();
  const currencies = new Set((opts.currencies ?? DEFAULT_CURRENCIES).map((c) => c.toUpperCase()));
  const competitors = await prisma.competitor.findMany();
  const byName = new Map<string, { id: string; name: string }>();
  for (const c of competitors) {
    byName.set(c.name.toLowerCase(), c);
    for (const a of JSON.parse(c.aliasesJson) as string[]) byName.set(a.toLowerCase(), c);
  }
  const gpos = await prisma.gpo.findMany();
  const gpoByName = new Map(gpos.flatMap((g) => [[g.name.toLowerCase(), g], ...(g.code ? [[g.code.toLowerCase(), g] as const] : [])]));
  const seen = new Map<string, number>();
  const out: ContractRowOutcome[] = [];

  for (const r of records) {
    ctx.received();
    const rowRef = r.provenance.sourceRecordId ?? null;
    const skuRaw = (r.competitorSku ?? "").trim();
    const sku = skuRaw ? compactCfn(normalizeCfn(skuRaw)) : "";
    const push = (result: ContractRowOutcome["result"], reason?: string) => out.push({ row: rowRef, sku: sku || skuRaw, result, reason });
    try {
      // ---- structural validation --------------------------------------------------------
      const problems: string[] = [];
      if (!sku) problems.push("missing competitor SKU");
      if (!(r.competitorName ?? "").trim()) problems.push("missing manufacturer");
      const price = money(r.price as never);
      if (r.price === null || r.price === undefined || String(r.price).trim() === "") problems.push("missing price");
      else if (!price || price.lte(0)) problems.push(`invalid price "${r.price}"`);
      const currency = (r.currency ?? "USD").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency) || !currencies.has(currency)) problems.push(`invalid currency "${r.currency}"`);
      const from = parseDate(r.effectiveFrom);
      const to = parseDate(r.effectiveTo);
      if (r.effectiveFrom && !from) problems.push(`malformed effective date "${r.effectiveFrom}"`);
      if (r.effectiveTo && !to) problems.push(`malformed expiration date "${r.effectiveTo}"`);
      if (from && to && to < from) problems.push("expiration precedes effective date");
      if (problems.length) throw new ValidationError(problems.join("; "), { details: { row: rowRef } });

      // ---- ambiguity → review ------------------------------------------------------------
      const { uom, ambiguous } = normalizeUom(r.uom, opts.uomAliases ?? {});
      if (ambiguous) {
        await review(ctx, "PRICE_EXCEPTION", `Row ${rowRef ?? "?"}: unit of measure "${r.uom}" is not recognised for ${r.competitorName} ${sku}`, r, `uom:${r.provenance.sourceSystem}:${rowRef ?? sku}`, { uomAliasesHint: "add the alias under Settings → Integrations → Competitor contract prices → UOM aliases" });
        push("review", "ambiguous UOM"); continue;
      }
      let competitor = byName.get(r.competitorName.trim().toLowerCase());
      if (!competitor) {
        if (opts.unknownCompetitor === "create") {
          const c = await prisma.competitor.create({ data: { name: r.competitorName.trim() } });
          byName.set(c.name.toLowerCase(), c); competitor = c;
        } else {
          await review(ctx, "UNKNOWN_COMPETITOR", `Row ${rowRef ?? "?"}: manufacturer "${r.competitorName}" is not a known competitor (SKU ${sku})`, r, `competitor:${r.competitorName.trim().toLowerCase()}`, { candidates: closest(r.competitorName, competitors.map((c) => c.name)) });
          push("review", "unknown competitor"); continue;
        }
      }
      let gpoId: string | null = null;
      if (r.gpoName?.trim()) {
        const g = gpoByName.get(r.gpoName.trim().toLowerCase());
        if (!g) { await review(ctx, "PRICE_EXCEPTION", `Row ${rowRef ?? "?"}: GPO "${r.gpoName}" is not set up in Crosswalk`, r, `gpo:${r.gpoName.trim().toLowerCase()}`, { candidates: closest(r.gpoName, gpos.map((g) => g.name)) }); push("review", "unknown GPO"); continue; }
        gpoId = g.id;
      }
      if (to && to < startOfDay(today) && !opts.keepExpired) { ctx.skipped(); push("expired", `expired ${to.toISOString().slice(0, 10)}`); continue; }

      // ---- duplicates (in batch and against history) ---------------------------------------
      const priceStr = price!.toFixed(4);
      const identity = [gpoId ?? "-", competitor.id, sku, (r.tier ?? "").trim().toLowerCase(), (r.contractRef ?? "").trim().toLowerCase(), from?.toISOString().slice(0, 10) ?? "-", uom, currency].join("|");
      const prev = seen.get(identity);
      if (prev !== undefined) {
        await review(ctx, "DUPLICATE", `Row ${rowRef ?? "?"} repeats an earlier row in the same file for ${competitor.name} ${sku}${r.tier ? ` (${r.tier})` : ""}`, r, `dup:${ctx.jobId}:${identity}`, { firstRow: prev });
        push("review", "duplicate within file"); continue;
      }
      seen.set(identity, out.length + 1);
      const existing = await prisma.competitorPriceObservation.findMany({ where: { competitorId: competitor.id, competitorSku: sku, gpoId, sourceType: "GPO_CONTRACT_FILE", tier: r.tier?.trim() || null }, orderBy: { observedAt: "desc" }, take: 50 });
      const same = existing.find((e) => e.contractRef === (r.contractRef?.trim() || null) && sameDay(e.effectiveAt, from) && e.uom === uom && e.currency === currency);
      if (same) {
        if (same.price.toFixed(4) === priceStr) { ctx.skipped(); push("duplicate", "already recorded"); continue; }
        if (!opts.acceptKnownConflicts) { await review(ctx, "PRICE_EXCEPTION", `Row ${rowRef ?? "?"}: ${competitor.name} ${sku}${r.tier ? ` (${r.tier})` : ""} already has ${same.price.toFixed(2)} ${currency}/${uom} for this contract and effective date; file says ${priceStr}`, r, `price:${identity}:${priceStr}`, { existingObservationId: same.id, existingPrice: same.price.toFixed(4), newPrice: priceStr });
        push("review", "price differs from recorded"); continue; }
      }
      const overlap = existing.find((e) => e.contractRef === (r.contractRef?.trim() || null) && overlaps(e.effectiveAt, e.validTo, from, to) && !sameDay(e.effectiveAt, from));
      if (overlap && !opts.acceptKnownConflicts) {
        await review(ctx, "OVERLAP", `Row ${rowRef ?? "?"}: validity ${fmt(from)}–${fmt(to)} overlaps the recorded ${fmt(overlap.effectiveAt)}–${fmt(overlap.validTo)} for ${competitor.name} ${sku}${r.tier ? ` (${r.tier})` : ""}`, r, `overlap:${identity}`, { existingObservationId: overlap.id, existingPrice: overlap.price.toFixed(4), newPrice: priceStr });
        push("review", "overlapping validity"); continue;
      }

      // ---- write -----------------------------------------------------------------------------
      await recordObservation(ctx.actorUserId, {
        competitorName: competitor.name, competitorSku: sku, price: priceStr, currency, uom: uom ?? "EA", gpoId,
        observedAt: from ?? today, effectiveAt: from ?? null, sourceType: "GPO_CONTRACT_FILE",
        sourceRef: r.contractRef?.trim() || r.provenance.sourceRecordId || null,
        tier: r.tier?.trim() || null, contractRef: r.contractRef?.trim() || null, validTo: to,
        sourceSystem: opts.sourceSystem ?? r.provenance.sourceSystem, sourceOwner: r.sourceOwner ?? null, syncJobId: ctx.jobId,
        competitorDescription: r.description?.trim() || null,
        notes: r.provenance.meta ? `imported from ${r.provenance.sourceSystem}${rowRef ? ` row ${rowRef}` : ""}` : null,
      });
      ctx.created(); push("recorded");
    } catch (e) {
      ctx.rowError("CompetitorContractPrice", sku || skuRaw || null, e, rowRef);
      push("error", e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

async function review(ctx: JobContext, kind: "PRICE_EXCEPTION" | "UNKNOWN_COMPETITOR" | "DUPLICATE" | "OVERLAP", summary: string, r: CompetitorPriceImportRecord, dedupeKey: string, suggestion?: unknown) {
  ctx.reviewed();
  await queueReview("competitor-contracts", { kind, summary, payload: r, suggestion, externalId: r.provenance.sourceRecordId ?? null, dedupeKey, syncJobId: ctx.jobId });
}

export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s.slice(0, 10) + "T00:00:00Z"); return isNaN(+d) ? null : d; }
  return null; // the mapping layer's `date` transform already normalised recognised formats to ISO
}
function startOfDay(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function sameDay(a: Date | null, b: Date | null) { return (a?.toISOString().slice(0, 10) ?? null) === (b?.toISOString().slice(0, 10) ?? null); }
function overlaps(aFrom: Date | null, aTo: Date | null, bFrom: Date | null, bTo: Date | null) {
  const af = aFrom ? +aFrom : -Infinity, at = aTo ? +aTo : Infinity, bf = bFrom ? +bFrom : -Infinity, bt = bTo ? +bTo : Infinity;
  return af <= bt && bf <= at;
}
function fmt(d: Date | null) { return d ? d.toISOString().slice(0, 10) : "open"; }
function closest(name: string, candidates: string[], n = 3): string[] {
  const q = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return candidates.map((c) => ({ c, s: sim(q, c.toLowerCase().replace(/[^a-z0-9]/g, "")) })).filter((x) => x.s > 0.4).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.c);
}
function sim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(a), gb = grams(b);
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size || 1);
}

/** Resolve a contract-price review item: accept the row as-is (with optional corrections) or dismiss it. */
export async function resolveContractReview(itemId: string, action: { type: "accept"; corrections?: Partial<CompetitorPriceImportRecord> & { createCompetitor?: boolean } } | { type: "dismiss"; reason?: string }, actorUserId: string): Promise<{ recorded: boolean }> {
  const item = await prisma.integrationReviewItem.findUniqueOrThrow({ where: { id: itemId } });
  if (item.integrationKey !== "competitor-contracts" || item.status !== "OPEN") throw new ValidationError("review item is not an open contract-price item");
  const { resolveReview } = await import("../core/review");
  if (action.type === "dismiss") { await resolveReview(itemId, "DISMISSED", actorUserId, { reason: action.reason ?? null }); return { recorded: false }; }
  const rec = { ...(JSON.parse(item.payloadJson) as CompetitorPriceImportRecord), ...(action.corrections ?? {}) };
  const { JobContext } = await import("../core/jobs");
  const job = await prisma.integrationSyncJob.create({ data: { integrationKey: "competitor-contracts", provider: rec.provenance?.provider ?? "manual", syncType: "review-resolution", trigger: "manual", status: "RUNNING", actorUserId } });
  const ctx = new JobContext(job.id, "competitor-contracts", rec.provenance?.provider ?? "manual", "review-resolution", actorUserId, null, 0);
  // an accepted overlap / price exception is written knowingly as a new observation; the existing one stays
  const outcome = await ingestContractPrices(ctx, [rec], { unknownCompetitor: action.corrections?.createCompetitor ? "create" : "review", keepExpired: true, acceptKnownConflicts: true, uomAliases: rec.uom ? { [rec.uom.toLowerCase().replace(/[.\s]/g, "")]: rec.uom.toUpperCase() } : {} });
  const { finishJob } = await import("../core/jobs");
  await finishJob(ctx, { reviewItemId: itemId, outcome });
  const recorded = outcome[0]?.result === "recorded";
  await resolveReview(itemId, recorded ? "ACCEPTED" : "CORRECTED", actorUserId, { outcome: outcome[0] ?? null, jobId: job.id });
  return { recorded };
}

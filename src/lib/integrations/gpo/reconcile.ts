/**
 * Roster reconciliation — the only code that writes GpoMembership from a roster.
 *
 *  - Match the member to an account: account number → CRM id → an existing membership with
 *    the same external membership id → otherwise the review queue (UNMATCHED_ACCOUNT) with
 *    name/postal-code suggestions. Nothing is created for an unmatched member.
 *  - Duplicates inside one roster (same membership id, or same account+GPO+start) are
 *    counted once; the later row goes to review as DUPLICATE when its data differs.
 *  - History is never rewritten. A change of tier or dates on an existing membership row
 *    (same external id) closes the old row at the new start and opens a new one; a membership
 *    that overlaps an open one for the same account and GPO with a different tier is a
 *    MEMBERSHIP_CONFLICT for review, not a silent overwrite.
 *  - Stale memberships (open rows the GPO no longer lists) are closed only when the roster is
 *    declared complete (`closeMissing`), and even then are recorded, never deleted.
 */
import { prisma } from "@/lib/db";
import type { GpoMembershipImportRecord } from "../types";
import type { JobContext } from "../core/jobs";
import { queueReview } from "../core/review";
import type { IntegrationKey } from "../core/config";
import { DataConflictError, ValidationError } from "../core/errors";

export type ReconcileOptions = { closeMissing?: boolean; /** whole-roster runs can close stale memberships */ complete?: boolean; today?: Date };
export type ReconcileSummary = { matched: number; unmatched: number; conflicts: number; duplicates: number; closedStale: number };

const day = (s: string) => { const d = new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s); if (!Number.isFinite(d.getTime())) throw new ValidationError(`"${s}" is not a date`, { retryable: false }); return d; };

export async function reconcileRoster(k: IntegrationKey, ctx: JobContext, records: GpoMembershipImportRecord[], opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { matched: 0, unmatched: 0, conflicts: 0, duplicates: 0, closedStale: 0 };
  const seen = new Map<string, GpoMembershipImportRecord>();
  const touched = new Set<string>(); // membership ids present in this roster
  const gpoByName = new Map<string, { id: string }>();
  for (const m of records) {
    ctx.received();
    const dedupe = m.externalMembershipId ? `ext:${m.gpoName}:${m.externalMembershipId}` : `acct:${m.gpoName}:${m.accountNumber ?? m.accountExternalId ?? m.memberName}:${m.effectiveFrom}`;
    const prior = seen.get(dedupe);
    if (prior) {
      summary.duplicates++;
      if (JSON.stringify({ ...prior, provenance: null }) !== JSON.stringify({ ...m, provenance: null })) { await queueReview(k, { kind: "DUPLICATE", summary: `Roster lists ${m.memberName ?? m.externalMembershipId ?? "a member"} twice with different data`, payload: { first: strip(prior), second: strip(m) }, dedupeKey: `dup:${dedupe}`, syncJobId: ctx.jobId, externalId: m.externalMembershipId ?? null }); ctx.reviewed(); }
      ctx.skipped();
      continue;
    }
    seen.set(dedupe, m);
    try {
      let from: Date, to: Date | null;
      try { from = day(m.effectiveFrom); to = m.effectiveTo ? day(m.effectiveTo) : null; } catch (e) { throw new ValidationError(`${m.memberName ?? m.externalMembershipId}: ${(e as Error).message}`, { retryable: false }); }
      if (to && to < from) throw new ValidationError(`${m.memberName ?? m.externalMembershipId}: expiration ${m.effectiveTo} is before start ${m.effectiveFrom}`, { retryable: false });
      let gpo = gpoByName.get(m.gpoName);
      if (!gpo) { gpo = await prisma.gpo.upsert({ where: { name: m.gpoName }, create: { name: m.gpoName, code: m.gpoCode ?? null }, update: {} , select: { id: true } }); gpoByName.set(m.gpoName, gpo); }
      const account = await matchAccount(m, gpo.id);
      if (!account) {
        summary.unmatched++;
        const suggestions = await suggestAccounts(m);
        await queueReview(k, { kind: "UNMATCHED_ACCOUNT", summary: `${m.gpoName} member "${m.memberName ?? m.externalMembershipId}"${m.address?.city ? ` (${m.address.city}, ${m.address.region ?? ""})` : ""} matches no account`, payload: strip(m), suggestion: suggestions, dedupeKey: `unmatched:${dedupe}`, syncJobId: ctx.jobId, externalId: m.externalMembershipId ?? null });
        ctx.reviewed(); ctx.skipped();
        continue;
      }
      const data = { accountId: account.id, gpoId: gpo.id, tier: m.tier ?? null, effectiveFrom: from, effectiveTo: to, source: m.source ?? "gpo-feed", verifiedAt: m.lastVerifiedAt ? day(m.lastVerifiedAt) : new Date(), externalMembershipId: m.externalMembershipId ?? null, memberName: m.memberName ?? null, addressJson: m.address ? JSON.stringify(m.address) : null, syncJobId: ctx.jobId };
      // Same membership already known? (by external id, else by exact account+gpo+start)
      const existing = m.externalMembershipId
        ? await prisma.gpoMembership.findFirst({ where: { gpoId: gpo.id, externalMembershipId: m.externalMembershipId }, orderBy: { effectiveFrom: "desc" } })
        : await prisma.gpoMembership.findFirst({ where: { accountId: account.id, gpoId: gpo.id, effectiveFrom: from } });
      if (existing) {
        touched.add(existing.id);
        const same = (existing.tier ?? null) === data.tier && existing.effectiveFrom.getTime() === from.getTime() && (existing.effectiveTo?.getTime() ?? null) === (to?.getTime() ?? null) && existing.accountId === account.id;
        if (same) { await prisma.gpoMembership.update({ where: { id: existing.id }, data: { verifiedAt: data.verifiedAt, memberName: data.memberName, addressJson: data.addressJson, syncJobId: ctx.jobId } }); ctx.skipped(); summary.matched++; continue; }
        if (existing.accountId !== account.id) throw new DataConflictError(`${m.gpoName} membership ${m.externalMembershipId} moved from one account to another; resolve in the review queue`, { retryable: false });
        // A change: close the old row where the new one starts (or at its own start if the new one starts earlier), open a new row. History stays.
        const closeAt = from > existing.effectiveFrom ? from : existing.effectiveFrom;
        await prisma.gpoMembership.update({ where: { id: existing.id }, data: { effectiveTo: closeAt, syncJobId: ctx.jobId } });
        const row = await prisma.gpoMembership.create({ data });
        touched.add(row.id); ctx.updated(); summary.matched++;
        continue;
      }
      // New membership: does it conflict with an open one (same account, same GPO, overlapping, different tier)?
      const open = await prisma.gpoMembership.findMany({ where: { accountId: account.id, gpoId: gpo.id, OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }] } });
      const conflict = open.find((o) => (o.tier ?? null) !== data.tier && (!to || o.effectiveFrom < to) && (!o.effectiveTo || o.effectiveTo > from) && o.externalMembershipId !== (m.externalMembershipId ?? null));
      if (conflict) {
        summary.conflicts++;
        await queueReview(k, { kind: "MEMBERSHIP_CONFLICT", summary: `${account.name}: ${m.gpoName} roster says tier ${m.tier ?? "—"} from ${m.effectiveFrom}, but an open membership has tier ${conflict.tier ?? "—"} from ${conflict.effectiveFrom.toISOString().slice(0, 10)}`, payload: { roster: strip(m), existing: { id: conflict.id, tier: conflict.tier, effectiveFrom: conflict.effectiveFrom, effectiveTo: conflict.effectiveTo, source: conflict.source } }, suggestion: { accountId: account.id, action: "supersede" }, dedupeKey: `conflict:${account.id}:${gpo.id}:${m.effectiveFrom}`, syncJobId: ctx.jobId, externalId: m.externalMembershipId ?? null });
        ctx.reviewed(); ctx.skipped();
        continue;
      }
      // Same tier, overlapping window from the same roster line-up: extend/verify rather than duplicate.
      const sameTierOpen = open.find((o) => (o.tier ?? null) === data.tier && o.effectiveTo === null && o.effectiveFrom <= from);
      if (sameTierOpen && !m.externalMembershipId) { await prisma.gpoMembership.update({ where: { id: sameTierOpen.id }, data: { verifiedAt: data.verifiedAt, effectiveTo: to, syncJobId: ctx.jobId } }); touched.add(sameTierOpen.id); ctx.skipped(); summary.matched++; continue; }
      const row = await prisma.gpoMembership.create({ data });
      touched.add(row.id); ctx.created(); summary.matched++;
    } catch (e) {
      ctx.rowError("GpoMembership", m.externalMembershipId ?? m.accountNumber ?? null, e, m.provenance.meta?.row ? String(m.provenance.meta.row) : null);
    }
  }
  if (opts.complete && opts.closeMissing && records.length) {
    const gpoIds = [...gpoByName.values()].map((g) => g.id);
    const stale = await prisma.gpoMembership.findMany({ where: { gpoId: { in: gpoIds }, effectiveTo: null, source: "gpo-feed", id: { notIn: [...touched] } }, select: { id: true } });
    if (stale.length) { await prisma.gpoMembership.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { effectiveTo: opts.today ?? new Date(), syncJobId: ctx.jobId } }); summary.closedStale = stale.length; }
  }
  return summary;
}

async function matchAccount(m: GpoMembershipImportRecord, gpoId: string): Promise<{ id: string; name: string } | null> {
  if (m.accountNumber) { const a = await prisma.account.findUnique({ where: { accountNumber: m.accountNumber }, select: { id: true, name: true } }); if (a) return a; }
  if (m.accountExternalId) { const a = await prisma.account.findUnique({ where: { externalCrmId: m.accountExternalId }, select: { id: true, name: true } }); if (a) return a; }
  if (m.externalMembershipId) { const prev = await prisma.gpoMembership.findFirst({ where: { gpoId, externalMembershipId: m.externalMembershipId }, select: { account: { select: { id: true, name: true } } } }); if (prev) return prev.account; }
  return null;
}

/** Name / postal-code candidates for the reviewer (never auto-linked). */
export async function suggestAccounts(m: GpoMembershipImportRecord): Promise<{ accountId: string; name: string; accountNumber: string | null; reason: string }[]> {
  const out: { accountId: string; name: string; accountNumber: string | null; reason: string }[] = [];
  if (m.memberName) {
    const words = m.memberName.split(/\s+/).filter((w) => w.length > 3 && !/^(the|and|of|hospital|medical|center|health|system)$/i.test(w)).slice(0, 3);
    const byName = await prisma.account.findMany({ where: { OR: [{ name: { contains: m.memberName.slice(0, 40), mode: "insensitive" } }, ...words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } }))] }, select: { id: true, name: true, accountNumber: true }, take: 5 });
    for (const a of byName) out.push({ accountId: a.id, name: a.name, accountNumber: a.accountNumber, reason: "similar name" });
  }
  return out.slice(0, 5);
}

/** Apply a reviewer's decision: link the member to an account (re-runs the write for that record) or accept a conflicting roster row (supersede). */
export async function resolveRosterReview(k: IntegrationKey, itemId: string, action: { type: "link"; accountId: string } | { type: "supersede" } | { type: "dismiss" }, actorUserId: string): Promise<void> {
  const item = await prisma.integrationReviewItem.findUniqueOrThrow({ where: { id: itemId } });
  const { resolveReview } = await import("../core/review");
  if (action.type === "dismiss") { await resolveReview(itemId, "DISMISSED", actorUserId); return; }
  const payload = JSON.parse(item.payloadJson) as GpoMembershipImportRecord | { roster: GpoMembershipImportRecord; existing: { id: string } };
  const rec = "roster" in payload ? payload.roster : payload;
  const gpo = await prisma.gpo.upsert({ where: { name: rec.gpoName }, create: { name: rec.gpoName, code: rec.gpoCode ?? null }, update: {}, select: { id: true } });
  if (action.type === "link") {
    const account = await prisma.account.findUniqueOrThrow({ where: { id: action.accountId }, select: { id: true } });
    const from = day(rec.effectiveFrom), to = rec.effectiveTo ? day(rec.effectiveTo) : null;
    await prisma.gpoMembership.create({ data: { accountId: account.id, gpoId: gpo.id, tier: rec.tier ?? null, effectiveFrom: from, effectiveTo: to, source: rec.source ?? "gpo-feed", verifiedAt: new Date(), verifiedBy: actorUserId, externalMembershipId: rec.externalMembershipId ?? null, memberName: rec.memberName ?? null, addressJson: rec.address ? JSON.stringify(rec.address) : null, syncJobId: item.syncJobId } });
    await resolveReview(itemId, "LINKED", actorUserId, { accountId: account.id });
    return;
  }
  if ("existing" in payload) {
    const from = day(rec.effectiveFrom), to = rec.effectiveTo ? day(rec.effectiveTo) : null;
    const existing = await prisma.gpoMembership.findUniqueOrThrow({ where: { id: payload.existing.id } });
    await prisma.gpoMembership.update({ where: { id: existing.id }, data: { effectiveTo: from > existing.effectiveFrom ? from : existing.effectiveFrom } });
    await prisma.gpoMembership.create({ data: { accountId: existing.accountId, gpoId: gpo.id, tier: rec.tier ?? null, effectiveFrom: from, effectiveTo: to, source: rec.source ?? "gpo-feed", verifiedAt: new Date(), verifiedBy: actorUserId, externalMembershipId: rec.externalMembershipId ?? null, memberName: rec.memberName ?? null, syncJobId: item.syncJobId } });
    await resolveReview(itemId, "ACCEPTED", actorUserId, { supersededMembershipId: existing.id });
  }
}

const strip = (m: GpoMembershipImportRecord) => ({ ...m, provenance: { ...m.provenance, meta: m.provenance.meta ?? null } });

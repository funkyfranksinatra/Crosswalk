/**
 * The learning loop. Every decision a rep makes on a cross-reference line is ground
 * truth about the matcher:
 *
 *   - selecting a candidate that was not ranked first  → a rep-proposed KnownCross (DRAFT,
 *     source "rep", tied to the account and the person) plus a MatchDecision with
 *     acceptedTop=false. The next run surfaces that SKU for the code with a small prior
 *     (score.ts REP_PRIOR_BOOST); clinical + marketing review can promote it to an approved,
 *     published cross — nothing a rep does changes what may be *represented* to a customer.
 *   - marking a line reviewed with the top candidate kept → MatchDecision acceptedTop=true,
 *     which is what the accuracy analytics and the benchmark read.
 *   - undoing an override (selecting the top candidate again) retires the draft the same
 *     rep created, so the review queue does not fill with changed minds.
 *
 * Repeated choices are counted (evidenceJson.endorsements) so reviewers see "chosen by 4
 * reps at 3 accounts" rather than a lone opinion.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth";
import { normalizeCfn } from "@/lib/cfn";
import { equivalenceFromMatchType } from "./governance";
import { log } from "@/lib/log";

type Evidence = { endorsements: number; accounts: string[]; users: string[]; lines: string[]; lastAt: string };

function parseEvidence(json: string | null): Evidence {
  try { const e = json ? (JSON.parse(json) as Partial<Evidence>) : {}; return { endorsements: e.endorsements ?? 0, accounts: e.accounts ?? [], users: e.users ?? [], lines: e.lines ?? [], lastAt: e.lastAt ?? "" }; } catch { return { endorsements: 0, accounts: [], users: [], lines: [], lastAt: "" }; }
}

/**
 * Apply a rep's decision on a request line and record what it teaches us. Returns what
 * was learned so the UI can say "saved as a proposed cross for review".
 */
export async function recordLineDecision(actor: Actor, lineId: string, decision: { selectedCandidateId?: string | null; reviewed?: boolean; overrideNote?: string | null }) {
  const line = await prisma.requestLine.findUniqueOrThrow({ where: { id: lineId }, include: { request: { select: { id: true, accountId: true, accountName: true, accountNumber: true } }, competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: { select: { id: true, sku: true, description: true, category: true } } } } } });
  const top = line.candidates[0] ?? null;
  const selecting = decision.selectedCandidateId !== undefined;
  // "Reviewed" without a new selection judges the line's CURRENT selection, not "nothing".
  const chosenId = selecting ? decision.selectedCandidateId : line.selectedCandidateId;
  const chosen = chosenId ? line.candidates.find((c) => c.id === chosenId) ?? null : null;
  const learned: { proposedCrossId?: string; retiredCrossId?: string; decisionId?: string } = {};
  if (!top) return learned;

  const competitorCode = line.rawCode;
  const competitorName = line.competitorProduct?.manufacturer ?? "Unknown";
  const norm = normalizeCfn(line.cfnNorm);
  const acceptedTop = Boolean(chosen && chosen.id === top.id);

  // A choice was made (or the current one confirmed): record the decision.
  if (selecting || decision.reviewed) {
    const d = await prisma.matchDecision.create({ data: { requestLineId: line.id, topRecommendedSku: top.ownProduct.sku, chosenSku: chosen?.ownProduct.sku ?? null, acceptedTop, overrideReason: decision.overrideNote ?? line.overrideNote ?? null, productFamily: chosen?.ownProduct.category ?? top.ownProduct.category, competitorName, confidence: top.score, decidedByUserId: actor.id } });
    learned.decisionId = d.id;
  }

  if (chosen && !acceptedTop) {
    // Override → propose (or endorse) a rep cross for review.
    const ownSku = chosen.ownProduct.sku.toUpperCase();
    const existing = await prisma.knownCross.findUnique({ where: { ownSku_competitorCodeNorm_source: { ownSku, competitorCodeNorm: norm, source: "rep" } } });
    const ev = parseEvidence(existing?.evidenceJson ?? null);
    const accounts = [...new Set([...ev.accounts, line.request.accountNumber ?? line.request.accountId ?? ""].filter(Boolean))];
    const users = [...new Set([...ev.users, actor.id])];
    // One endorsement per request line: toggling the same choice back and forth is not new evidence.
    const lines = [...new Set([...ev.lines, line.id])];
    const evidence: Evidence = { endorsements: lines.length, accounts, users, lines, lastAt: new Date().toISOString() };
    const matchType = chosen.matchType === "No Match" ? "Alternative Match" : chosen.matchType;
    // A cross under review or approved only gains evidence; its tier, status and justification belong to the reviewers.
    const reviewed = existing && ["IN_REVIEW", "APPROVED"].includes(existing.approvalStatus);
    const row = existing
      ? await prisma.knownCross.update({ where: { id: existing.id }, data: reviewed ? { evidenceJson: JSON.stringify(evidence) } : { isActive: true, evidenceJson: JSON.stringify(evidence), ...(existing.approvalStatus === "RETIRED" || existing.approvalStatus === "REJECTED" ? { approvalStatus: "DRAFT", clinicalReviewStatus: "PENDING", marketingReviewStatus: "PENDING" } : {}), justification: decision.overrideNote ?? existing.justification } })
      : await prisma.knownCross.create({ data: { ownSku, ownDescription: chosen.ownProduct.description, category: chosen.ownProduct.category, competitorName, competitorCode, competitorCodeNorm: norm, competitorDescription: line.competitorProduct?.description ?? null, matchType, source: "rep", approvalStatus: "DRAFT", clinicalReviewStatus: "PENDING", marketingReviewStatus: "PENDING", equivalenceLevel: equivalenceFromMatchType(matchType), justification: decision.overrideNote ?? null, accountId: line.request.accountId ?? null, createdByUserId: actor.id, evidenceJson: JSON.stringify(evidence) } });
    learned.proposedCrossId = row.id;
    await audit({ actorUserId: actor.id, entityType: "KnownCross", entityId: row.id, action: existing ? "ENDORSED_BY_REP" : "PROPOSED_BY_REP", after: { ownSku, competitorCode, matchType, endorsements: evidence.endorsements, requestLineId: line.id, over: top.ownProduct.sku } });
    if (!existing) { const { notifyCrossProposed } = await import("@/lib/notifications"); await notifyCrossProposed(row.id).catch(() => undefined); }
    log.info("learning.override", { lineId: line.id, code: norm, chosen: ownSku, over: top.ownProduct.sku, endorsements: evidence.endorsements });
  } else if (chosen && acceptedTop) {
    // Changed their mind back: retire a draft this same rep raised for another SKU on this code.
    const mine = await prisma.knownCross.findMany({ where: { competitorCodeNorm: norm, source: "rep", approvalStatus: "DRAFT", createdByUserId: actor.id, isActive: true } });
    for (const k of mine) {
      const ev = parseEvidence(k.evidenceJson);
      // Only a lone opinion is withdrawn: a draft someone else also chose stays for review.
      if (ev.users.filter((u) => u !== actor.id).length === 0) {
        await prisma.knownCross.update({ where: { id: k.id }, data: { isActive: false, approvalStatus: "RETIRED" } });
        await audit({ actorUserId: actor.id, entityType: "KnownCross", entityId: k.id, action: "RETIRED_BY_REP", after: { reason: "override undone" } });
        learned.retiredCrossId = k.id;
      }
    }
  }
  return learned;
}

/** Rep-proposed crosses awaiting review, with their evidence, for the Crosswalk review page. */
export async function proposedCrosses(take = 100) {
  const rows = await prisma.knownCross.findMany({ where: { source: "rep", approvalStatus: { in: ["DRAFT", "IN_REVIEW"] }, isActive: true }, orderBy: { updatedAt: "desc" }, take });
  return rows.map((r) => ({ ...r, evidence: parseEvidence(r.evidenceJson) }));
}

/** What the matcher should load: approved crosses with full weight, unreviewed rep crosses as priors. */
export async function crossesForMatching() {
  const rows = await prisma.knownCross.findMany({ where: { isActive: true, OR: [{ approvalStatus: "APPROVED" }, { source: "rep", approvalStatus: { in: ["DRAFT", "IN_REVIEW"] } }] } });
  return rows.map((k) => ({ ...k, endorsements: parseEvidence(k.evidenceJson).endorsements || 1 }));
}

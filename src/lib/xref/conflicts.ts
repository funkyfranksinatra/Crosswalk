/**
 * Evidence conflicts on curated crosses.
 *
 * The curated sheets are evidence, not an override (docs/MATCH_QUALITY_MODEL.md §5): when a run's
 * product attributes contradict a curated row, the row is ranked at the evidence's grade and labelled.
 * Left there, the disagreement would sit in a spreadsheet nobody owns across the companies Crosswalk is
 * deployed for. This module keeps it on the row instead — the findings, how often runs hit it, and the
 * SKU the evidence put first — and lets a reviewer settle it in Crosswalk → Evidence conflicts with one
 * of three decisions:
 *
 *   RETIRE  — the row is wrong: approvalStatus RETIRED (the matcher and the published crosswalk drop it).
 *   REPLACE — the evidence is right: retire the row and record the evidence-based cross as a reviewed,
 *             approved row (source "evidence"), so the next run and the next publish carry it.
 *   KEEP    — the sheet is right after all: the row keeps its grade against soft findings (length class,
 *             optical, tip…); hard findings (component, diameter) still cap it, because nobody can confirm
 *             a sleeve into a trocar.
 *
 * Runs never wait for a decision. Re-seeding from the sheets never resets one (prisma/seed.ts only
 * refreshes grade, description and preferred SKU).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { ScoredCandidate } from "@/lib/match/score";

export type ConflictRecord = {
  findings: string[];
  /** the evidence's first choice for the line, when it is not this row's SKU */
  suggestedSku: string | null;
  suggestedGrade: string | null;
  /** the grade the row was ranked at */
  effective: string;
  sheetGrade: string;
  requestReference: string;
  lineCode: string;
};

export function parseConflict(
  json: string | null | undefined,
): ConflictRecord | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ConflictRecord;
  } catch {
    return null;
  }
}

/** After a run persisted its candidates: queue every curated row a line's evidence contradicted. */
export async function recordCuratedConflicts(
  requestReference: string,
  lines: { code: string; scored: ScoredCandidate[] }[],
): Promise<number> {
  const byId = new Map<string, ConflictRecord>();
  for (const l of lines) {
    const top = l.scored.find((s) => s.matchType !== "No Match") ?? null;
    for (const s of l.scored) {
      const cur = s.factors.curated;
      if (!cur?.contradicted || !cur.knownCrossId || cur.kept) continue;
      const suggested = top && top.ownProductId !== s.ownProductId ? top : null;
      byId.set(cur.knownCrossId, {
        findings: cur.findings ?? [],
        suggestedSku: suggested?.sku ?? null,
        suggestedGrade: suggested?.matchType ?? null,
        effective: cur.effective,
        sheetGrade: cur.grade,
        requestReference,
        lineCode: l.code,
      });
    }
  }
  if (!byId.size) return 0;
  const now = new Date();
  let queued = 0;
  for (const [id, rec] of byId) {
    // A reviewer's KEEP is never overturned by a later run; everything else refreshes the queue entry.
    const r = await prisma.knownCross.updateMany({
      where: {
        id,
        OR: [{ conflictStatus: null }, { conflictStatus: "CONTRADICTED" }],
      },
      data: {
        conflictStatus: "CONTRADICTED",
        conflictJson: JSON.stringify(rec),
        conflictSeenAt: now,
        conflictCount: { increment: 1 },
      },
    });
    queued += r.count;
  }
  return queued;
}

export type ConflictDecision = "RETIRE" | "REPLACE" | "KEEP";

/** Settle a queued conflict. Requires manage_crosswalk (checked by the route). */
export async function decideConflict(
  actorUserId: string,
  id: string,
  decision: ConflictDecision,
  note?: string | null,
) {
  if (!["RETIRE", "REPLACE", "KEEP"].includes(decision))
    throw new Error("decision must be RETIRE, REPLACE or KEEP");
  const row = await prisma.knownCross.findUniqueOrThrow({ where: { id } });
  if (row.conflictStatus !== "CONTRADICTED")
    throw new Error("This row has no open evidence conflict");
  const rec = parseConflict(row.conflictJson);
  const now = new Date();
  const decided = {
    conflictDecidedByUserId: actorUserId,
    conflictDecidedAt: now,
    conflictNote: note?.trim() || null,
  };
  const replacement = await prisma.$transaction(
    async (tx): Promise<{ id: string; ownSku: string } | null> => {
      if (decision === "KEEP") {
        await tx.knownCross.update({
          where: { id },
          data: { ...decided, conflictStatus: "KEPT" },
        });
      } else {
        await tx.knownCross.update({
          where: { id },
          data: {
            ...decided,
            conflictStatus: null,
            approvalStatus: "RETIRED",
            effectiveTo: now,
            justification: [
              row.justification,
              `Retired from Evidence conflicts (${decision.toLowerCase()}): ${(rec?.findings ?? []).join("; ") || "contradicted by the product attributes"}`,
            ]
              .filter(Boolean)
              .join(" | "),
          },
        });
      }
      if (decision !== "REPLACE") return null;
      if (!rec?.suggestedSku)
        throw new Error(
          "No evidence-based SKU was recorded for this row; retire it or keep it",
        );
      const grade = rec.suggestedGrade ?? rec.effective;
      const own = await tx.ownProduct.findFirst({
        where: { sku: rec.suggestedSku },
        select: { description: true, category: true },
      });
      return tx.knownCross.upsert({
        where: {
          ownSku_competitorCodeNorm_source: {
            ownSku: rec.suggestedSku,
            competitorCodeNorm: row.competitorCodeNorm,
            source: "evidence",
          },
        },
        create: {
          ownSku: rec.suggestedSku,
          ownDescription: own?.description ?? null,
          category: own?.category ?? row.category,
          competitorName: row.competitorName,
          competitorCode: row.competitorCode,
          competitorCodeNorm: row.competitorCodeNorm,
          competitorDescription: row.competitorDescription,
          matchType: grade,
          source: "evidence",
          isActive: true,
          approvalStatus: "APPROVED",
          clinicalReviewStatus: "NOT_REQUIRED",
          marketingReviewStatus: "APPROVED",
          equivalenceLevel:
            grade === "Exact Match"
              ? "EXACT"
              : grade === "Close Match"
                ? "FUNCTIONAL"
                : "CLOSEST_ALTERNATIVE",
          justification: `Replaces ${row.ownSku} (${row.source}, ${row.matchType}) after the product attributes contradicted it: ${(rec.findings ?? []).join("; ")}`,
          reviewerUserId: actorUserId,
          approvedByUserId: actorUserId,
          approvedAt: now,
          effectiveFrom: now,
          createdByUserId: actorUserId,
          evidenceJson: JSON.stringify({
            from: "evidence-conflict",
            request: rec.requestReference,
            line: rec.lineCode,
            replaced: row.id,
          }),
        },
        update: {
          matchType: grade,
          isActive: true,
          approvalStatus: "APPROVED",
          marketingReviewStatus: "APPROVED",
          approvedByUserId: actorUserId,
          approvedAt: now,
          effectiveTo: null,
        },
        select: { id: true, ownSku: true },
      });
    },
  );
  await audit({
    actorUserId,
    entityType: "KnownCross",
    entityId: id,
    action: `CONFLICT_${decision}`,
    reason: note ?? null,
    before: {
      approvalStatus: row.approvalStatus,
      conflictStatus: row.conflictStatus,
    },
    after: { decision, replacement: replacement?.ownSku ?? null },
    context: rec ?? undefined,
  });
  return { id, decision, replacement };
}

/** The open queue, newest first, with parsed records. */
export async function openConflicts(take = 200) {
  const rows = await prisma.knownCross.findMany({
    where: { conflictStatus: "CONTRADICTED", isActive: true },
    orderBy: [{ conflictSeenAt: "desc" }],
    take,
  });
  return rows.map((r) => ({ ...r, conflict: parseConflict(r.conflictJson) }));
}

import { prisma } from "@/lib/db";
import { num, money, ZERO, round, type MoneyLike } from "@/lib/money";

export async function nextReference(): Promise<string> {
  const last = await prisma.request.findFirst({ orderBy: { createdAt: "desc" }, select: { reference: true } });
  const n = last ? parseInt(last.reference.replace(/\D/g, ""), 10) || 0 : 0;
  return `REQ-${String(n + 1).padStart(4, "0")}`;
}

export type RequestSummary = {
  total: number;
  resolved: number;
  matched: number;
  exact: number;
  close: number;
  alternative: number;
  reviewed: number;
  ourExtended: number;
  competitorExtended: number;
  priced: number;
};

export function summarizeLines(lines: { quantity: number; estCompetitorPrice: MoneyLike; resolutionStatus: string; matchStatus: string; reviewed: boolean; selectedCandidateId: string | null; candidates: { id: string; matchType: string; unitPrice: MoneyLike }[] }[]): RequestSummary {
  const s: RequestSummary = { total: lines.length, resolved: 0, matched: 0, exact: 0, close: 0, alternative: 0, reviewed: 0, ourExtended: 0, competitorExtended: 0, priced: 0 };
  let our = ZERO, comp = ZERO;
  for (const l of lines) {
    if (l.resolutionStatus === "resolved") s.resolved++;
    if (l.reviewed) s.reviewed++;
    const sel = l.candidates.find((c) => c.id === l.selectedCandidateId);
    if (sel && sel.matchType !== "No Match") {
      s.matched++;
      if (sel.matchType === "Exact Match") s.exact++;
      else if (sel.matchType === "Close Match") s.close++;
      else s.alternative++;
      const up = num(sel.unitPrice);
      if (up != null) { our = our.plus(money(sel.unitPrice)!.times(l.quantity)); s.priced++; }
    }
    const cp = money(l.estCompetitorPrice);
    if (cp != null) comp = comp.plus(cp.times(l.quantity));
  }
  s.ourExtended = num(round(our))!;
  s.competitorExtended = num(round(comp))!;
  return s;
}

/**
 * Approval rules — pure. Which role a line needs, what a proposal's status is given
 * its approval requests, and whether it may be finalised/exported.
 */
import { type Money } from "@/lib/money";
import { authorityForDiscount, approvalRequirements } from "@/lib/pricing/recommend";
import { type Policy } from "@/lib/pricing/policy-model";
import { authorityRank } from "@/lib/auth/permissions";

export type LineFacts = {
  discountFromList: Money | null;
  discountFromContract: Money | null;
  belowFloor: boolean;
  marginPct: Money | null;
  lineValue: Money | null;
  dealValue: Money | null;
  strategicAccount: boolean;
  contractMonths: number | null;
};

/** Lowest role that can approve this line under the policy; null = within rep authority. */
export function requiredRoleFor(policy: Policy, f: LineFacts): string | null {
  const byDiscount = authorityForDiscount(policy, f.discountFromContract ?? f.discountFromList);
  const rules = approvalRequirements(policy, { belowFloor: f.belowFloor, belowTargetMargin: Boolean(f.marginPct && f.marginPct.lt(policy.targetMarginPct)), marginPct: f.marginPct, discountFromList: f.discountFromList, discountFromContract: f.discountFromContract, dealValue: f.dealValue, lineValue: f.lineValue, strategicAccount: f.strategicAccount, contractMonths: f.contractMonths });
  if (!byDiscount) return rules.role;
  if (!rules.role) return byDiscount;
  return authorityRank(byDiscount) >= authorityRank(rules.role) ? byDiscount : rules.role;
}

export const PROPOSAL_STATUSES = ["DRAFT", "APPROVAL_REQUIRED", "SUBMITTED", "PARTIALLY_APPROVED", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "EXPIRED", "WON", "LOST"] as const;

/** Derive proposal approval status from its open requests (submitted proposals only). */
export function proposalStatusFrom(requests: { status: string }[]): "APPROVED" | "PARTIALLY_APPROVED" | "SUBMITTED" | "REJECTED" | "CHANGES_REQUESTED" {
  const live = requests.filter((r) => r.status !== "WITHDRAWN" && r.status !== "EXPIRED");
  if (live.some((r) => r.status === "REJECTED")) return "REJECTED";
  if (live.some((r) => r.status === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  const pending = live.filter((r) => r.status === "PENDING").length;
  if (pending === 0) return "APPROVED";
  return pending === live.length ? "SUBMITTED" : "PARTIALLY_APPROVED";
}

/** May this proposal be finalised (exported as a quote / pushed to CRM)? */
export function canFinalize(p: { status: string; validThrough?: Date | null; asOf?: Date; lines: { included: boolean; approvalState: string; proposedPrice: Money | null }[] }): { ok: boolean; reason: string } {
  const inc = p.lines.filter((l) => l.included);
  if (p.validThrough && (p.asOf ?? new Date()) > p.validThrough && p.status !== "WON") return { ok: false, reason: `proposal expired on ${p.validThrough.toISOString().slice(0, 10)}; create a new version` };
  if (!inc.length) return { ok: false, reason: "no lines included" };
  if (inc.some((l) => l.proposedPrice === null)) return { ok: false, reason: `${inc.filter((l) => l.proposedPrice === null).length} included line(s) have no proposed price` };
  const unresolved = inc.filter((l) => l.approvalState === "REQUIRED" || l.approvalState === "PENDING" || l.approvalState === "REJECTED");
  if (unresolved.length) return { ok: false, reason: `${unresolved.length} line(s) awaiting or denied approval` };
  if (!["APPROVED", "WON"].includes(p.status)) return { ok: false, reason: `proposal is ${p.status.toLowerCase().replace(/_/g, " ")}; submit it for approval first` };
  return { ok: true, reason: "all included lines priced and approved" };
}

import type { ReactNode } from "react";

export const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-line-2 text-muted", APPROVAL_REQUIRED: "bg-alt-soft text-alt", SUBMITTED: "bg-info-soft text-info", PARTIALLY_APPROVED: "bg-info-soft text-info",
  APPROVED: "bg-exact-soft text-exact", REJECTED: "bg-none-soft text-none", CHANGES_REQUESTED: "bg-alt-soft text-alt", EXPIRED: "bg-line-2 text-muted", WON: "bg-exact-soft text-exact", LOST: "bg-none-soft text-none",
  PENDING: "bg-alt-soft text-alt", REQUIRED: "bg-alt-soft text-alt", NOT_REQUIRED: "bg-line-2 text-muted", ACTIVE: "bg-exact-soft text-exact", TERMINATED: "bg-none-soft text-none", SUPERSEDED: "bg-line-2 text-muted",
  PUBLISHED: "bg-exact-soft text-exact", IN_REVIEW: "bg-info-soft text-info", RETIRED: "bg-line-2 text-muted", VERIFIED: "bg-exact-soft text-exact", UNVERIFIED: "bg-line-2 text-muted", DISPUTED: "bg-none-soft text-none",
  KNOWN_ACCOUNT: "bg-exact-soft text-exact", MARKET_ESTIMATE: "bg-info-soft text-info", WEAK: "bg-alt-soft text-alt", NONE: "bg-line-2 text-muted",
  ON_TRACK: "bg-exact-soft text-exact", AT_RISK: "bg-alt-soft text-alt", MISSED: "bg-none-soft text-none", MET: "bg-exact-soft text-exact", NOT_STARTED: "bg-line-2 text-muted",
};

export function Pill({ value, children }: { value: string; children?: ReactNode }) {
  return <span className={`chip ${STATUS_TONE[value] ?? "bg-line-2 text-muted"}`}>{children ?? value.replace(/_/g, " ").toLowerCase()}</span>;
}

export function ProposalStatus({ status, pending }: { status: string; pending?: number }) {
  return <span className="inline-flex items-center gap-1.5"><Pill value={status} />{pending ? <span className="text-[11px] text-alt">{pending} pending</span> : null}</span>;
}

export const fmtMoney = (v: string | number | null | undefined, currency = "USD", opts: { compact?: boolean } = {}) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v); if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: opts.compact ? 0 : 2, notation: opts.compact && Math.abs(n) >= 100000 ? "compact" : "standard" }).format(n);
};
export const fmtPct = (v: string | number | null | undefined, digits = 1) => { if (v === null || v === undefined || v === "") return "—"; const n = Number(v); return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—"; };
export const label = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "—");

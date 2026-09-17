import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 mb-6">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink leading-tight">{title}</h1>
        {description && <p className="text-muted mt-1.5 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "", title, subtitle, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-line-2">
          <div>
            <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
            {subtitle && <p className="text-[12px] text-muted mt-0.5">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "exact" | "close" | "alt" | "none" | "accent" }) {
  const color = tone === "exact" ? "text-exact" : tone === "close" ? "text-close" : tone === "alt" ? "text-alt" : tone === "none" ? "text-none" : tone === "accent" ? "text-accent" : "text-ink";
  return (
    <div className="card px-4 py-3.5">
      <div className="eyebrow">{label}</div>
      <div className={`mono text-[24px] font-semibold tracking-tight mt-1 ${color}`}>{value}</div>
      {hint && <div className="text-[12px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

export const MATCH_TONE: Record<string, { chip: string; dot: string; label: string }> = {
  "Exact Match": { chip: "bg-exact-soft text-exact", dot: "bg-exact", label: "Exact" },
  "Close Match": { chip: "bg-close-soft text-close", dot: "bg-close", label: "Close" },
  "Alternative Match": { chip: "bg-alt-soft text-alt", dot: "bg-alt", label: "Alternative" },
  "US Downsell Match": { chip: "bg-alt-soft text-alt", dot: "bg-alt", label: "Downsell" },
  "No Match": { chip: "bg-none-soft text-none", dot: "bg-none", label: "No match" },
  "Not Found": { chip: "bg-line-2 text-muted", dot: "bg-faint", label: "Not found" },
};

export function MatchChip({ type, full = false }: { type: string; full?: boolean }) {
  const t = MATCH_TONE[type] ?? MATCH_TONE["No Match"];
  return (
    <span className={`chip ${t.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {full ? type : t.label}
    </span>
  );
}

export function Chip({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: "neutral" | "accent" | "info" | "alt" | "none" | "exact"; className?: string }) {
  const cls = { neutral: "bg-line-2 text-ink-2", accent: "bg-accent-soft text-accent-ink", info: "bg-info-soft text-info", alt: "bg-alt-soft text-alt", none: "bg-none-soft text-none", exact: "bg-exact-soft text-exact" }[tone];
  return <span className={`chip ${cls} ${className}`}>{children}</span>;
}

export function ScoreBar({ value, tone = "accent", width = 64 }: { value: number | null | undefined; tone?: string; width?: number }) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  const color = tone === "exact" ? "bg-exact" : tone === "alt" ? "bg-alt" : tone === "none" ? "bg-none" : "bg-accent";
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <span className="h-1.5 rounded-full bg-line-2 overflow-hidden" style={{ width }}>
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${v * 100}%` }} />
      </span>
      <span className="mono text-[12px] text-ink-2 w-8 text-right">{value == null ? "—" : `${Math.round(v * 100)}%`}</span>
    </span>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="text-center py-14 px-6">
      {icon && <div className="mx-auto mb-3 text-faint">{icon}</div>}
      <div className="text-[14px] font-medium text-ink">{title}</div>
      {children && <div className="text-muted mt-1 text-[13px]">{children}</div>}
    </div>
  );
}

export function money(v: number | string | null | undefined, opts: { compact?: boolean } = {}) {
  const n = typeof v === "string" ? Number(v) : v;
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: opts.compact ? 0 : 2, notation: opts.compact && Math.abs(n) >= 100000 ? "compact" : "standard" }).format(n);
}

export function num(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

export function relTime(d: string | Date) {
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    complete: "bg-exact-soft text-exact",
    running: "bg-info-soft text-info",
    queued: "bg-info-soft text-info",
    failed: "bg-none-soft text-none",
    cancelled: "bg-alt-soft text-alt",
    draft: "bg-line-2 text-muted",
  };
  return (
    <span className={`chip ${map[status] ?? map.draft}`}>
      {status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-info pulse-dot" />}
      {status[0].toUpperCase() + status.slice(1)}
    </span>
  );
}

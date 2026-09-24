"use client";

import Link from "next/link";
import { NotificationsBell } from "./notifications-bell";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { DevSignIn, type ActorInfo } from "./dev-signin";

export type NavItem = { href: string; label: string; icon: (p: IconProps) => React.JSX.Element; perm?: string; section?: string };
export const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: IconGrid },
  { href: "/requests", label: "Cross-reference", icon: IconInbox, perm: "run_cross_reference" },
  { href: "/proposals", label: "Proposals", icon: IconDoc, perm: "view_pricing" },
  { href: "/approvals", label: "Deal desk", icon: IconCheck, perm: "approve_discount" },
  { href: "/accounts", label: "Accounts", icon: IconBuilding, perm: "view_pricing", section: "Commercial" },
  { href: "/contracts", label: "Contracts", icon: IconContract, perm: "view_pricing" },
  { href: "/intelligence", label: "Competitor pricing", icon: IconRadar, perm: "view_pricing" },
  { href: "/intelligence/bids", label: "Public bids", icon: IconRadar, perm: "view_pricing" },
  { href: "/analytics", label: "Analytics", icon: IconChart, perm: "view_analytics" },
  { href: "/catalog", label: "Our catalog", icon: IconBox, section: "Reference" },
  { href: "/catalog/gudid", label: "GUDID library", icon: IconSearch },
  { href: "/crosses", label: "Crosswalk", icon: IconLink },
  { href: "/settings", label: "Settings", icon: IconSliders },
];

/** The entries a person with these permissions / roles sees, in sidebar order. */
export function visibleNav(permissions: Iterable<string>, roles: Iterable<string> = []): NavItem[] {
  const perms = new Set(permissions);
  const admin = new Set(roles).has("ADMIN");
  return NAV.filter((n) => !n.perm || perms.has(n.perm) || admin);
}

/**
 * Group nav entries under their section headings ("Commercial", "Reference"). An item without
 * a `section` belongs to the group opened by the previous heading (or the unlabelled first
 * group), so a heading is rendered only when at least one of its items survived filtering.
 */
export function groupNav(items: NavItem[], all: NavItem[] = NAV): { section: string | null; items: NavItem[] }[] {
  const groups: { section: string | null; items: NavItem[] }[] = [];
  let current: string | null = null;
  for (const n of all) {
    if (n.section) current = n.section;
    if (!items.includes(n)) continue;
    const last = groups[groups.length - 1];
    if (last && last.section === current) last.items.push(n); else groups.push({ section: current, items: [n] });
  }
  return groups;
}

export function Sidebar({ companyName, llm, actor, sso }: { companyName: string; llm: { available: boolean; model: string }; actor: ActorInfo | null; sso: "none" | "oidc" | "proxy" }) {
  const path = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const perms = new Set(actor?.permissions ?? []);
  const groups = groupNav(visibleNav(perms, actor?.roles ?? []));
  const isActive = (n: NavItem) => (n.href === "/" ? path === "/" : path === n.href || (path.startsWith(n.href + "/") && !NAV.some((o) => o.href !== n.href && o.href.startsWith(n.href) && path.startsWith(o.href))));
  const renderItem = (n: NavItem) => {
    const active = isActive(n);
    return (
      <Link
        key={n.href}
        href={n.href}
        aria-current={active ? "page" : undefined}
        onClick={() => setMenuOpen(false)}
        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${active ? "bg-white/10 text-white" : "text-sidebar-ink hover:bg-white/5 hover:text-white"}`}
      >
        <n.icon className={`h-4 w-4 ${active ? "text-accent-soft-2" : "text-sidebar-muted"}`} />
        {n.label}
      </Link>
    );
  };
  return (
    <aside className="w-full md:w-[232px] shrink-0 bg-sidebar text-sidebar-ink flex flex-col md:sticky md:top-0 md:h-screen">
      <div className="px-5 pt-4 pb-4 md:pt-6 md:pb-5 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-white leading-none">Crosswalk</div>
            <div className="text-[10.5px] text-sidebar-muted mt-1 tracking-wide uppercase">Competitor Product Cross Reference</div>
          </div>
        </Link>
        <button type="button" className="md:hidden rounded-lg border border-white/15 px-2.5 py-1.5 text-[12px] text-white" aria-expanded={menuOpen} aria-controls="sidebar-nav" onClick={() => setMenuOpen((v) => !v)}>
          {menuOpen ? "Close" : "Menu"}
        </button>
      </div>
      <div id="sidebar-nav" className={`${menuOpen ? "flex" : "hidden"} md:flex flex-col flex-1 min-h-0`}>
        <nav aria-label="Main" className="px-3 flex flex-col gap-0.5 md:overflow-y-auto">
          {groups.map((g, i) => {
            const id = g.section ? `nav-section-${g.section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined;
            return g.section ? (
              <div key={g.section} role="group" aria-labelledby={id} className={i > 0 ? "mt-3" : ""}>
                <div id={id} className="eyebrow !text-sidebar-muted px-2.5 pb-1 text-[10.5px]">{g.section}</div>
                {g.items.map(renderItem)}
              </div>
            ) : (
              <div key={`group-${i}`} className={i > 0 ? "mt-3" : ""}>{g.items.map(renderItem)}</div>
            );
          })}
          <NotificationsBell signedIn={Boolean(actor)} />
        </nav>
        {perms.has("run_cross_reference") && (
          <div className="px-3 mt-4">
            <Link href="/requests/new" className="btn-primary w-full justify-center" onClick={() => setMenuOpen(false)}>
              <IconPlus className="h-4 w-4" /> New request
            </Link>
          </div>
        )}
        <div className="mt-auto px-3 pb-3 pt-4">
          <DevSignIn actor={actor} sso={sso} />
        </div>
        <div className="px-5 pb-5 text-[11.5px] text-sidebar-muted space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${llm.available ? "bg-exact" : "bg-alt"}`} aria-hidden />
            <span className="truncate">{llm.available ? `Model: ${llm.model}` : "Heuristic mode · no model key"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-exact" aria-hidden />
            <span>openFDA · GUDID mirror</span>
          </div>
          <div className="pt-1 text-sidebar-muted">Deployed for {companyName}</div>
        </div>
      </div>
    </aside>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
      <rect x="1" y="1" width="26" height="26" rx="7" fill="#0E6B6B" />
      <path d="M8 14h5M15 14h5" stroke="#E3F1EF" strokeWidth="2" strokeLinecap="round" />
      <circle cx="8" cy="9" r="2" fill="#E3F1EF" />
      <circle cx="20" cy="19" r="2" fill="#E3F1EF" />
      <path d="M8 11v3M20 14v3" stroke="#E3F1EF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type IconProps = { className?: string };
function IconGrid({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" /><rect x="3" y="11" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" /></svg>);
}
function IconInbox({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 11l2.2-6h9.6L17 11v5H3v-5z" /><path d="M3 11h4l1.5 2h3L13 11h4" /></svg>);
}
function IconBox({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3l7 3.5v7L10 17l-7-3.5v-7L10 3z" /><path d="M3 6.5l7 3.5 7-3.5M10 10v7" /></svg>);
}
function IconLink({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8.5 11.5l3-3" /><path d="M7 13l-1 1a2.8 2.8 0 01-4-4l2.5-2.5a2.8 2.8 0 014 0" /><path d="M13 7l1-1a2.8 2.8 0 014 4l-2.5 2.5a2.8 2.8 0 01-4 0" /></svg>);
}
function IconSliders({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h12M4 10h12M4 14h12" /><circle cx="8" cy="6" r="1.6" fill="currentColor" /><circle cx="13" cy="10" r="1.6" fill="currentColor" /><circle cx="7" cy="14" r="1.6" fill="currentColor" /></svg>);
}
function IconDoc({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3M8 10h4M8 13h4" /></svg>);
}
function IconCheck({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="10" cy="10" r="7" /><path d="M7 10l2 2 4-4" /></svg>);
}
function IconBuilding({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="3" width="12" height="14" rx="1.5" /><path d="M7 7h2M11 7h2M7 10h2M11 10h2M8 17v-3h4v3" /></svg>);
}
function IconContract({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 3h10v14H5z" /><path d="M8 7h4M8 10h4M8 13h2" /></svg>);
}
function IconSearch({ className }: IconProps) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></svg>
  );
}
function IconRadar({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><path d="M10 10l5-5" /></svg>);
}
function IconChart({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 16V9M9 16V5M14 16v-6" /><path d="M3 17h14" /></svg>);
}
export function IconPlus({ className }: IconProps) {
  return (<svg aria-hidden className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 4v12M4 10h12" strokeLinecap="round" /></svg>);
}

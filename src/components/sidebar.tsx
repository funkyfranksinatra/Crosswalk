"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview", icon: IconGrid },
  { href: "/requests", label: "Requests", icon: IconInbox },
  { href: "/catalog", label: "Our catalog", icon: IconBox },
  { href: "/crosses", label: "Known crosses", icon: IconLink },
  { href: "/settings", label: "Settings", icon: IconSliders },
];

export function Sidebar({ companyName, llm }: { companyName: string; llm: { available: boolean; model: string } }) {
  const path = usePathname();
  return (
    <aside className="w-[232px] shrink-0 bg-sidebar text-sidebar-ink flex flex-col sticky top-0 h-screen">
      <div className="px-5 pt-6 pb-5">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-white leading-none">CRACR</div>
            <div className="text-[10.5px] text-sidebar-muted mt-1 tracking-wide uppercase">Cross Reference</div>
          </div>
        </Link>
      </div>
      <nav className="px-3 flex flex-col gap-0.5">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${active ? "bg-white/10 text-white" : "text-sidebar-ink hover:bg-white/5 hover:text-white"}`}
            >
              <n.icon className={`h-4 w-4 ${active ? "text-accent-soft-2" : "text-sidebar-muted"}`} />
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-3 mt-4">
        <Link href="/requests/new" className="btn-primary w-full justify-center">
          <IconPlus className="h-4 w-4" /> New request
        </Link>
      </div>
      <div className="mt-auto px-5 pb-5 text-[11.5px] text-sidebar-muted space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${llm.available ? "bg-exact" : "bg-alt"}`} />
          <span className="truncate">{llm.available ? `Model: ${llm.model}` : "Heuristic mode · no model key"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-exact" />
          <span>openFDA · GUDID mirror</span>
        </div>
        <div className="pt-1 text-sidebar-muted/70">Deployed for {companyName}</div>
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
  return (<svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" /><rect x="3" y="11" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" /></svg>);
}
function IconInbox({ className }: IconProps) {
  return (<svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 11l2.2-6h9.6L17 11v5H3v-5z" /><path d="M3 11h4l1.5 2h3L13 11h4" /></svg>);
}
function IconBox({ className }: IconProps) {
  return (<svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3l7 3.5v7L10 17l-7-3.5v-7L10 3z" /><path d="M3 6.5l7 3.5 7-3.5M10 10v7" /></svg>);
}
function IconLink({ className }: IconProps) {
  return (<svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8.5 11.5l3-3" /><path d="M7 13l-1 1a2.8 2.8 0 01-4-4l2.5-2.5a2.8 2.8 0 014 0" /><path d="M13 7l1-1a2.8 2.8 0 014 4l-2.5 2.5a2.8 2.8 0 01-4 0" /></svg>);
}
function IconSliders({ className }: IconProps) {
  return (<svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h12M4 10h12M4 14h12" /><circle cx="8" cy="6" r="1.6" fill="currentColor" /><circle cx="13" cy="10" r="1.6" fill="currentColor" /><circle cx="7" cy="14" r="1.6" fill="currentColor" /></svg>);
}
export function IconPlus({ className }: IconProps) {
  return (<svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 4v12M4 10h12" strokeLinecap="round" /></svg>);
}

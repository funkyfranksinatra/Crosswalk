"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

/** Unread count in the sidebar; polls every 30 s (only while the tab is visible). */
export function NotificationsBell({ signedIn }: { signedIn: boolean }) {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try { const r = await fetch("/api/notifications?unread=1&take=1", { cache: "no-store" }); if (r.ok && !stop) setUnread((await r.json()).unread ?? 0); } catch { /* offline: keep the last value */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [signedIn]);
  if (!signedIn) return null;
  return (
    <Link href="/notifications" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-sidebar-ink hover:bg-white/5 hover:text-white transition-colors">
      <svg className="h-4 w-4 text-sidebar-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
      Notifications
      {unread ? <span className="ml-auto rounded-full bg-accent text-white text-[10.5px] font-semibold px-1.5 py-0.5 leading-none">{unread > 99 ? "99+" : unread}</span> : null}
    </Link>
  );
}

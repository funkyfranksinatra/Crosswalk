"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "As of" line for the materialised analytics, with a refresh that recomputes every report. */
export function RefreshAnalytics({ asOf, stale, source }: { asOf: string; stale: boolean; source: "snapshot" | "live" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function refresh() {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await fetch("/api/analytics/all", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? "Refresh failed"); return; }
      if (j.queued) { setNote(j.note); setTimeout(() => router.refresh(), 8000); } else router.refresh();
    } catch { setErr("Refresh failed"); } finally { setBusy(false); }
  }
  const when = new Date(asOf);
  return (
    <div className={`flex items-center gap-3 text-[12.5px] mb-4 rounded-lg px-3 py-2 ${stale ? "bg-alt-soft text-alt" : "bg-panel-2 text-muted"}`}>
      <span>{source === "live" ? "Computed just now" : `As of ${when.toLocaleString()}`}{stale ? " — older than the freshness window; refresh for current numbers" : ""}</span>
      <button type="button" className="btn-ghost !py-0.5 text-[12px] ml-auto" onClick={refresh} disabled={busy}>{busy ? "Recomputing…" : "Refresh"}</button>
      {note && <span className="text-muted">{note}</span>}
      {err && <span className="text-none">{err}</span>}
    </div>
  );
}

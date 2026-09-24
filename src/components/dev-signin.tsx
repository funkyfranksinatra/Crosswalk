"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type ActorInfo = { id: string; name: string; email: string; roles: string[]; permissions: string[]; isDev: boolean };
type DevUser = { id: string; name: string; email: string; roles: string[] };

/**
 * Development sign-in — unmistakably labelled. Lists the seeded users and sets the
 * dev cookie. Renders nothing but the signed-in identity when SSO is configured.
 *
 * The user list is fetched when the box is opened, not on every page load: /api/auth/* is
 * rate limited to 20 requests a minute per client, and a list fetched on each navigation
 * used to exhaust that budget and make the next sign-in fail with 429.
 */
export function DevSignIn({ actor, sso }: { actor: ActorInfo | null; sso: "none" | "oidc" | "proxy" }) {
  const router = useRouter();
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (sso !== "none" || !open || users) return;
    let stop = false;
    fetch("/api/auth/dev").then(async (r) => { if (stop) return; if (!r.ok) { setErr(r.status === 429 ? "Too many sign-in requests — wait a minute and try again" : `Could not list users (${r.status})`); return; } setUsers(await r.json()); }).catch(() => { if (!stop) setErr("Could not reach the server"); });
    return () => { stop = true; };
  }, [sso, open, users]);
  async function pick(userId: string) {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      if (!r.ok) { setErr(r.status === 429 ? "Too many sign-in requests — wait a minute and try again" : ((await r.json().catch(() => ({}))).error ?? `Sign-in failed (${r.status})`)); return; }
      setOpen(false); router.refresh();
    } catch { setErr("Could not reach the server"); } finally { setBusy(false); }
  }
  async function signOut() {
    try { await fetch("/api/auth/dev", { method: "DELETE" }); } catch { /* the refresh shows the real state */ }
    setOpen(false); router.refresh();
  }
  async function ssoSignOut() {
    const r = await fetch("/api/auth/oidc/logout", { method: "POST" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const to = typeof r?.redirect === "string" ? r.redirect : "/";
    if (to.startsWith("/")) { router.replace(to); router.refresh(); } else window.location.assign(to);
  }
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-2.5 text-[12px]">
      {actor ? (
        <>
          <div className="text-white font-medium truncate">{actor.name}</div>
          <div className="text-sidebar-muted truncate">{actor.roles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}</div>
        </>
      ) : (
        <div className="text-white">Not signed in</div>
      )}
      {sso === "none" && (
        <div className="mt-2">
          <div className="text-[10.5px] uppercase tracking-wide text-[#e0a83a] mb-1" id="dev-signin-label">Development sign-in</div>
          {open ? (
            <div className="max-h-56 overflow-auto space-y-0.5" role="group" aria-labelledby="dev-signin-label">
              {err && <div role="alert" className="text-alt px-2 py-1">{err}</div>}
              {!users && !err && <div className="text-sidebar-muted px-2 py-1">Loading users…</div>}
              {(users ?? []).map((u) => (
                <button key={u.id} type="button" disabled={busy} onClick={() => pick(u.id)} aria-current={actor?.id === u.id ? "true" : undefined} className={`block w-full text-left rounded px-2 py-1 hover:bg-white/10 ${actor?.id === u.id ? "bg-white/10 text-white" : "text-sidebar-ink"}`}>{u.name}</button>
              ))}
              {actor && <button type="button" onClick={signOut} className="block w-full text-left rounded px-2 py-1 text-none hover:bg-white/10">Sign out</button>}
              <button type="button" onClick={() => setOpen(false)} className="block w-full text-left rounded px-2 py-1 text-sidebar-muted hover:bg-white/10">Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setOpen(true)} aria-expanded={open} className="btn-secondary w-full justify-center !py-1 !text-[12px]">{actor ? "Switch user" : "Choose a user"}</button>
          )}
        </div>
      )}
      {sso === "oidc" && (actor ? <button type="button" onClick={ssoSignOut} className="btn-secondary w-full justify-center !py-1 !text-[12px] mt-2">Sign out</button> : <a href="/api/auth/oidc/start" className="btn-secondary w-full justify-center !py-1 !text-[12px] mt-2">Sign in with SSO</a>)}
      {sso === "proxy" && <div className="mt-1 text-sidebar-muted">SSO session (managed by your sign-in proxy)</div>}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type ActorInfo = { id: string; name: string; email: string; roles: string[]; permissions: string[]; isDev: boolean };
type DevUser = { id: string; name: string; email: string; roles: string[] };

/**
 * Development sign-in — unmistakably labelled. Lists the seeded users and sets the
 * dev cookie. Renders nothing but the signed-in identity when SSO is configured.
 */
export function DevSignIn({ actor, sso }: { actor: ActorInfo | null; sso: boolean }) {
  const router = useRouter();
  const [users, setUsers] = useState<DevUser[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!sso) fetch("/api/auth/dev").then((r) => (r.ok ? r.json() : [])).then(setUsers).catch(() => setUsers([])); }, [sso]);
  async function pick(userId: string) {
    await fetch("/api/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
    setOpen(false); router.refresh();
  }
  async function signOut() { await fetch("/api/auth/dev", { method: "DELETE" }); router.refresh(); }
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
      {!sso && (
        <div className="mt-2">
          <div className="text-[10.5px] uppercase tracking-wide text-alt/90 mb-1">Development sign-in</div>
          {open ? (
            <div className="max-h-56 overflow-auto space-y-0.5">
              {users.map((u) => (
                <button key={u.id} onClick={() => pick(u.id)} className={`block w-full text-left rounded px-2 py-1 hover:bg-white/10 ${actor?.id === u.id ? "bg-white/10 text-white" : "text-sidebar-ink"}`}>{u.name}</button>
              ))}
              {actor && <button onClick={signOut} className="block w-full text-left rounded px-2 py-1 text-none hover:bg-white/10">Sign out</button>}
            </div>
          ) : (
            <button onClick={() => setOpen(true)} className="btn-secondary w-full justify-center !py-1 !text-[12px]">{actor ? "Switch user" : "Choose a user"}</button>
          )}
        </div>
      )}
      {sso && <div className="mt-1 text-sidebar-muted">SSO session</div>}
    </div>
  );
}

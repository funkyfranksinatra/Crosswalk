"use client";

/**
 * The signed-in actor's permissions, for client views that gate their own controls.
 *
 * The root layout resolves the actor once (server side) and hands the permission set down
 * through this provider, so a client component can hide or disable a control that the API
 * would refuse anyway (KN-09). This is presentation only: every route still authorises on
 * its own, and nothing here widens what the server allows.
 */
import { createContext, useContext, type ReactNode } from "react";

export type ActorSummary = { id: string; name: string; roles: string[]; permissions: string[] } | null;

const Ctx = createContext<ActorSummary>(null);

export function PermissionsProvider({ actor, children }: { actor: ActorSummary; children: ReactNode }) {
  return <Ctx.Provider value={actor}>{children}</Ctx.Provider>;
}

export type Perms = {
  actor: ActorSummary;
  signedIn: boolean;
  isAdmin: boolean;
  /** True when the actor holds the permission (ADMIN holds every permission by construction). */
  can: (perm: string) => boolean;
  hasRole: (role: string) => boolean;
};

export function usePermissions(): Perms {
  const actor = useContext(Ctx);
  const perms = new Set(actor?.permissions ?? []);
  const roles = new Set(actor?.roles ?? []);
  return {
    actor,
    signedIn: Boolean(actor),
    isAdmin: roles.has("ADMIN"),
    can: (perm) => perms.has(perm),
    hasRole: (role) => roles.has(role),
  };
}

/** Human wording for a disabled control: "Needs the manage contracts permission". */
export function needs(perm: string): string {
  return `Needs the ${perm.replace(/_/g, " ")} permission`;
}

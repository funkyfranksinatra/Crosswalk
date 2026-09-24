/**
 * WS4 — authorization matrix over EVERY route-method pair (item E), plus the scope hook (F),
 * KN-02 / KN-07 / KN-08 behaviour and item K (delegation revoke, audit scoping).
 *
 * Every handler is called in-process (tests/db/ws4-harness.ts) as: anonymous, each of the 11
 * seeded roles, and — for the rep's book of business — the owning SALES_REP versus a second
 * SALES_REP in another territory. The harness hands each handler the headers the proxy would
 * forward, so the ownership-scope hook sees the path exactly as in production. The recorded statuses are written to
 * docs/debug-runs/…/evidence/ws4/authz-matrix.csv.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { setActorForTests } from "../setup";
import { enumerateRoutes, gateFor, callRoute, seededActors, buildFixtures, cleanupFixtures, SIDE_EFFECT_ROUTES, type RouteInfo, type Method, type Fixtures } from "./ws4-harness";
import { ROLES, permissionsFor } from "@/lib/auth/permissions";
import { enforceScopeForPath } from "@/lib/auth/scope";
import type { Actor } from "@/lib/auth";


const hasDb = Boolean(process.env.DATABASE_URL);
const EVIDENCE = path.resolve(__dirname, "../../docs/debug-runs/2026-09-24-full-application/evidence/ws4");
const FORM_ROUTES = /\/(import|upload|extract|preview)$|^\/api\/requests$/;
/** Session-gated handlers that decide inside: ADMIN-only exports. */
const ADMIN_INSIDE = new Set(["GET /api/observability/export"]);
const OPEN_AT_PROXY = (r: RouteInfo, m: Method) => r.urlPath.startsWith("/api/auth/") || r.urlPath === "/api/health" || r.urlPath === "/api/metrics" || (r.urlPath === "/api/webhooks/salesforce" && m === "POST");

type Row = { route: string; method: string; gate: string; actor: string; status: number | string; note: string };
const rows: Row[] = [];
const record = (r: RouteInfo, m: Method, actor: string, status: number | string, note = "") => rows.push({ route: r.urlPath, method: m, gate: gateLabel(gateFor(r, m)), actor, status, note });
const gateLabel = (g: ReturnType<typeof gateFor>) => (g.kind === "perm" ? g.any.join("|") : g.kind);

async function call(r: RouteInfo, m: Method, ids: Record<string, string> = {}, init: Parameters<typeof callRoute>[3] = {}): Promise<number | string> {
  const opts = { ...init };
  if (m !== "GET" && FORM_ROUTES.test(r.urlPath) && !opts.form) opts.form = {};
  try { return (await callRoute(r, m, ids, opts)).status; } catch (e) { return `THROW:${(e as Error).constructor.name}:${(e as Error).message.slice(0, 80)}`; }
}

describe.skipIf(!hasDb)("WS4 — authorization matrix (every route × every role)", () => {
  const routes = enumerateRoutes();
  let seeded: Record<string, Actor>;
  let fx: Fixtures | null = null;

  beforeAll(async () => { seeded = await seededActors(); fx = await buildFixtures(seeded); });
  afterAll(async () => {
    setActorForTests(null);
    await cleanupFixtures(fx);
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const csv = ["route,method,gate,actor,status,note", ...rows.map((r) => [r.route, r.method, r.gate, r.actor, r.status, r.note].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    fs.writeFileSync(path.join(EVIDENCE, "authz-matrix.csv"), csv + "\n");
  });

  test("the filesystem yields 101 route files and 132 method handlers, every one with a recognisable gate", () => {
    expect(routes).toHaveLength(101);
    expect(routes.reduce((n, r) => n + r.methods.length, 0)).toBe(132);
    const custom = routes.flatMap((r) => r.methods.filter((m) => gateFor(r, m).kind === "custom").map((m) => `${m} ${r.urlPath}`)).sort();
    // The only handlers without handle()/authorize(): the sign-in routes, liveness, the token-guarded scrape and the HMAC-guarded webhook.
    expect(custom).toEqual(["DELETE /api/auth/dev", "GET /api/auth/dev", "GET /api/auth/me", "GET /api/auth/oidc/callback", "GET /api/auth/oidc/start", "GET /api/health", "GET /api/metrics", "POST /api/auth/dev", "POST /api/auth/oidc/logout", "POST /api/webhooks/salesforce"]);
    const sessionOnly = routes.flatMap((r) => r.methods.filter((m) => gateFor(r, m).kind === "session").map((m) => `${m} ${r.urlPath}`)).sort();
    // handle(null): any signed-in user. Each is justified in the WS4 report (own notifications, own settings view, status reads, per-item permission inside the handler).
    expect(sessionOnly).toEqual(["GET /api/catalog/gudid", "GET /api/catalog/gudid/[id]", "GET /api/google", "GET /api/notifications", "GET /api/notifications/preferences", "GET /api/observability/export", "GET /api/settings", "PATCH /api/notifications/preferences", "POST /api/integrations/review/[id]", "POST /api/notifications"]);
  });

  test("anonymous: 401 everywhere except the proxy's open list (whose handlers guard themselves)", async () => {
    setActorForTests(null);
    const wrong: string[] = [];
    for (const r of routes) for (const m of r.methods) {
      const status = await call(r, m);
      record(r, m, "anonymous", status);
      if (OPEN_AT_PROXY(r, m)) {
        if (r.urlPath === "/api/metrics" && status !== 401) wrong.push(`${m} ${r.urlPath} → ${status} (metrics must refuse without token/ADMIN)`);
        if (r.urlPath === "/api/health" && status !== 200) wrong.push(`${m} ${r.urlPath} → ${status}`);
        if (r.urlPath === "/api/webhooks/salesforce" && ![401, 403, 404].includes(Number(status))) wrong.push(`${m} ${r.urlPath} → ${status} (webhook must refuse an unsigned body)`);
      } else if (status !== 401) wrong.push(`${m} ${r.urlPath} → ${status}`);
    }
    expect(wrong).toEqual([]);
  });

  test("each of the 11 roles: 403 exactly when the permission is missing; never 401/403 otherwise; never a 5xx or a thrown error", async () => {
    const wrong: string[] = [];
    for (const role of ROLES) {
      const actor = seeded[role];
      setActorForTests(actor);
      const perms = permissionsFor([role]);
      for (const r of routes) for (const m of r.methods) {
        const gate = gateFor(r, m);
        const key = `${m} ${r.urlPath}`;
        const allowed = gate.kind === "custom" ? null : ADMIN_INSIDE.has(key) ? role === "ADMIN" : gate.kind === "session" ? true : gate.any.some((p) => perms.has(p));
        if (allowed && SIDE_EFFECT_ROUTES.has(key)) { record(r, m, role, "skip", "side-effecting when authorized; not invoked"); continue; }
        const status = await call(r, m);
        record(r, m, role, status, allowed === null ? "custom gate" : allowed ? "expected pass" : "expected 403");
        if (typeof status === "string") { wrong.push(`${key} as ${role} threw: ${status}`); continue; }
        if (allowed === false && status !== 403) wrong.push(`${key} as ${role} → ${status}, expected 403`);
        if (allowed === true && (status === 401 || status === 403)) wrong.push(`${key} as ${role} → ${status}, expected pass`);
        if (status >= 500) wrong.push(`${key} as ${role} → ${status} (server error on an authorized call)`);
        if (allowed === null) {
          if (r.urlPath === "/api/metrics" && status !== (role === "ADMIN" ? 200 : 401)) wrong.push(`${key} as ${role} → ${status}`);
          if (r.urlPath === "/api/observability/export") { /* authorize(null) + ADMIN check inside, covered below */ }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("ADMIN-only inside a session gate: observability export and metrics refuse every other role", async () => {
    const exp = routes.find((r) => r.urlPath === "/api/observability/export")!;
    const met = routes.find((r) => r.urlPath === "/api/metrics")!;
    for (const role of ROLES) {
      setActorForTests(seeded[role]);
      expect([role, await call(exp, "GET", {}, { query: "?kind=alerts&limit=1" })]).toEqual([role, role === "ADMIN" ? 200 : 403]);
      expect([role, await call(met, "GET")]).toEqual([role, role === "ADMIN" ? 200 : 401]);
    }
  });

  test("KN-02: CLINICAL_REVIEWER (no view_pricing) reads /api/crosses and /api/crosswalk/versions; EXECUTIVE (view_pricing) still can; no price/cost/margin keys in either payload", async () => {
    const crosses = routes.find((r) => r.urlPath === "/api/crosses")!, versions = routes.find((r) => r.urlPath === "/api/crosswalk/versions")!;
    for (const role of ["CLINICAL_REVIEWER", "PRODUCT_MARKETING", "EXECUTIVE", "SALES_REP"]) {
      setActorForTests(seeded[role]);
      const a = await callRoute(crosses, "GET", {}, { query: "?status=IN_REVIEW" }), b = await callRoute(versions, "GET");
      expect([role, a.status, b.status]).toEqual([role, 200, 200]);
      const text = (await a.text()) + (await b.text());
      expect(text).not.toMatch(/"(price|listPrice|unitPrice|cost|cogs|floorPrice|margin[A-Za-z]*)"\s*:/i);
    }
    // a role with none of the three is still refused (no permission)
    const noPerm: Actor = { ...seeded.CLINICAL_REVIEWER, roles: [], permissions: new Set() };
    setActorForTests(noPerm);
    expect((await callRoute(crosses, "GET")).status).toBe(403);
    expect((await callRoute(versions, "GET")).status).toBe(403);
    // PATCH /api/crosses/[id] stays manage_crosswalk; clinical status needs the clinical permission
    const patch = routes.find((r) => r.urlPath === "/api/crosses/[id]")!;
    setActorForTests(seeded.EXECUTIVE); expect((await callRoute(patch, "PATCH", {}, { body: { justification: "x" } })).status).toBe(403);
    setActorForTests(seeded.PRODUCT_MARKETING); expect((await callRoute(patch, "PATCH", {}, { body: { clinicalReviewStatus: "APPROVED" } })).status).toBe(400);
  });

  test("KN-07: GET /api/catalog/enrich needs manage_catalog (was open to any session)", async () => {
    const r = routes.find((x) => x.urlPath === "/api/catalog/enrich")!;
    setActorForTests(null); expect(await call(r, "GET")).toBe(401);
    setActorForTests(seeded.SALES_REP); expect(await call(r, "GET")).toBe(403);
    setActorForTests(seeded.CLINICAL_REVIEWER); expect(await call(r, "GET")).toBe(403);
    setActorForTests(seeded.PRODUCT_MARKETING); expect(await call(r, "GET")).toBe(200);
  });

  test("KN-08: PATCH /api/competitor/[id] — stranger rep 404 (no enumeration), owner ok (bin + embedding invalidated, audited), manage_catalog ok, EXECUTIVE 403", async () => {
    const r = routes.find((x) => x.urlPath === "/api/competitor/[id]")!;
    const ids = { id: fx!.competitorProductId };
    setActorForTests(fx!.stranger);
    expect(await call(r, "PATCH", ids, { body: { description: "hijacked" } })).toBe(404);
    expect(await call(r, "PATCH", { id: "clzzzzzzzzzzzzzzzzzzzzzz" }, { body: { description: "x" } })).toBe(404); // unknown id: the same answer
    expect((await prisma.competitorProduct.findUniqueOrThrow({ where: { id: ids.id } })).description).toBe("Rival stapler 45mm");
    setActorForTests(seeded.EXECUTIVE);
    expect(await call(r, "PATCH", ids, { body: { description: "x" } })).toBe(403);
    setActorForTests(fx!.owner);
    expect(await call(r, "PATCH", ids, { body: { description: 42 } })).toBe(400);
    expect(await call(r, "PATCH", ids, { body: {} })).toBe(400);
    expect(await call(r, "PATCH", ids, { body: { di: "../../etc" } })).toBe(400);
    const ok = await callRoute(r, "PATCH", ids, { body: { manufacturer: "Rival Surgical Inc", description: "Rival stapler 45mm blue" } });
    expect(ok.status).toBe(200);
    const after = await prisma.competitorProduct.findUniqueOrThrow({ where: { id: ids.id } });
    expect(after).toMatchObject({ description: "Rival stapler 45mm blue", resolution: "manual", confidence: 1, binJson: null, binSource: null, binnedAt: null, embeddingHash: null, embeddedAt: null });
    expect(await prisma.auditEvent.count({ where: { entityType: "CompetitorProduct", entityId: ids.id, action: "CORRECTED", actorUserId: fx!.owner.id } })).toBe(1);
    setActorForTests(seeded.PRODUCT_MARKETING);
    expect(await call(r, "PATCH", ids, { body: { description: "Rival stapler 45mm (marketing)" } })).toBe(200);
    expect(await prisma.auditEvent.count({ where: { entityType: "CompetitorProduct", entityId: ids.id, action: "CORRECTED" } })).toBe(2);
  });

  test("owner vs stranger on every /api/(accounts|requests|proposals|contracts)/[id]** route: stranger 404 wherever the permission allows the call (403 only when the permission itself is missing — the same answer for any id); owner never 401/403/404 on reads", async () => {
    const ids = { id: "", lineId: "", sid: fx!.scenarioId };
    const wrong: string[] = [];
    const scoped = routes.filter((r) => /^\/api\/(accounts|requests|proposals|contracts)\/\[id\]/.test(r.urlPath));
    expect(scoped.length).toBeGreaterThanOrEqual(27);
    for (const r of scoped) {
      const entity = r.urlPath.split("/")[2];
      const ent = { accounts: fx!.accountId, requests: fx!.requestId, proposals: fx!.proposalId, contracts: fx!.contractId }[entity]!;
      const lineId = entity === "requests" ? fx!.lineId : fx!.proposalLineId;
      for (const m of r.methods) {
        setActorForTests(fx!.stranger);
        const g = gateFor(r, m);
        const hasPerm = g.kind !== "perm" || g.any.some((p) => fx!.stranger.permissions.has(p));
        const s = await call(r, m, { ...ids, id: ent, lineId });
        record(r, m, "stranger-rep", s, hasPerm ? "expected 404" : "expected 403 (permission missing regardless of id)");
        if (s !== (hasPerm ? 404 : 403)) wrong.push(`${m} ${r.urlPath} as stranger → ${s}`);
        if (!hasPerm) { // the same 403 for an id that does not exist at all: no existence leak
          const s2 = await call(r, m, { ...ids, id: "clzzzzzzzzzzzzzzzzzzzzzz", lineId });
          if (s2 !== 403) wrong.push(`${m} ${r.urlPath} as stranger with unknown id → ${s2} (differs from ${s})`);
        }
        if (m === "GET") {
          setActorForTests(fx!.owner);
          const o = await call(r, m, { ...ids, id: ent, lineId }, { query: r.urlPath.endsWith("compare") ? `?candidateId=${fx!.candidateId}` : r.urlPath.endsWith("export") ? "?type=xref&format=csv" : "" });
          record(r, m, "owner-rep", o, "expected pass");
          if (o === 401 || o === 403 || o === 404 || Number(o) >= 500 || typeof o === "string") wrong.push(`${m} ${r.urlPath} as owner → ${o}`);
        }
      }
    }
    // the same ids through a non-scoped role are visible
    setActorForTests(seeded.PRICING_ANALYST);
    expect(await call(routes.find((r) => r.urlPath === "/api/proposals/[id]")!, "GET", { id: fx!.proposalId })).toBe(200);
    expect(wrong).toEqual([]);
  });

  test("scope hook (F): nested ids of other parents, invalid / encoded / duplicated-slash paths, trailing slashes and other methods", async () => {
    const owner = fx!.owner, stranger = fx!.stranger;
    const P = fx!.proposalId, R = fx!.requestId;
    // a line/scenario of another proposal: the hook checks the PARENT (stranger → 404), the handler checks the child belongs to it
    await expect(enforceScopeForPath(stranger, `/api/proposals/${P}/lines/${fx!.proposalLineId}`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(owner, `/api/proposals/${P}/lines/${fx!.proposalLineId}`)).resolves.toBeUndefined();
    const other = await prisma.proposal.findFirst({ where: { id: { not: P } }, select: { id: true } });
    if (other) {
      setActorForTests(owner);
      // owner's proposal id in the path, someone else's line id in the body/params → the handler's parent check refuses
      const lines = routes.find((r) => r.urlPath === "/api/proposals/[id]/lines/[lineId]")!;
      const foreignLine = await prisma.proposalLine.findFirst({ where: { proposalId: other.id }, select: { id: true } });
      if (foreignLine) expect(await call(lines, "PATCH", { id: P, lineId: foreignLine.id }, { body: { notes: "x" } })).toBe(404);
      const sc = routes.find((r) => r.urlPath === "/api/proposals/[id]/scenarios/[sid]")!;
      expect(await call(sc, "GET", { id: other.id, sid: fx!.scenarioId })).toBe(404); // other proposal not in the rep's book
      expect(await call(sc, "GET", { id: P, sid: "clzzzzzzzzzzzzzzzzzzzzzz" })).toBe(404);
    }
    const req = routes.find((r) => r.urlPath === "/api/requests/[id]/lines/[lineId]")!;
    setActorForTests(owner);
    expect(await call(req, "PATCH", { id: R, lineId: "clzzzzzzzzzzzzzzzzzzzzzz" }, { body: { reviewed: true } })).toBe(404);
    // invalid ids in the entity slot are 404, never a pass — for a scoped actor
    for (const bad of ["abc123", "x".repeat(41), "clzzzzzzzzzzzzzzzzzzzz;DROP", "%2e%2e", `${P}%00`, "renewals-but-too-long-to-be-a-word-x"]) await expect(enforceScopeForPath(stranger, `/api/proposals/${bad}`), bad).rejects.toMatchObject({ status: 404 });
    // words that are collection sub-routes pass through (the router decides what they are)
    for (const word of ["renewals", "sync", "a", "ab-cd"]) await expect(enforceScopeForPath(stranger, `/api/contracts/${word}`), word).resolves.toBeUndefined();
    // duplicate slashes and a trailing slash: the pattern still finds the id slot
    await expect(enforceScopeForPath(stranger, `/api/proposals/${P}/`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(stranger, `/api/proposals//${P}`)).rejects.toMatchObject({ status: 404 }); // "" is not a word → 404, never a pass
    await expect(enforceScopeForPath(stranger, `/API/Proposals/${P}`)).rejects.toMatchObject({ status: 404 }); // case-insensitive match
    // percent-encoded once → decoded and checked; double-encoded → not a valid id → 404
    const enc = P.slice(0, -1) + "%" + P.charCodeAt(P.length - 1).toString(16);
    await expect(enforceScopeForPath(stranger, `/api/proposals/${enc}`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(owner, `/api/proposals/${enc}`)).resolves.toBeUndefined();
    await expect(enforceScopeForPath(owner, `/api/proposals/${enc.replace("%", "%25")}`)).rejects.toMatchObject({ status: 404 });
    // the hook is method-agnostic: HEAD / OPTIONS map to the same GET handler in Next, the path is what is checked
    await expect(enforceScopeForPath(stranger, `/api/accounts/${fx!.accountId}/memberships`)).rejects.toMatchObject({ status: 404 });
    // no path header at all (proxy absent): the hook cannot decide and the handler's own checks apply — logged by src/lib/api.ts
    await expect(enforceScopeForPath(stranger, null)).resolves.toBeUndefined();
  });

  test("K: DELETE /api/approvals/delegations/[id] — only the delegating user or an ADMIN; anyone else sees 404 (not 403)", async () => {
    const r = routes.find((x) => x.urlPath === "/api/approvals/delegations/[id]")!;
    const ids = { id: fx!.delegationId };
    setActorForTests(fx!.stranger); // the delegate, not the delegator
    expect(await call(r, "DELETE", ids)).toBe(404);
    setActorForTests(seeded.PRICING_DIRECTOR);
    expect(await call(r, "DELETE", ids)).toBe(404);
    expect((await prisma.approvalDelegation.findUniqueOrThrow({ where: ids })).revokedAt).toBeNull();
    setActorForTests(seeded.CLINICAL_REVIEWER); // no view_pricing at all
    expect(await call(r, "DELETE", ids)).toBe(403);
    setActorForTests(fx!.owner);
    expect(await call(r, "DELETE", ids)).toBe(200);
    expect((await prisma.approvalDelegation.findUniqueOrThrow({ where: ids })).revokedAt).not.toBeNull();
    expect(await call(r, "DELETE", ids)).toBe(200); // idempotent
    setActorForTests(seeded.ADMIN);
    expect(await call(r, "DELETE", ids)).toBe(200);
    expect(await call(r, "DELETE", { id: "clzzzzzzzzzzzzzzzzzzzzzz" })).toBe(404);
  });

  test("K: GET /api/audit — a scoped rep must name an entity in their book; anything else is 404; unscoped roles read freely", async () => {
    const r = routes.find((x) => x.urlPath === "/api/audit")!;
    setActorForTests(fx!.owner);
    expect(await call(r, "GET")).toBe(404);
    expect(await call(r, "GET", {}, { query: "?entityType=User&entityId=" + fx!.owner.id })).toBe(404); // not a scopable entity type
    expect(await call(r, "GET", {}, { query: `?entityType=Proposal&entityId=${fx!.proposalId}` })).toBe(200);
    setActorForTests(fx!.stranger);
    expect(await call(r, "GET", {}, { query: `?entityType=Proposal&entityId=${fx!.proposalId}` })).toBe(404);
    expect(await call(r, "GET", {}, { query: `?entityType=Account&entityId=${fx!.accountId}` })).toBe(404);
    setActorForTests(seeded.FINANCE);
    expect(await call(r, "GET")).toBe(200);
    expect(await call(r, "GET", {}, { query: `?entityType=Proposal&entityId=${fx!.proposalId}` })).toBe(200);
  });
});

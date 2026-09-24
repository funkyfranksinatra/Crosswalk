/**
 * WS4 harness — call every API route handler in-process as a given actor.
 *
 * Routes are enumerated from the filesystem (src/app/api/** /route.ts), their gate is read from
 * the source (`handle("perm")`, `handle([...])`, `authorize(null)` …) and each exported method
 * is invoked with a NextRequest and a `params` promise built from the path's dynamic segments.
 *
 * `setRequestHeadersForTests` (src/lib/api.ts) hands the handler the headers the proxy would
 * have forwarded, so the ownership-scope hook runs exactly as it would behind the proxy;
 * `setActorForTests(null)` is an anonymous caller.
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { setRequestHeadersForTests } from "@/lib/api";
import { prisma } from "@/lib/db";
import { permissionsFor, ROLES, CROSSWALK_READ, type Permission } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";

export const API_ROOT = path.resolve(__dirname, "../../src/app/api");
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export type Gate =
  | { kind: "perm"; any: Permission[] }
  | { kind: "session" }
  | { kind: "custom" };

export type RouteInfo = { file: string; rel: string; urlPath: string; segments: string[]; methods: Method[]; gate: Gate; source: string };

/** Every route.ts under src/app/api with the methods it exports and the gate the source declares. */
export function enumerateRoutes(): RouteInfo[] {
  const out: RouteInfo[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === "route.ts") out.push(describeRoute(p));
    }
  };
  walk(API_ROOT);
  return out.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
}

function describeRoute(file: string): RouteInfo {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/");
  const segments = rel.split("/").filter((s) => /^\[.+\]$/.test(s)).map((s) => s.slice(1, -1));
  const urlPath = "/api/" + rel;
  const methods = METHODS.filter((m) => new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(source));
  return { file, rel, urlPath, segments, methods, gate: gateOf(source), source };
}

/** The gate the source declares. A route with several handlers may declare several; the per-method gate is resolved in gateFor(). */
function gateOf(source: string): Gate {
  const m = source.match(/(?:handle|authorize)\((?:"([a-z_]+)"|null|\[([^\]]*)\]|CROSSWALK_READ)/);
  if (!m) return { kind: "custom" };
  if (m[1]) return { kind: "perm", any: [m[1] as Permission] };
  if (m[2]) return { kind: "perm", any: m[2].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean) as Permission[] };
  if (m[0].includes("CROSSWALK_READ")) return { kind: "perm", any: [...CROSSWALK_READ] };
  return { kind: "session" };
}

/** The gate of ONE method: the `handle(...)`/`authorize(...)` call that follows that method's declaration. */
export function gateFor(route: RouteInfo, method: Method): Gate {
  const idx = route.source.search(new RegExp(`export\\s+async\\s+function\\s+${method}\\b`));
  if (idx < 0) return route.gate;
  const after = route.source.slice(idx);
  const nextDecl = after.slice(1).search(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
  const body = nextDecl >= 0 ? after.slice(0, nextDecl + 1) : after;
  return gateOf(body);
}

export type Ids = Record<string, string>;
const FAKE_ID = "clzzzzzzzzzzzzzzzzzzzzzz";

/** A concrete URL for a route, with dynamic segments filled from `ids` (default: a well-formed but unknown id). */
export function concretePath(route: RouteInfo, ids: Ids = {}): string {
  return "/api/" + route.rel.split("/").map((s) => (/^\[.+\]$/.test(s) ? ids[s.slice(1, -1)] ?? FAKE_ID : s)).join("/");
}
export function paramsFor(route: RouteInfo, ids: Ids = {}): Promise<Record<string, string>> {
  const p: Record<string, string> = {};
  for (const s of route.segments) p[s] = ids[s] ?? FAKE_ID;
  return Promise.resolve(p);
}

export type CallInit = { body?: unknown; form?: Record<string, string | Blob>; query?: string; headers?: Record<string, string> };

/** Invoke a route method in-process. The current actor is whatever `setActorForTests` holds. */
export async function callRoute(route: RouteInfo, method: Method, ids: Ids = {}, init: CallInit = {}): Promise<Response> {
  const mod = (await import(route.file)) as Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const fn = mod[method];
  if (!fn) throw new Error(`${route.urlPath} has no ${method}`);
  const url = `http://localhost:3104${concretePath(route, ids)}${init.query ?? ""}`;
  const headers = new Headers(init.headers ?? {});
  let body: BodyInit | undefined;
  if (init.form) { const fd = new FormData(); for (const [k, v] of Object.entries(init.form)) fd.append(k, v); body = fd; }
  else if (init.body !== undefined && method !== "GET") { headers.set("content-type", "application/json"); body = typeof init.body === "string" ? init.body : JSON.stringify(init.body); }
  else if (method !== "GET") { headers.set("content-type", "application/json"); body = "{}"; }
  // What the proxy would have forwarded: the decoded path for the ownership-scope hook, the collapsed route for metrics.
  const p = concretePath(route, ids).replace(/[\u0000-\u001f\u007f]/g, ""); // the proxy refuses control characters with a 400 before any header is set
  setRequestHeadersForTests({ "x-crosswalk-path": p, "x-crosswalk-route": `${method} ${p.replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, "/:id")}`, "x-request-id": "ws4test" });
  const req = new NextRequest(url, { method, headers, body });
  try { return await fn(req, { params: paramsFor(route, ids) }); } finally { setRequestHeadersForTests(null); }
}

// ---- actors -----------------------------------------------------------------------------------
export function actorFor(u: { id: string; email: string; name: string }, roles: string[]): Actor {
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}

/** The 11 seeded dev users, one per role (prisma/seed.ts). */
export async function seededActors(): Promise<Record<string, Actor>> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: "@crosswalk.dev" }, isActive: true }, include: { roles: true } });
  const out: Record<string, Actor> = {};
  for (const role of ROLES) {
    const u = users.find((x) => x.roles.length === 1 && x.roles[0].role === role);
    if (!u) throw new Error(`no seeded user for role ${role}`);
    out[role] = actorFor(u, [role]);
  }
  return out;
}

/** Routes that would start network work or long jobs when called authorized with an empty body: not invoked for the pass case. */
export const SIDE_EFFECT_ROUTES = new Set(["POST /api/catalog/enrich", "POST /api/crosswalk/publish", "POST /api/analytics/[report]", "POST /api/system", "POST /api/feeds"]);

// ---- fixtures: a rep's book of business with sentinel cost/floor/margin values ---------------
import { mkProduct, mkAccount, mkProposal, mkContract, cleanupRun, RUN as WS2RUN } from "./ws2-fixtures";
import { refreshEconomics } from "@/lib/proposals/service";

export const SENTINEL = { cost: "1234.5678", floor: "2345.6789", marginPct: "0.345678", marginAmount: "3456.789", cogsLegacy: "1234.5678" } as const;
export const SENTINELS = ["1234.5678", "2345.6789", "0.345678", "3456.789", "345678", "1,234.57", "2,345.68"];

export type Fixtures = {
  run: string;
  owner: Actor; // seeded SALES_REP (alex), owns the account
  stranger: Actor; // a second SALES_REP in another territory: sees nothing of it
  strangerRow: { id: string };
  accountId: string; requestId: string; lineId: string; competitorProductId: string; candidateId: string;
  proposalId: string; proposalLineId: string; scenarioId: string; contractId: string; productId: string;
  delegationId: string; // owner → stranger (owner is the delegating user)
};

/** Build the rep's book: account (owned by the seeded SALES_REP) → request with a resolved competitor line → proposal (sentinel cost / floor / margin) → scenario; a LOCAL contract; a delegation. */
export async function buildFixtures(seeded: Record<string, Actor>): Promise<Fixtures> {
  const owner = seeded.SALES_REP;
  const strangerRow = await prisma.user.create({ data: { email: `${WS2RUN}.ws4-stranger@test.local`, name: `${WS2RUN} stranger rep`, territory: "Mars", roles: { create: [{ role: "SALES_REP" }] } } });
  const stranger = actorFor(strangerRow, ["SALES_REP"]);
  const product = await mkProduct({ sku: "WS4-SKU", listPrice: "5000", cogs: SENTINEL.cogsLegacy, description: "WS4 fixture stapler" });
  const account = await mkAccount({ name: "ws4 owned", ownerUserId: owner.id });
  const { request, proposal, lines } = await mkProposal(owner, { accountId: account.id, lines: [{ code: "WS4-COMP-1", qty: 1, productId: product.id, estCompetitorPrice: "4800" }] });
  await prisma.request.update({ where: { id: request.id }, data: { createdByUserId: owner.id, createdBy: owner.name } });
  const cp = await prisma.competitorProduct.create({ data: { cfnNorm: `${WS2RUN}-WS4COMP1`.toUpperCase(), manufacturer: "Rival Surgical", description: "Rival stapler 45mm", resolution: "manual", confidence: 0.9, binJson: JSON.stringify({ v: 1 }), binSource: "heuristic", embeddingHash: "stale-hash", embeddingModel: "m", embeddedAt: new Date() } });
  const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: request.id }, orderBy: { lineNo: "asc" } });
  await prisma.requestLine.update({ where: { id: line.id }, data: { competitorProductId: cp.id } });
  const cand = await prisma.matchCandidate.findFirstOrThrow({ where: { lineId: line.id } });
  await prisma.matchCandidate.update({ where: { id: cand.id }, data: { rationale: "close attribute fit, priced 4% under competitor, 62% margin", unitPrice: "4990", factorsJson: JSON.stringify({ notes: ["priced 4% under competitor", "62% margin"], cap: null }) } });
  const pl = lines[0];
  const rec = { strategy: "MATCH", recommendedPrice: "4700", cost: SENTINEL.cost, floorPrice: SENTINEL.floor, floor: SENTINEL.floor, marginPct: SENTINEL.marginPct, explanation: `Gross margin 34.6% at $4,700.00, $${Number(SENTINEL.floor).toFixed(2)} above the policy floor $${Number(SENTINEL.floor).toFixed(2)}.`, explanationPublic: "Matches the competitor's price." };
  await prisma.proposalLine.update({ where: { id: pl.id }, data: { cost: SENTINEL.cost, floorPrice: SENTINEL.floor, marginPct: SENTINEL.marginPct, marginAmount: SENTINEL.marginAmount, proposedPrice: "4700", recommendedPrice: "4700", recommendationJson: JSON.stringify(rec), waterfallJson: JSON.stringify({ steps: [{ name: "cost", cost: SENTINEL.cost }], floorPrice: SENTINEL.floor }), costBasisJson: JSON.stringify({ standardCost: SENTINEL.cost, source: "legacy" }) } });
  await refreshEconomics(proposal.id);
  const scenario = await prisma.scenario.create({ data: { proposalId: proposal.id, kind: "CUSTOM", name: "ws4 scenario", createdByUserId: owner.id, lines: { create: [{ proposalLineId: pl.id, proposedPrice: "4600", included: true }] } } });
  const contract = await mkContract({ number: "WS4-LOCAL", type: "LOCAL", accountId: account.id, entries: [{ productId: product.id, price: "4500" }] });
  const delegation = await prisma.approvalDelegation.create({ data: { fromUserId: owner.id, toUserId: strangerRow.id, startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 86_400_000), reason: "ws4 fixture", createdByUserId: owner.id } });
  await prisma.auditEvent.create({ data: { actorUserId: owner.id, entityType: "Proposal", entityId: proposal.id, action: "WS4_FIXTURE", afterJson: JSON.stringify({ cost: SENTINEL.cost, floorPrice: SENTINEL.floor, marginPct: SENTINEL.marginPct, note: "sentinel" }) } });
  await prisma.approvalRequest.create({ data: { proposalId: proposal.id, proposalLineId: pl.id, requiredRole: "PRICING_DIRECTOR", reason: `below floor (4700.00 < ${Number(SENTINEL.floor).toFixed(2)}), 6.0% off list, margin 34.6%`, requestedByUserId: owner.id, snapshotJson: JSON.stringify({ proposedPrice: "4700", floorPrice: SENTINEL.floor, marginPct: SENTINEL.marginPct, discountFromListPct: "0.06" }) } });
  return { run: WS2RUN, owner, stranger, strangerRow, accountId: account.id, requestId: request.id, lineId: line.id, competitorProductId: cp.id, candidateId: cand.id, proposalId: proposal.id, proposalLineId: pl.id, scenarioId: scenario.id, contractId: contract.id, productId: product.id, delegationId: delegation.id };
}

export async function cleanupFixtures(f: Fixtures | null) {
  if (!f) return;
  await prisma.approvalRequest.deleteMany({ where: { proposalId: f.proposalId } }).catch(() => undefined);
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: [f.proposalId, f.requestId, f.competitorProductId, f.delegationId, f.contractId, f.accountId] } } }).catch(() => undefined);
  await prisma.approvalDelegation.deleteMany({ where: { id: f.delegationId } }).catch(() => undefined);
  await prisma.requestLine.updateMany({ where: { competitorProductId: f.competitorProductId }, data: { competitorProductId: null } }).catch(() => undefined);
  await prisma.competitorProduct.deleteMany({ where: { id: f.competitorProductId } }).catch(() => undefined);
  await cleanupRun();
  await prisma.user.deleteMany({ where: { id: f.strangerRow.id } }).catch(() => undefined);
}

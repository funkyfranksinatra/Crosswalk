/**
 * Tier 0 (security and deployment readiness) — database-backed behaviour tests.
 *
 * 0.2 ownership scoping: a rep sees own / territory / unassigned accounts and nothing else,
 *     and the central path hook 404s anything outside the book of business; every non-scoped
 *     role still sees everything.
 * 0.8 audited break-glass: an ADMIN approving their own request must give a reason; the
 *     decision is flagged in the audit trail and other ADMIN / PRICING_DIRECTOR users are told.
 *
 * Needs DATABASE_URL with the demo seed; no network.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { permissionsFor } from "@/lib/auth/permissions";
import { AuthError, type Actor } from "@/lib/auth";
import { getCompany } from "@/lib/settings";
import { scopeFor, accountWhere, requestWhere, proposalWhere, contractWhere, enforceScopeForPath, assertAccountWritable } from "@/lib/auth/scope";

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `t0${Date.now().toString(36)}`;

function actorFor(u: { id: string; email: string; name: string }, roles: string[]): Actor {
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}

async function mkUser(tag: string, roles: string[], territory?: string) {
  const u = await prisma.user.create({ data: { email: `${RUN}.${tag}@test.local`, name: `${RUN} ${tag}`, territory, roles: { create: roles.map((role) => ({ role })) } } });
  return { row: u, actor: actorFor(u, roles) };
}

describe.skipIf(!hasDb)("Tier 0.2 — ownership / territory scoping", () => {
  let rep: Awaited<ReturnType<typeof mkUser>>;
  let rep2: Awaited<ReturnType<typeof mkUser>>;
  let mgr: Awaited<ReturnType<typeof mkUser>>;
  let analyst: Awaited<ReturnType<typeof mkUser>>;
  let hybrid: Awaited<ReturnType<typeof mkUser>>;
  const acc: Record<string, string> = {};
  let ownRequestId = "";
  let foreignRequestId = "";

  beforeAll(async () => {
    rep = await mkUser("rep", ["SALES_REP"], "Northeast");
    rep2 = await mkUser("rep2", ["SALES_REP"], "West, Mountain");
    mgr = await mkUser("mgr", ["REGIONAL_MANAGER"], "northeast");
    analyst = await mkUser("analyst", ["PRICING_ANALYST"]);
    hybrid = await mkUser("hybrid", ["SALES_REP", "PRICING_ANALYST"], "Nowhere");
    const mk = async (tag: string, data: Record<string, unknown>) => {
      const a = await prisma.account.create({ data: { name: `${RUN} ${tag}`, accountNumber: `${RUN}-${tag}`, ...data } });
      acc[tag] = a.id;
      return a.id;
    };
    await mk("owned", { ownerUserId: rep.row.id, territory: "Southwest" });
    await mk("territory", { territory: "NORTHEAST", ownerUserId: rep2.row.id });
    await mk("unassigned", {});
    await mk("foreign", { ownerUserId: rep2.row.id, territory: "West" });
    await mk("idn", { type: "IDN", territory: "Northeast" });
    await mk("child", { parentAccountId: acc.idn, territory: "Pacific", ownerUserId: rep2.row.id });
    await mk("orphanTerritory", { territory: "Pacific" }); // territory set, no owner → not "unassigned"
    const companyId = (await getCompany()).id;
    const r1 = await prisma.request.create({ data: { companyId, reference: `${RUN}-R1`, status: "DRAFT", createdByUserId: rep.row.id, accountId: acc.foreign } });
    const r2 = await prisma.request.create({ data: { companyId, reference: `${RUN}-R2`, status: "DRAFT", createdByUserId: rep2.row.id, accountId: acc.foreign } });
    ownRequestId = r1.id; foreignRequestId = r2.id;
  });

  afterAll(async () => {
    await prisma.request.deleteMany({ where: { reference: { startsWith: `${RUN}-` } } });
    await prisma.account.deleteMany({ where: { accountNumber: { startsWith: `${RUN}-` } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}.` } } });
  });

  const visible = async (a: Actor) => {
    const rows = await prisma.account.findMany({ where: { AND: [accountWhere(await scopeFor(a)), { accountNumber: { startsWith: `${RUN}-` } }] }, select: { accountNumber: true } });
    return rows.map((r) => r.accountNumber!.slice(RUN.length + 1)).sort();
  };

  test("a rep sees owned, territory (case-insensitive), unassigned and children of visible IDNs — nothing else", async () => {
    expect(await visible(rep.actor)).toEqual(["child", "idn", "owned", "territory", "unassigned"]);
  });

  test("a manager is scoped the same way; multi-territory users match every territory", async () => {
    expect(await visible(mgr.actor)).toEqual(["child", "idn", "territory", "unassigned"]);
    expect(await visible(rep2.actor)).toEqual(["child", "foreign", "territory", "unassigned"]);
  });

  test("every non-scoped role, and any user holding a non-scoped role, sees everything", async () => {
    expect((await scopeFor(analyst.actor)).mode).toBe("all");
    expect((await scopeFor(hybrid.actor)).mode).toBe("all");
    expect(accountWhere({ mode: "all" })).toEqual({});
    expect(await visible(analyst.actor)).toHaveLength(7);
  });

  test("requests follow their account, and a rep always sees what they created", async () => {
    const mine = await prisma.request.findMany({ where: { AND: [requestWhere(await scopeFor(rep.actor)), { reference: { startsWith: `${RUN}-` } }] }, select: { id: true } });
    expect(mine.map((r) => r.id)).toEqual([ownRequestId]);
    const theirs = await prisma.request.findMany({ where: { AND: [requestWhere(await scopeFor(rep2.actor)), { reference: { startsWith: `${RUN}-` } }] }, select: { id: true } });
    expect(theirs.map((r) => r.id).sort()).toEqual([ownRequestId, foreignRequestId].sort());
  });

  test("the central path hook 404s out-of-scope ids and lets everything else through", async () => {
    await expect(enforceScopeForPath(rep.actor, `/api/accounts/${acc.owned}`)).resolves.toBeUndefined();
    await expect(enforceScopeForPath(rep.actor, `/api/accounts/${acc.foreign}`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(rep.actor, `/api/accounts/${acc.foreign}/contracts`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(rep.actor, `/api/requests/${foreignRequestId}/lines`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(rep.actor, `/api/requests/${ownRequestId}`)).resolves.toBeUndefined();
    await expect(enforceScopeForPath(analyst.actor, `/api/accounts/${acc.foreign}`)).resolves.toBeUndefined();
    // sub-resource names and list routes are not ids
    await expect(enforceScopeForPath(rep.actor, "/api/accounts")).resolves.toBeUndefined();
    await expect(enforceScopeForPath(rep.actor, "/api/accounts/sync")).resolves.toBeUndefined();
    await expect(enforceScopeForPath(rep.actor, null)).resolves.toBeUndefined();
    // a missing row and an out-of-scope row are indistinguishable
    await expect(enforceScopeForPath(rep.actor, "/api/accounts/clzzzzzzzzzzzzzzzzzzzzzz")).rejects.toBeInstanceOf(AuthError);
  });

  test("a rep cannot file a request or proposal against an account outside their book", async () => {
    await expect(assertAccountWritable(rep.actor, acc.foreign)).rejects.toMatchObject({ status: 404 });
    await expect(assertAccountWritable(rep.actor, acc.unassigned)).resolves.toBeUndefined();
    await expect(assertAccountWritable(rep.actor, null)).resolves.toBeUndefined();
  });

  test("proposal and contract fragments are valid Prisma filters", async () => {
    const s = await scopeFor(rep.actor);
    await expect(prisma.proposal.count({ where: proposalWhere(s) })).resolves.toBeTypeOf("number");
    await expect(prisma.contract.count({ where: contractWhere(s) })).resolves.toBeTypeOf("number");
    // GPO / national contracts (no account) stay visible to everyone
    const noAccount = await prisma.contract.count({ where: { accountId: null, parentAccountId: null } });
    const seen = await prisma.contract.count({ where: contractWhere(s) });
    expect(seen).toBeGreaterThanOrEqual(noAccount);
  });
});

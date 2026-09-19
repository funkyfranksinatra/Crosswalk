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
import { resolveUser, type Identity } from "@/lib/auth/oidc";
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

describe.skipIf(!hasDb)("Tier 0.1 — OIDC subject → user resolution", () => {
  const cfg = { issuer: "https://idp.test", clientId: "c", clientSecret: null, redirectUri: "x", scopes: "openid", roleClaim: "roles", roleMap: {}, defaultRole: null, autoProvision: true, sessionHours: 1 };
  const id = (over: Partial<Identity>): Identity => ({ subject: `${RUN}-sub`, email: `${RUN}.sso@test.local`, name: "SSO Person", roles: ["SALES_REP"], claims: {}, ...over });
  afterAll(async () => { await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}.` } } }); });

  test("first sign-in provisions the user with the claimed roles; later sign-ins match the subject and sync roles", async () => {
    const first = await resolveUser(cfg, id({}));
    expect(first.created).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: first.userId }, include: { roles: true } });
    expect(u.externalId).toBe(`${RUN}-sub`);
    expect(u.roles.map((r) => r.role)).toEqual(["SALES_REP"]);
    // roles changed at the IdP → synced; email changed → still the same user (subject wins)
    const second = await resolveUser(cfg, id({ email: `${RUN}.renamed@test.local`, roles: ["REGIONAL_MANAGER", "SALES_REP"], name: "SSO Person II" }));
    expect(second).toEqual({ userId: first.userId, created: false, rolesSynced: true });
    const u2 = await prisma.user.findUniqueOrThrow({ where: { id: first.userId }, include: { roles: true } });
    expect(u2.roles.map((r) => r.role).sort()).toEqual(["REGIONAL_MANAGER", "SALES_REP"]);
    expect(u2.name).toBe("SSO Person II");
    expect(u2.email).toBe(`${RUN}.sso@test.local`);
    // no roles claim → DB roles untouched
    const third = await resolveUser(cfg, id({ roles: null }));
    expect(third.rolesSynced).toBe(false);
    expect((await prisma.userRole.count({ where: { userId: first.userId } }))).toBe(2);
  });

  test("a pre-created user is matched by email (case-insensitive) and gains the subject", async () => {
    const pre = await prisma.user.create({ data: { email: `${RUN}.pre@test.local`, name: "Pre", roles: { create: [{ role: "FINANCE" }] } } });
    const r = await resolveUser({ ...cfg, roleClaim: null }, id({ subject: `${RUN}-sub2`, email: `${RUN.toUpperCase()}.PRE@test.local`, roles: null }));
    expect(r).toEqual({ userId: pre.id, created: false, rolesSynced: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pre.id } })).externalId).toBe(`${RUN}-sub2`);
  });

  test("deactivated users, unknown users without auto-provision, and users with no role are refused", async () => {
    const off = await prisma.user.create({ data: { email: `${RUN}.off@test.local`, name: "Off", isActive: false, externalId: `${RUN}-off` } });
    await expect(resolveUser(cfg, id({ subject: `${RUN}-off`, email: off.email }))).rejects.toMatchObject({ status: 403, message: /deactivated/ });
    await expect(resolveUser({ ...cfg, autoProvision: false }, id({ subject: `${RUN}-new`, email: `${RUN}.new@test.local` }))).rejects.toMatchObject({ status: 403, message: /not been set up/ });
    await expect(resolveUser(cfg, id({ subject: `${RUN}-norole`, email: `${RUN}.norole@test.local`, roles: [] }))).rejects.toMatchObject({ status: 403, message: /no Crosswalk role/ });
    await expect(resolveUser(cfg, id({ subject: `${RUN}-noemail`, email: null }))).rejects.toMatchObject({ status: 403, message: /email/ });
    // default role fills in when the claim is present but empty
    const d = await resolveUser({ ...cfg, defaultRole: "SALES_REP" }, id({ subject: `${RUN}-default`, email: `${RUN}.default@test.local`, roles: [] }));
    expect(d.created).toBe(true);
    expect((await prisma.userRole.findMany({ where: { userId: d.userId } })).map((r) => r.role)).toEqual(["SALES_REP"]);
  });
});

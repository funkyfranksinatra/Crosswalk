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
import { decide, queueFor } from "@/lib/approvals/service";
import { runRetention, retentionConfig } from "@/lib/retention";
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
    const r1 = await prisma.request.create({ data: { companyId, reference: `${RUN}-R1`, status: "draft", createdByUserId: rep.row.id, accountId: acc.foreign } });
    const r2 = await prisma.request.create({ data: { companyId, reference: `${RUN}-R2`, status: "draft", createdByUserId: rep2.row.id, accountId: acc.foreign } });
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
    // an id smuggled past the pattern (percent-encoded, odd length, junk) is checked or refused — never skipped
    const enc = acc.foreign.slice(0, -1) + "%" + acc.foreign.charCodeAt(acc.foreign.length - 1).toString(16);
    await expect(enforceScopeForPath(rep.actor, `/api/accounts/${enc}`)).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(analyst.actor, `/api/accounts/${enc}`)).resolves.toBeUndefined();
    await expect(enforceScopeForPath(rep.actor, "/api/accounts/x%ZZ")).rejects.toMatchObject({ status: 404 }); // undecodable
    await expect(enforceScopeForPath(rep.actor, "/api/accounts/not-a-cuid-but-long-enough-to-look-like-one")).rejects.toMatchObject({ status: 404 });
    await expect(enforceScopeForPath(rep.actor, "/api/accounts/abc123")).rejects.toMatchObject({ status: 404 }); // short but not a plain word
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

  test("an account already linked to another identity is never re-bound by email", async () => {
    const linked = await prisma.user.create({ data: { email: `${RUN}.linked@test.local`, name: "Linked", externalId: `${RUN}-original-sub`, roles: { create: [{ role: "ADMIN" }] } } });
    await expect(resolveUser(cfg, id({ subject: `${RUN}-impostor`, email: linked.email.toUpperCase(), roles: ["SALES_REP"] }))).rejects.toMatchObject({ status: 403, message: /different identity/ });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: linked.id }, include: { roles: true } });
    expect(after.externalId).toBe(`${RUN}-original-sub`);
    expect(after.roles.map((r) => r.role)).toEqual(["ADMIN"]);
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

describe.skipIf(!hasDb)("Tier 0.8 — audited break-glass self-approval", () => {
  let admin: Awaited<ReturnType<typeof mkUser>>;
  let admin2: Awaited<ReturnType<typeof mkUser>>;
  let director: Awaited<ReturnType<typeof mkUser>>;
  let accountId = "";
  const made: string[] = [];

  async function pendingRequest(requestedBy: string) {
    const p = await prisma.proposal.create({ data: { reference: `${RUN}-P${made.length + 1}`, accountId, status: "SUBMITTED", ownerUserId: requestedBy, createdByUserId: requestedBy, lockedAt: new Date(), submittedAt: new Date(), lines: { create: [{ lineNo: 1, competitorCode: "X1", quantity: 10, proposedPrice: 80, listPrice: 100, floorPrice: 70, approvalState: "PENDING", included: true }] } }, include: { lines: true } });
    made.push(p.id);
    const req = await prisma.approvalRequest.create({ data: { proposalId: p.id, proposalLineId: p.lines[0].id, requiredRole: "PRICING_DIRECTOR", reason: "20% off list", requestedByUserId: requestedBy, snapshotJson: JSON.stringify({ proposedPrice: "80" }) } });
    return { p, req };
  }

  beforeAll(async () => {
    admin = await mkUser("bg-admin", ["ADMIN"]);
    admin2 = await mkUser("bg-admin2", ["ADMIN"]);
    director = await mkUser("bg-director", ["PRICING_DIRECTOR"]);
    accountId = (await prisma.account.create({ data: { name: `${RUN} bg`, accountNumber: `${RUN}-bg` } })).id;
  });
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [admin.row.id, admin2.row.id, director.row.id] } } });
    await prisma.proposal.deleteMany({ where: { id: { in: made } } });
    await prisma.account.deleteMany({ where: { accountNumber: { in: [`${RUN}-bg`, `${RUN}-bg-foreign`] } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}.bg-` } } });
  });

  test("a non-admin still cannot decide their own request", async () => {
    const { req } = await pendingRequest(director.row.id);
    await expect(decide(director.actor, req.id, "APPROVED", "a long enough reason for the record")).rejects.toThrow(/cannot approve your own/);
  });

  test("an ADMIN approving their own request must give a reason; the decision is flagged, audited and reported to the other admins and directors", async () => {
    const { p, req } = await pendingRequest(admin.row.id);
    await expect(decide(admin.actor, req.id, "APPROVED")).rejects.toMatchObject({ status: 400, message: /break-glass/ });
    await expect(decide(admin.actor, req.id, "APPROVED", "too short")).rejects.toMatchObject({ status: 400 });
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PENDING"); // refusals change nothing
    const reason = "Customer deadline today; pricing director travelling, margin still above floor";
    const out = await decide(admin.actor, req.id, "APPROVED", reason);
    expect(out.status).toBe("APPROVED");
    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after).toMatchObject({ status: "APPROVED", breakGlass: true, decidedByUserId: admin.row.id, decisionComments: reason });
    const events = await prisma.auditEvent.findMany({ where: { entityId: { in: [req.id, p.id] }, actorUserId: admin.row.id } });
    expect(events.map((e) => e.action).sort()).toEqual(["APPROVED", "BREAK_GLASS_APPROVAL"]);
    const flagged = events.find((e) => e.action === "APPROVED")!;
    expect(JSON.parse(flagged.contextJson!).breakGlass).toBe(true);
    const bg = events.find((e) => e.action === "BREAK_GLASS_APPROVAL")!;
    expect(bg.reason).toBe(reason);
    const told = await prisma.notification.findMany({ where: { kind: "BREAK_GLASS", entityId: req.id }, select: { userId: true, title: true } });
    const ids = told.map((n) => n.userId);
    expect(ids).toContain(admin2.row.id); expect(ids).toContain(director.row.id); // other admins and directors (seeded ones too)
    expect(ids).not.toContain(admin.row.id); // never the actor
    expect(told[0].title).toMatch(/Break-glass/);
  });

  test("rejecting or sending back one's own request is not break-glass and needs no reason", async () => {
    const { req } = await pendingRequest(admin.row.id);
    await decide(admin.actor, req.id, "CHANGES_REQUESTED");
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: "CHANGES_REQUESTED", breakGlass: false });
    expect(await prisma.notification.count({ where: { kind: "BREAK_GLASS", entityId: req.id } })).toBe(0);
  });

  test("a scoped approver neither sees nor decides requests outside their book of business", async () => {
    const mgr = await mkUser("bg-mgr", ["REGIONAL_MANAGER"], "Nowhere");
    const foreignAccount = await prisma.account.create({ data: { name: `${RUN} bg-foreign`, accountNumber: `${RUN}-bg-foreign`, territory: "Elsewhere", ownerUserId: admin.row.id } });
    const p = await prisma.proposal.create({ data: { reference: `${RUN}-P-foreign`, accountId: foreignAccount.id, status: "SUBMITTED", ownerUserId: admin.row.id, createdByUserId: admin.row.id, lines: { create: [{ lineNo: 1, competitorCode: "X2", quantity: 1, proposedPrice: 90, listPrice: 100, approvalState: "PENDING", included: true }] } }, include: { lines: true } });
    made.push(p.id);
    const req = await prisma.approvalRequest.create({ data: { proposalId: p.id, proposalLineId: p.lines[0].id, requiredRole: "REGIONAL_MANAGER", reason: "10% off", requestedByUserId: admin.row.id, snapshotJson: JSON.stringify({ proposedPrice: "90" }) } });
    expect((await queueFor(mgr.actor)).map((r) => r.id)).not.toContain(req.id);
    await expect(decide(mgr.actor, req.id, "APPROVED", "ok")).rejects.toMatchObject({ status: 404 });
    // the same manager with the account in their territory
    await prisma.user.update({ where: { id: mgr.row.id }, data: { territory: "Elsewhere" } });
    expect((await queueFor(mgr.actor)).map((r) => r.id)).toContain(req.id);
    await decide(mgr.actor, req.id, "APPROVED", "ok");
  });

  test("a normal approval by someone else is never flagged", async () => {
    const { req } = await pendingRequest(admin.row.id);
    await decide(director.actor, req.id, "APPROVED", "ok");
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: "APPROVED", breakGlass: false });
  });
});

// The real sweep deletes by age across the whole database, so it only ever runs against a
// loopback Postgres — never the shared Neon branch a developer's .env may point at.
const loopbackDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL ?? "");
describe.skipIf(!hasDb || !loopbackDb)("Tier 0.7 — retention sweep", () => {
  const old = new Date(Date.now() - 400 * 86_400_000);
  const recent = new Date(Date.now() - 2 * 86_400_000);
  const ids: { req: string[]; llm: string[]; snap: string[] } = { req: [], llm: [], snap: [] };
  let keptRequest = "", proposalRequest = "", oldRequest = "", failedRecent = "", runningOld = "";
  let accountId = "";

  beforeAll(async () => {
    const companyId = (await getCompany()).id;
    accountId = (await prisma.account.create({ data: { name: `${RUN} ret`, accountNumber: `${RUN}-ret` } })).id;
    const mk = async (tag: string, status: string, createdAt: Date) => { const r = await prisma.request.create({ data: { companyId, reference: `${RUN}-RET-${tag}`, status, createdAt, lines: { create: [{ lineNo: 1, rawCode: "X", cfnNorm: "X", quantity: 1 }] } } }); ids.req.push(r.id); return r; };
    oldRequest = (await mk("old", "complete", old)).id;
    keptRequest = (await mk("recent", "complete", recent)).id;
    failedRecent = (await mk("failedrecent", "failed", recent)).id;
    runningOld = (await mk("running", "running", old)).id;
    const withProposal = await mk("withproposal", "complete", old);
    proposalRequest = withProposal.id;
    await prisma.proposal.create({ data: { reference: `${RUN}-RET-P`, accountId, requestId: withProposal.id } });
    const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: oldRequest } });
    await prisma.matchDecision.create({ data: { requestLineId: line.id, topRecommendedSku: `${RUN}-Y`, chosenSku: `${RUN}-Y`, acceptedTop: true } });
    for (const at of [old, recent]) ids.llm.push((await prisma.llmCall.create({ data: { purpose: `${RUN}`, model: "m", ok: true, durationMs: 1, createdAt: at } })).id);
    for (const at of [old, new Date(old.getTime() + 1000)]) ids.snap.push((await prisma.analyticsSnapshot.create({ data: { report: `${RUN}-report`, json: "{}", computedAt: at } })).id);
  });
  afterAll(async () => {
    await prisma.matchDecision.deleteMany({ where: { chosenSku: `${RUN}-Y` } });
    await prisma.proposal.deleteMany({ where: { reference: { startsWith: `${RUN}-RET` } } });
    await prisma.request.deleteMany({ where: { reference: { startsWith: `${RUN}-RET` } } });
    await prisma.llmCall.deleteMany({ where: { purpose: RUN } });
    await prisma.analyticsSnapshot.deleteMany({ where: { report: `${RUN}-report` } });
    await prisma.account.deleteMany({ where: { accountNumber: `${RUN}-ret` } });
    await prisma.auditEvent.deleteMany({ where: { entityType: "System", entityId: "retention", at: { gt: new Date(Date.now() - 600_000) } } });
  });

  test("config: off by default, request window never implied, defaults only once enabled", () => {
    expect(retentionConfig({}).enabled).toBe(false);
    const on = retentionConfig({ RETENTION_ENABLED: "true" });
    expect(on.days.requests).toBeNull();
    expect(on.days.llmCalls).toBe(90);
    expect(retentionConfig({ RETENTION_ENABLED: "true", RETENTION_REQUESTS_DAYS: "365", RETENTION_LLM_CALLS_DAYS: "off" }).days).toMatchObject({ requests: 365, llmCalls: null });
    expect(() => retentionConfig({ RETENTION_REQUESTS_DAYS: "soon" })).toThrow(/whole number/);
    expect(retentionConfig({ RETENTION_BATCH: "10" }).batch).toBe(10);
  });

  test("disabled: nothing is touched, even with windows set", async () => {
    const out = await runRetention({ ...retentionConfig({ RETENTION_REQUESTS_DAYS: "30" }), enabled: false });
    expect(out.counts).toEqual({});
    expect(await prisma.request.count({ where: { id: { in: ids.req } } })).toBe(5);
  });

  test("dry run counts without deleting; a real sweep deletes only finished, unreferenced, old requests and keeps learning data", async () => {
    const cfg = { ...retentionConfig({ RETENTION_ENABLED: "true", RETENTION_REQUESTS_DAYS: "365", RETENTION_LLM_CALLS_DAYS: "90", RETENTION_SNAPSHOTS_DAYS: "30" }), dryRun: true };
    const dry = await runRetention(cfg);
    expect(dry.dryRun).toBe(true);
    expect(dry.counts.requests).toBeGreaterThanOrEqual(1);
    expect(await prisma.request.count({ where: { id: { in: ids.req } } })).toBe(5);
    const real = await runRetention({ ...cfg, dryRun: false });
    expect(real.dryRun).toBe(false);
    const left = (await prisma.request.findMany({ where: { id: { in: ids.req } }, select: { id: true } })).map((r) => r.id).sort();
    expect(left).toEqual([keptRequest, proposalRequest, failedRecent, runningOld].sort()); // only the old, finished, proposal-less one went
    expect(left).not.toContain(oldRequest);
    const md = await prisma.matchDecision.findFirstOrThrow({ where: { chosenSku: `${RUN}-Y` } });
    expect(md.requestLineId).toBeNull(); // learning data kept, unlinked
    expect((await prisma.llmCall.findMany({ where: { purpose: RUN } })).map((r) => r.id)).toEqual([ids.llm[1]]); // recent telemetry kept
    const snaps = await prisma.analyticsSnapshot.findMany({ where: { report: `${RUN}-report` } });
    expect(snaps.map((s) => s.id)).toEqual([ids.snap[1]]); // newest per report survives whatever its age
    const audits = await prisma.auditEvent.findMany({ where: { entityType: "System", entityId: "retention" }, orderBy: { at: "desc" }, take: 2 });
    expect(audits.map((a) => a.action).sort()).toEqual(["RETENTION_DRY_RUN", "RETENTION_SWEEP"]);
  });
});

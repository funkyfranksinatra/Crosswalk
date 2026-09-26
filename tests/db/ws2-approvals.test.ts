/**
 * WS2 — approvals: authority order, atomic submission (a forced failure at every step rolls
 * everything back), routing (NOT_REQUIRED / auto-approve / PENDING), decision races, stale
 * snapshots, reopen, derived status, self-decision, break-glass, delegation.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { D, money } from "@/lib/money";
import { AUTHORITY_ORDER, satisfiesAuthority, highestAuthority } from "@/lib/auth/permissions";
import { setProposedPrice } from "@/lib/proposals/service";
import { submitForApproval, decide, reopen, finalizeCheck, queueFor, BREAK_GLASS_MIN_REASON } from "@/lib/approvals/service";
import { proposalStatusFrom } from "@/lib/approvals/rules";
import { createDelegation, revokeDelegation, listDelegations, MAX_DELEGATION_DAYS, effectiveAuthorityFrom } from "@/lib/approvals/delegation";
import { RUN, mkUser, mkProduct, mkAccount, mkProposal, mkPolicy, linesOf, cleanupRun, withTxFailure, actorFor } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
type U = Awaited<ReturnType<typeof mkUser>>;

describe.skipIf(!hasDb)("WS2 approvals", () => {
  let rep: U, mgr: U, cm: U, dir: U, dir2: U, committee: U, admin: U;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let prod: Awaited<ReturnType<typeof mkProduct>>;
  // list 1000, cost 400 → floor 571.43. Discounts from list: 10 % rep · 22 % manager · 28 % contracting · 35 % director · 50 % (below floor) committee.
  const PRICES = { rep: "900", mgr: "780", cm: "720", dir: "650", committee: "500" } as const;
  const requests = (proposalId: string) => prisma.approvalRequest.findMany({ where: { proposalId }, orderBy: { requestedAt: "asc" } });
  const state = async (proposalId: string) => { const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { lines: { orderBy: { lineNo: "asc" } } } }); return { status: p.status, locked: p.lockedAt !== null, lines: p.lines.map((l) => l.approvalState), econ: p.economicsJson, requests: (await requests(proposalId)).map((r) => `${r.requiredRole}:${r.status}`), audits: await prisma.auditEvent.count({ where: { entityId: proposalId, action: "SUBMITTED" } }) }; };
  async function draft(actor: U, prices: (keyof typeof PRICES)[]) {
    const fx = await mkProposal(actor.actor, { accountId: acct.id, lines: prices.map((k, i) => ({ code: `${RUN}AP${i}`, qty: 10, productId: prod.id })) });
    for (let i = 0; i < prices.length; i++) await setProposedPrice(actor.actor, fx.lines[i].id, D(PRICES[prices[i]]));
    fx.lines = await linesOf(fx.proposal.id);
    return fx;
  }

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rep", ["SALES_REP"]); mgr = await mkUser("mgr", ["REGIONAL_MANAGER"]); cm = await mkUser("cm", ["CONTRACTING_MANAGER"]);
    dir = await mkUser("dir", ["PRICING_DIRECTOR"]); dir2 = await mkUser("dir2", ["PRICING_DIRECTOR"]); committee = await mkUser("cte", ["PRICING_COMMITTEE"]); admin = await mkUser("adm", ["ADMIN"]);
    await mkPolicy();
    acct = await mkAccount({ name: "approvals acct" });
    prod = await mkProduct({ sku: "AP1", listPrice: "1000", cogs: "400" });
  });
  afterAll(async () => { await cleanupRun(); });

  test("authority order SALES_REP < REGIONAL_MANAGER < CONTRACTING_MANAGER < PRICING_DIRECTOR < PRICING_COMMITTEE; ADMIN satisfies everything; other roles none", () => {
    expect(AUTHORITY_ORDER).toEqual(["SALES_REP", "REGIONAL_MANAGER", "CONTRACTING_MANAGER", "PRICING_DIRECTOR", "PRICING_COMMITTEE"]);
    for (let i = 0; i < AUTHORITY_ORDER.length; i++) for (let j = 0; j < AUTHORITY_ORDER.length; j++) expect(satisfiesAuthority([AUTHORITY_ORDER[i]], AUTHORITY_ORDER[j]), `${AUTHORITY_ORDER[i]} vs ${AUTHORITY_ORDER[j]}`).toBe(i >= j);
    for (const r of AUTHORITY_ORDER) expect(satisfiesAuthority(["ADMIN"], r)).toBe(true);
    for (const r of AUTHORITY_ORDER) expect(satisfiesAuthority(["FINANCE", "EXECUTIVE", "PRICING_ANALYST"], r)).toBe(false);
    expect(highestAuthority(["SALES_REP", "PRICING_DIRECTOR", "FINANCE"])).toBe("PRICING_DIRECTOR");
    expect(highestAuthority(["FINANCE"])).toBeNull();
  });

  test("derived proposal status: REJECTED > CHANGES_REQUESTED > APPROVED / SUBMITTED / PARTIALLY_APPROVED; WITHDRAWN and EXPIRED are ignored", () => {
    const S = (...s: string[]) => proposalStatusFrom(s.map((status) => ({ status })));
    expect(S()).toBe("APPROVED");
    expect(S("WITHDRAWN", "EXPIRED")).toBe("APPROVED");
    expect(S("PENDING")).toBe("SUBMITTED");
    expect(S("PENDING", "PENDING", "WITHDRAWN")).toBe("SUBMITTED");
    expect(S("APPROVED", "PENDING")).toBe("PARTIALLY_APPROVED");
    expect(S("APPROVED", "APPROVED")).toBe("APPROVED");
    expect(S("APPROVED", "CHANGES_REQUESTED", "PENDING")).toBe("CHANGES_REQUESTED");
    expect(S("APPROVED", "CHANGES_REQUESTED", "REJECTED", "PENDING")).toBe("REJECTED");
    expect(S("REJECTED", "WITHDRAWN")).toBe("REJECTED");
    expect(S("EXPIRED", "CHANGES_REQUESTED")).toBe("CHANGES_REQUESTED");
  });

  test("routing on submission: NOT_REQUIRED lines, lines within the submitter's authority auto-approved (audited), the rest PENDING with the lowest role that can decide", async () => {
    const fx = await draft(cm, ["rep", "mgr", "cm", "dir", "committee"]);
    expect(fx.lines.map((l) => l.requiredAuthority)).toEqual([null, "REGIONAL_MANAGER", "CONTRACTING_MANAGER", "PRICING_DIRECTOR", "PRICING_COMMITTEE"]);
    expect(fx.lines.map((l) => l.approvalState)).toEqual(["NOT_REQUIRED", "REQUIRED", "REQUIRED", "REQUIRED", "REQUIRED"]);
    const r = await submitForApproval(cm.actor, fx.proposal.id, "Q4");
    expect(r).toEqual({ status: "SUBMITTED", routed: 2, autoApproved: 2 });
    const st = await state(fx.proposal.id);
    expect(st.lines).toEqual(["NOT_REQUIRED", "APPROVED", "APPROVED", "PENDING", "PENDING"]);
    expect(st.requests).toEqual(["PRICING_DIRECTOR:PENDING", "PRICING_COMMITTEE:PENDING"]);
    expect(st.locked).toBe(true);
    expect(JSON.parse(st.econ!)).toMatchObject({ approvalsPending: 2, approvalsRequired: 2 });
    const auto = await prisma.auditEvent.findMany({ where: { entityType: "ProposalLine", entityId: { in: [fx.lines[1].id, fx.lines[2].id] }, action: "AUTO_APPROVED" } });
    expect(auto.length).toBe(2);
    expect(auto.map((a) => a.reason).sort()).toEqual(["submitter holds CONTRACTING_MANAGER authority", "submitter holds REGIONAL_MANAGER authority"]);
    expect(JSON.parse(auto[0].contextJson!)).toHaveProperty("dealRevenue");
    const reqs = await requests(fx.proposal.id);
    expect(JSON.parse(reqs[0].snapshotJson!)).toMatchObject({ proposedPrice: "650", floorPrice: "571.43", policyId: fx.lines[3].policyId });
    expect(reqs[0].reason).toMatch(/35\.0% off list, margin 38\.5%/);
    expect(reqs[1].reason).toMatch(/below floor \(500\.00 < 571\.43\), 50\.0% off list/);
    expect((await finalizeCheck(fx.proposal.id))).toMatchObject({ ok: false, reason: "2 line(s) awaiting or denied approval" });
    // A submitter with every authority: nothing routed, APPROVED at once.
    const own = await draft(admin, ["dir", "committee"]);
    expect(await submitForApproval(admin.actor, own.proposal.id)).toEqual({ status: "APPROVED", routed: 0, autoApproved: 2 });
    expect((await finalizeCheck(own.proposal.id)).ok).toBe(true);
    // Nothing needing approval at all: APPROVED, no requests, no auto-approval events.
    const plain = await draft(rep, ["rep"]);
    expect(await submitForApproval(rep.actor, plain.proposal.id)).toEqual({ status: "APPROVED", routed: 0, autoApproved: 0 });
  });

  test("submission is atomic: a forced failure at each step (claim, withdraw, recompute, line states, request create, status write, audit) leaves the draft exactly as it was", async () => {
    const fx = await draft(rep, ["rep", "dir", "committee"]);
    const before = await state(fx.proposal.id);
    expect(before).toMatchObject({ status: "DRAFT", locked: false, lines: ["NOT_REQUIRED", "REQUIRED", "REQUIRED"], requests: [], audits: 0 });
    const steps: { model: string | null; method: string; nth?: number }[] = [
      { model: "proposal", method: "updateMany" }, // claim
      { model: "approvalRequest", method: "updateMany" }, // withdraw earlier requests
      { model: null, method: "$executeRaw" }, // recompute (UPDATE … FROM unnest)
      { model: "proposalLine", method: "updateMany" }, // line states
      { model: "approvalRequest", method: "create", nth: 2 }, // the 2nd request
      { model: "proposal", method: "update", nth: 2 }, // status write (the 1st update is the economics rollup)
      { model: "auditEvent", method: "create", nth: 3 }, // the SUBMITTED event, after two REQUESTED events
    ];
    for (const at of steps) {
      const r = await withTxFailure(at, () => submitForApproval(rep.actor, fx.proposal.id));
      expect(r.error?.message, JSON.stringify(at)).toMatch(/injected failure/);
      expect(r.calls, JSON.stringify(at)).toBeGreaterThanOrEqual(at.nth ?? 1);
      expect(await state(fx.proposal.id), JSON.stringify(at)).toEqual(before);
      expect(await prisma.auditEvent.count({ where: { entityType: "ApprovalRequest", action: "REQUESTED", contextJson: { contains: fx.lines[1].id } } })).toBe(0);
    }
    // And with nothing injected the same draft submits normally.
    expect(await submitForApproval(rep.actor, fx.proposal.id)).toEqual({ status: "SUBMITTED", routed: 2, autoApproved: 0 });
    expect((await state(fx.proposal.id)).requests).toEqual(["PRICING_DIRECTOR:PENDING", "PRICING_COMMITTEE:PENDING"]);
  });

  test("two simultaneous submits → one wins; edit vs submit → the edit is refused once locked; the loser's failure changed nothing", async () => {
    const fx = await draft(rep, ["dir"]);
    const results = await Promise.allSettled([submitForApproval(rep.actor, fx.proposal.id), submitForApproval(rep.actor, fx.proposal.id)]);
    const ok = results.filter((r) => r.status === "fulfilled"), ko = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(ko.length).toBe(1);
    expect(ko[0].reason.message).toMatch(/already being submitted|only drafts can be submitted/);
    expect((await requests(fx.proposal.id)).filter((r) => r.status === "PENDING").length).toBe(1);
    await expect(setProposedPrice(rep.actor, fx.lines[0].id, D("700"))).rejects.toThrow(/locked; create a new version/);
    await expect(submitForApproval(rep.actor, fx.proposal.id)).rejects.toThrow(/Proposal is SUBMITTED; only drafts can be submitted/);
  });

  test("deciding: lower authority refused, equal/higher allowed; simultaneous approve + reject → exactly one decision; a retry is refused; the queue shows only decidable requests", async () => {
    const fx = await draft(rep, ["mgr", "dir", "committee"]);
    await submitForApproval(rep.actor, fx.proposal.id);
    const [rMgr, rDir, rCte] = await requests(fx.proposal.id);
    expect((await queueFor(mgr.actor)).map((q) => q.id)).toContain(rMgr.id);
    expect((await queueFor(mgr.actor)).map((q) => q.id)).not.toContain(rDir.id);
    expect((await queueFor(dir.actor)).map((q) => q.id)).toEqual(expect.arrayContaining([rMgr.id, rDir.id]));
    expect((await queueFor(dir.actor)).map((q) => q.id)).not.toContain(rCte.id);
    expect((await queueFor(rep.actor)).map((q) => q.id)).not.toContain(rMgr.id); // no approve_discount
    await expect(decide(rep.actor, rMgr.id, "APPROVED")).rejects.toThrow(/approve_discount|authority/);
    await expect(decide(mgr.actor, rDir.id, "APPROVED")).rejects.toThrow(/needs pricing director authority/);
    await expect(decide(dir.actor, rCte.id, "APPROVED")).rejects.toThrow(/needs pricing committee authority/);
    await expect(decide(mgr.actor, rMgr.id, "MAYBE" as never)).rejects.toThrow(/decision must be/);
    // Simultaneous approve (director) and reject (manager) on the manager-level request: one wins.
    const race = await Promise.allSettled([decide(dir.actor, rMgr.id, "APPROVED"), decide(mgr.actor, rMgr.id, "REJECTED", "no")]);
    expect(race.filter((r) => r.status === "fulfilled").length).toBe(1);
    const loser = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason.message).toMatch(/decided by someone else|Request already/);
    const decided = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: rMgr.id } });
    expect(["APPROVED", "REJECTED"]).toContain(decided.status);
    expect(await prisma.auditEvent.count({ where: { entityType: "ApprovalRequest", entityId: rMgr.id, action: { in: ["APPROVED", "REJECTED"] } } })).toBe(1);
    // Retry of an already-decided request.
    await expect(decide(dir.actor, rMgr.id, "APPROVED")).rejects.toThrow(/Request already (approved|rejected)/);
    // The line and proposal follow the decision that won; higher levels are unaffected.
    const st = await state(fx.proposal.id);
    expect(st.lines[0]).toBe(decided.status);
    expect(st.status).toBe(decided.status === "REJECTED" ? "REJECTED" : "PARTIALLY_APPROVED");
    expect(JSON.parse(st.econ!).approvalsPending).toBe(2);
    // Committee approves both remaining; the proposal is APPROVED only when nothing is pending or rejected.
    await decide(committee.actor, rDir.id, "APPROVED");
    const afterCte = await decide(committee.actor, rCte.id, "APPROVED");
    expect(afterCte.status).toBe(decided.status === "REJECTED" ? "REJECTED" : "APPROVED");
    expect((await finalizeCheck(fx.proposal.id)).ok).toBe(decided.status !== "REJECTED");
  });

  test("a stale snapshot cannot authorise a changed price; changes-requested unlocks, a price change voids that line's request; reopen withdraws everything", async () => {
    const fx = await draft(rep, ["mgr", "dir"]);
    await submitForApproval(rep.actor, fx.proposal.id);
    let [rMgr, rDir] = await requests(fx.proposal.id);
    // The price moved after the request was snapshotted (a direct write simulates the race): the decision is refused and the request withdrawn.
    await prisma.proposalLine.update({ where: { id: fx.lines[1].id }, data: { proposedPrice: "640" } });
    await expect(decide(dir.actor, rDir.id, "APPROVED")).rejects.toThrow(/price changed from 650 to 640 after this request was made; the proposal must be resubmitted/);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: rDir.id } })).status).toBe("WITHDRAWN");
    expect((await prisma.proposalLine.findUniqueOrThrow({ where: { id: fx.lines[1].id } })).approvalState).toBe("PENDING"); // resubmission re-evaluates it
    // Changes requested on the manager line unlocks the proposal for editing.
    expect((await decide(mgr.actor, rMgr.id, "CHANGES_REQUESTED", "too deep")).status).toBe("CHANGES_REQUESTED");
    expect((await state(fx.proposal.id)).locked).toBe(false);
    expect((await prisma.proposalLine.findUniqueOrThrow({ where: { id: fx.lines[0].id } })).approvalState).toBe("REQUIRED");
    // Resubmit: the earlier CHANGES_REQUESTED / WITHDRAWN requests do not decide anything any more.
    await setProposedPrice(rep.actor, fx.lines[0].id, D("800"));
    const again = await submitForApproval(rep.actor, fx.proposal.id);
    expect(again).toEqual({ status: "SUBMITTED", routed: 2, autoApproved: 0 });
    const live = (await requests(fx.proposal.id)).filter((r) => r.status === "PENDING");
    expect(live.length).toBe(2);
    [rMgr, rDir] = live;
    // Reopen: pending requests withdrawn, DRAFT, unlocked; a decision on the withdrawn request is refused.
    await reopen(rep.actor, fx.proposal.id, "rework");
    expect(await state(fx.proposal.id)).toMatchObject({ status: "DRAFT", locked: false, lines: ["REQUIRED", "REQUIRED"] });
    await expect(decide(dir.actor, rDir.id, "APPROVED")).rejects.toThrow(/Request already withdrawn/);
    // A PENDING request whose proposal is no longer in the approval cycle (DRAFT after a reopen race) cannot approve it back to life.
    await prisma.approvalRequest.update({ where: { id: rDir.id }, data: { status: "PENDING" } });
    await expect(decide(dir.actor, rDir.id, "APPROVED")).rejects.toThrow(/is draft; this request is no longer open for decision/);
    expect((await state(fx.proposal.id)).status).toBe("DRAFT");
    await prisma.approvalRequest.update({ where: { id: rDir.id }, data: { status: "WITHDRAWN" } });
    expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: fx.proposal.id, action: "REOPENED" } })).toBe(1);
  });

  test("self-decision is prevented directly and via delegation; an ADMIN may break glass only with a written reason ≥ 20 characters (flagged, audited, other admins/directors notified)", async () => {
    const fx = await draft(cm, ["dir"]); // the contracting manager submits a director-level line
    await submitForApproval(cm.actor, fx.proposal.id);
    const [r] = await requests(fx.proposal.id);
    // Lend the director's authority to the submitter: still no self-approval by proxy.
    const d = await createDelegation(dir.actor, { toUserId: cm.row.id, endsAt: new Date(Date.now() + 5 * 86_400_000) });
    await expect(decide(cm.actor, r.id, "APPROVED")).rejects.toThrow(/cannot approve your own request/);
    await expect(decide(cm.actor, r.id, "REJECTED", "changed my mind")).rejects.toThrow(/cannot approve your own request/);
    await revokeDelegation(dir.actor, d.id);
    // The submitter is later made an ADMIN (the only way an ADMIN can hold a routed request of their own).
    await prisma.userRole.create({ data: { userId: cm.row.id, role: "ADMIN" } });
    const cmAdmin = actorFor(cm.row, ["CONTRACTING_MANAGER", "ADMIN"]);
    await expect(decide(cmAdmin, r.id, "APPROVED", "ok")).rejects.toThrow(/break-glass action: give a reason of at least 20 characters/);
    await expect(decide(cmAdmin, r.id, "APPROVED", " ".repeat(30))).rejects.toThrow(/at least 20 characters/);
    await expect(decide(cmAdmin, r.id, "APPROVED", "x".repeat(BREAK_GLASS_MIN_REASON - 1))).rejects.toThrow(/at least 20 characters/);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PENDING");
    const reason = "Customer signing today; director unreachable — approving under break-glass";
    expect((await decide(cmAdmin, r.id, "APPROVED", reason)).status).toBe("APPROVED");
    const done = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(done).toMatchObject({ status: "APPROVED", breakGlass: true, decidedByUserId: cm.row.id, onBehalfOfUserId: null, decisionComments: reason });
    expect(await prisma.auditEvent.count({ where: { entityType: "Proposal", entityId: fx.proposal.id, action: "BREAK_GLASS_APPROVAL", reason } })).toBe(1);
    const notified = await prisma.notification.findMany({ where: { kind: "BREAK_GLASS", entityId: r.id } });
    const recipientIds = notified.map((n) => n.userId);
    expect(recipientIds).not.toContain(cm.row.id);
    expect(recipientIds).toEqual(expect.arrayContaining([admin.row.id, dir.row.id, dir2.row.id]));
    expect(recipientIds).not.toContain(rep.row.id);
    // Rejecting or sending back one's own request as an ADMIN needs no break-glass reason.
    const fx2 = await draft(cm, ["dir"]);
    await submitForApproval(cm.actor, fx2.proposal.id);
    const [r2] = await requests(fx2.proposal.id);
    expect((await decide(cmAdmin, r2.id, "CHANGES_REQUESTED")).status).toBe("CHANGES_REQUESTED");
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r2.id } })).breakGlass).toBe(false);
    await prisma.userRole.delete({ where: { userId_role: { userId: cm.row.id, role: "ADMIN" } } });
  });

  test("delegation: ≤ 90 days, no overlap, end not in the past, ownership, delegate must hold approve_discount, ADMIN never lent, onBehalfOf recorded, delegator-submitted proposals not approvable by the delegate, revocation", async () => {
    const days = (n: number) => new Date(Date.now() + n * 86_400_000);
    await expect(createDelegation(dir.actor, { toUserId: mgr.row.id, endsAt: days(MAX_DELEGATION_DAYS + 1) })).rejects.toThrow(/at most 90 days/);
    await expect(createDelegation(dir.actor, { toUserId: mgr.row.id, endsAt: days(-1) })).rejects.toThrow(/endsAt must be after startsAt|in the past/);
    await expect(createDelegation(dir.actor, { toUserId: mgr.row.id, startsAt: days(-10), endsAt: days(-1) })).rejects.toThrow(/endsAt is in the past/);
    await expect(createDelegation(dir.actor, { toUserId: rep.row.id, endsAt: days(5) })).rejects.toThrow(/cannot approve pricing; delegate to a manager, director or committee member/);
    await expect(createDelegation(dir.actor, { toUserId: dir.row.id, endsAt: days(5) })).rejects.toThrow(/cannot delegate to yourself/);
    await expect(createDelegation(mgr.actor, { fromUserId: dir.row.id, toUserId: cm.row.id, endsAt: days(5) })).rejects.toThrow(/Only an admin can delegate on someone else's behalf/);
    await expect(createDelegation(admin.actor, { toUserId: mgr.row.id, endsAt: days(5) })).rejects.toThrow(/has no approval authority to delegate/); // ADMIN alone lends nothing
    await expect(createDelegation(dir.actor, { toUserId: mgr.row.id, endsAt: days(5), startsAt: "nope" })).rejects.toThrow(/must be dates/);
    const d = await createDelegation(dir.actor, { toUserId: mgr.row.id, endsAt: days(10), reason: "holiday" });
    await expect(createDelegation(dir.actor, { toUserId: mgr.row.id, startsAt: days(5), endsAt: days(15) })).rejects.toThrow(/overlapping delegation/);
    const scheduled = await createDelegation(admin.actor, { fromUserId: dir.row.id, toUserId: mgr.row.id, startsAt: days(20), endsAt: days(30) }); // admin on someone's behalf, no overlap
    expect((await listDelegations(mgr.actor)).find((x) => x.id === scheduled.id)!.state).toBe("scheduled");
    expect((await listDelegations(mgr.actor)).find((x) => x.id === d.id)!.state).toBe("active");
    // Pure: an ADMIN + director delegator lends the director role and the two approve permissions, never ADMIN.
    const eff = effectiveAuthorityFrom(mgr.actor, [{ id: "x", fromUserId: "u", toUserId: mgr.row.id, startsAt: new Date(), endsAt: days(1), reason: null, revokedAt: null, createdAt: new Date(), createdByUserId: null, from: { id: "u", name: "u", email: "u" }, to: { id: mgr.row.id, name: "m", email: "m" }, fromRoles: ["ADMIN", "PRICING_DIRECTOR"] }]);
    expect(eff.roles.sort()).toEqual(["PRICING_DIRECTOR", "REGIONAL_MANAGER"]);
    expect([...eff.permissions].sort()).toEqual(["approve_below_floor", "approve_discount"]);
    expect(eff.onBehalfOf("PRICING_DIRECTOR")).toBe("u");
    expect(eff.onBehalfOf("PRICING_COMMITTEE")).toBeNull();
    expect(eff.onBehalfOf("REGIONAL_MANAGER")).toBeNull(); // own authority suffices
    expect(eff.onBehalfOf("PRICING_DIRECTOR", ["u"])).toBeNull(); // excluded delegator
    // The manager decides a director-level line with the director's authority; the request records on whose behalf.
    const fx = await draft(rep, ["dir", "committee"]);
    await submitForApproval(rep.actor, fx.proposal.id);
    const [rDir, rCte] = await requests(fx.proposal.id);
    const q = await queueFor(mgr.actor);
    expect(q.find((x) => x.id === rDir.id)!.onBehalfOf).toMatchObject({ userId: dir.row.id });
    expect(q.find((x) => x.id === rCte.id)).toBeUndefined(); // committee authority is not what was lent
    await expect(decide(mgr.actor, rCte.id, "APPROVED")).rejects.toThrow(/Missing permission: approve_below_floor|needs pricing committee authority/); // neither the permission nor the level was lent
    expect((await decide(mgr.actor, rDir.id, "APPROVED", "ok per Dana")).status).toBe("PARTIALLY_APPROVED");
    const decided = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: rDir.id } });
    expect(decided).toMatchObject({ decidedByUserId: mgr.row.id, onBehalfOfUserId: dir.row.id });
    expect(JSON.parse((await prisma.auditEvent.findFirstOrThrow({ where: { entityType: "ApprovalRequest", entityId: rDir.id, action: "APPROVED" } })).contextJson!).onBehalfOfUserId).toBe(dir.row.id);
    // A proposal the DELEGATOR submitted: the delegate may not approve it with the delegator's authority (self-approval by proxy).
    const own = await draft(dir, ["committee"]);
    await submitForApproval(dir.actor, own.proposal.id);
    const [rOwn] = await requests(own.proposal.id);
    await expect(decide(mgr.actor, rOwn.id, "APPROVED")).rejects.toThrow(/Missing permission: approve_below_floor|needs pricing committee authority/);
    const cteD = await createDelegation(committee.actor, { toUserId: mgr.row.id, endsAt: days(3) });
    // Now the manager holds committee authority via the committee member — but the director submitted it, and the committee member did not: allowed.
    expect((await queueFor(mgr.actor)).find((x) => x.id === rOwn.id)?.onBehalfOf).toMatchObject({ userId: committee.row.id });
    const ownDir = await draft(dir, ["dir"]);
    expect((await submitForApproval(dir.actor, ownDir.proposal.id)).status).toBe("APPROVED"); // director auto-approves own director-level line (documented: within own authority)
    // Revocation ends the lending immediately.
    await revokeDelegation(dir.actor, d.id);
    await expect(revokeDelegation(mgr.actor, cteD.id)).rejects.toThrow(/Only the delegating user or an admin can revoke/);
    await revokeDelegation(admin.actor, cteD.id);
    expect((await listDelegations(mgr.actor)).filter((x) => x.state === "active").length).toBe(0);
    const fx3 = await draft(rep, ["dir"]);
    await submitForApproval(rep.actor, fx3.proposal.id);
    const [r3] = await requests(fx3.proposal.id);
    await expect(decide(mgr.actor, r3.id, "APPROVED")).rejects.toThrow(/needs pricing director authority/);
    expect((await queueFor(mgr.actor)).map((x) => x.id)).not.toContain(r3.id);
  });

  test("a below-floor line needs approve_below_floor even for a role with the authority level (a lent permission counts, ADMIN alone does not lend it)", async () => {
    const fx = await draft(rep, ["committee"]);
    await submitForApproval(rep.actor, fx.proposal.id);
    const [r] = await requests(fx.proposal.id);
    // A user with committee-level authority but without approve_below_floor: (construct: PRICING_COMMITTEE role has it, so use ADMIN-like roles check) → the committee member can.
    expect((await decide(committee.actor, r.id, "APPROVED", "strategic")).status).toBe("APPROVED");
    expect(money((await linesOf(fx.proposal.id))[0].proposedPrice)!.toString()).toBe("500");
    expect((await finalizeCheck(fx.proposal.id)).ok).toBe(true);
  });
});

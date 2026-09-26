/**
 * Independent review — adversarial concurrency on the approval decision transaction.
 *
 * `decide()` claims ITS OWN request atomically (UPDATE … WHERE status = 'PENDING'), then derives
 * the proposal's status from `findMany(all requests)` inside the same transaction. Nothing locks
 * the PROPOSAL row before that read, so two approvers deciding two different lines of one
 * proposal at the same moment each see the other's request still PENDING (READ COMMITTED
 * snapshot taken before the other commits) and both write PARTIALLY_APPROVED — although every
 * request ends APPROVED. The stored economics rollup (approvalsPending) is stale the same way.
 *
 * The test submits a two-line proposal (two routed requests), decides both concurrently with a
 * PRICING_DIRECTOR who holds both authorities, and asserts the proposal status equals the status
 * derived from the committed requests. Repeated for several rounds because the window is short.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { D } from "@/lib/money";
import { setProposedPrice } from "@/lib/proposals/service";
import { submitForApproval, decide } from "@/lib/approvals/service";
import { proposalStatusFrom } from "@/lib/approvals/rules";
import { RUN, mkUser, mkProduct, mkAccount, mkProposal, mkPolicy, linesOf, cleanupRun } from "./ws2-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
type U = Awaited<ReturnType<typeof mkUser>>;

describe.skipIf(!hasDb)("REVIEW — concurrent decisions on two lines of one proposal", () => {
  let rep: U, dir: U;
  let acct: Awaited<ReturnType<typeof mkAccount>>;
  let prod: Awaited<ReturnType<typeof mkProduct>>;

  beforeAll(async () => {
    await cleanupRun();
    rep = await mkUser("rvrep", ["SALES_REP"]);
    dir = await mkUser("rvdir", ["PRICING_DIRECTOR"]);
    await mkPolicy();
    acct = await mkAccount({ name: "review acct" });
    prod = await mkProduct({ sku: "RV1", listPrice: "1000", cogs: "400" });
  });
  afterAll(async () => { await cleanupRun(); });

  test("after two simultaneous approvals every request is APPROVED and the proposal status / rollup agree with the requests", async () => {
    const ROUNDS = 6;
    const mismatches: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      // list 1000, cost 400: 22 % off → REGIONAL_MANAGER, 28 % off → CONTRACTING_MANAGER (both below a director).
      const fx = await mkProposal(rep.actor, { accountId: acct.id, lines: [{ code: `${RUN}RV${round}A`, qty: 10, productId: prod.id }, { code: `${RUN}RV${round}B`, qty: 10, productId: prod.id }] });
      await setProposedPrice(rep.actor, fx.lines[0].id, D("780"));
      await setProposedPrice(rep.actor, fx.lines[1].id, D("720"));
      fx.lines = await linesOf(fx.proposal.id);
      const sub = await submitForApproval(rep.actor, fx.proposal.id);
      expect(sub.routed).toBe(2);
      const reqs = await prisma.approvalRequest.findMany({ where: { proposalId: fx.proposal.id, status: "PENDING" } });
      expect(reqs.length).toBe(2);

      const results = await Promise.allSettled([decide(dir.actor, reqs[0].id, "APPROVED"), decide(dir.actor, reqs[1].id, "APPROVED")]);
      for (const r of results) expect(r.status, JSON.stringify(r)).toBe("fulfilled");

      const all = await prisma.approvalRequest.findMany({ where: { proposalId: fx.proposal.id } });
      expect(all.map((r) => r.status).sort()).toEqual(["APPROVED", "APPROVED"]);
      const p = await prisma.proposal.findUniqueOrThrow({ where: { id: fx.proposal.id } });
      const derived = proposalStatusFrom(all.filter((r) => !["WITHDRAWN", "EXPIRED"].includes(r.status)));
      const econ = JSON.parse(p.economicsJson ?? "{}") as { approvalsPending?: number; approvalsRequired?: number };
      const lines = await linesOf(fx.proposal.id);
      if (p.status !== derived || p.decidedAt === null || econ.approvalsPending !== 0) mismatches.push(`round ${round}: proposal.status=${p.status} derived=${derived} decidedAt=${p.decidedAt?.toISOString() ?? null} approvalsPending=${econ.approvalsPending} lineStates=${lines.map((l) => l.approvalState).join(",")}`);
    }
    // Every round must agree; the message lists the rounds that did not.
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});

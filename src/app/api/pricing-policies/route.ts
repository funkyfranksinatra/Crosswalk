import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { redactJsonForActor } from "@/lib/auth";
import { draftPolicy, toPolicy } from "@/lib/pricing/policy";
import type { PolicyInput } from "@/lib/pricing/policy-model";
export async function GET() {
  // Margin targets are the company's pricing rules: readable with view_pricing, but the margin
  // figures themselves follow the margin permission (they reconstruct cost from a target price).
  return handle("view_pricing", async (actor) => redactJsonForActor(actor, (await prisma.pricingPolicy.findMany({ orderBy: [{ productFamily: "asc" }, { version: "desc" }] })).map((r) => ({ ...toPolicy(r), name: r.name, effectiveFrom: r.effectiveFrom, supersededAt: r.supersededAt, createdAt: r.createdAt }))));
}
export async function POST(req: Request) {
  return handle("configure_pricing_rules", async (actor) => draftPolicy(actor.id, await body<PolicyInput>(req)));
}

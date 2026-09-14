import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { draftPolicy, toPolicy } from "@/lib/pricing/policy";
import type { PolicyInput } from "@/lib/pricing/policy-model";
export async function GET() {
  return handle("view_pricing", async () => (await prisma.pricingPolicy.findMany({ orderBy: [{ productFamily: "asc" }, { version: "desc" }] })).map((r) => ({ ...toPolicy(r), name: r.name, effectiveFrom: r.effectiveFrom, supersededAt: r.supersededAt, createdAt: r.createdAt })));
}
export async function POST(req: Request) {
  return handle("configure_pricing_rules", async (actor) => draftPolicy(actor.id, await body<PolicyInput>(req)));
}

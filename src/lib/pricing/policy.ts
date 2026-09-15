/**
 * Versioned pricing policy per product family — repository. Activating a new
 * version supersedes the previous active one; proposals pin the version id they used.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DEFAULT_POLICY, toPolicy, PolicyInputSchema, policyProblems, type Policy, type PolicyInput } from "./policy-model";

export * from "./policy-model";

/** Active policy for a family, falling back to "*". Returns the DEFAULT_POLICY (id "default") if nothing is configured. */
export async function activePolicies(): Promise<Map<string, Policy>> {
  const rows = await prisma.pricingPolicy.findMany({ where: { status: "ACTIVE" } });
  const map = new Map<string, Policy>();
  for (const r of rows) map.set(r.productFamily.toLowerCase(), toPolicy(r));
  return map;
}

export function policyFor(policies: Map<string, Policy>, family: string | null | undefined): Policy {
  return policies.get((family ?? "").toLowerCase()) ?? policies.get("*") ?? { id: "default", productFamily: "*", version: 0, status: "BUILTIN", ...DEFAULT_POLICY };
}

/** Create a new DRAFT version for a family (next version number). */
export async function draftPolicy(actorUserId: string | null, raw: PolicyInput) {
  const parsed = PolicyInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
  const input = parsed.data as PolicyInput;
  const last = await prisma.pricingPolicy.findFirst({ where: { productFamily: input.productFamily }, orderBy: { version: "desc" } });
  const base = last ? toPolicy(last) : { ...DEFAULT_POLICY };
  const merged = { ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Policy;
  const problems = policyProblems(merged);
  if (problems.length) throw new Error(`Invalid policy: ${problems.join("; ")}`);
  const row = await prisma.pricingPolicy.create({
    data: {
      productFamily: input.productFamily,
      version: (last?.version ?? 0) + 1,
      status: "DRAFT",
      name: input.name ?? null,
      targetMarginPct: merged.targetMarginPct,
      minMarginPct: merged.minMarginPct,
      floorMethod: merged.floorMethod,
      floorParamsJson: JSON.stringify(merged.floorParams ?? {}),
      defaultStrategy: merged.defaultStrategy,
      defaultAdjustmentPct: merged.defaultAdjustmentPct,
      classification: merged.classification,
      strategicImportance: merged.strategicImportance,
      authorityJson: JSON.stringify(merged.authority),
      approvalRulesJson: JSON.stringify(merged.approvalRules),
      createdByUserId: actorUserId,
    },
  });
  await audit({ actorUserId, entityType: "PricingPolicy", entityId: row.id, action: "DRAFTED", after: toPolicy(row) });
  return row;
}

/** Activate a draft: supersede the currently active version for the same family. */
export async function activatePolicy(actorUserId: string | null, id: string) {
  const row = await prisma.pricingPolicy.findUnique({ where: { id } });
  if (!row) throw new Error("policy not found");
  await prisma.$transaction([
    prisma.pricingPolicy.updateMany({ where: { productFamily: row.productFamily, status: "ACTIVE" }, data: { status: "SUPERSEDED", supersededAt: new Date() } }),
    prisma.pricingPolicy.update({ where: { id }, data: { status: "ACTIVE", effectiveFrom: new Date() } }),
  ]);
  await audit({ actorUserId, entityType: "PricingPolicy", entityId: id, action: "ACTIVATED", context: { productFamily: row.productFamily, version: row.version } });
}

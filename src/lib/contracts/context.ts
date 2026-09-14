/**
 * Loads everything the pricing waterfall needs for one account on one date, once,
 * then resolves any number of products against it (a proposal has dozens of lines).
 */
import { prisma } from "@/lib/db";
import { D, type Money } from "@/lib/money";
import { resolveFromInputs, type ContractInput, type MembershipInput, type PriceResolution } from "./resolve";
import { resolveCostFromInputs, type CostResolution, type CostInput } from "@/lib/catalog/cost";

export type PricingContext = {
  accountId: string | null;
  asOf: Date;
  currency: string;
  account: { id: string; name: string; parentAccountId: string | null; currency: string; region: string | null; isStrategic: boolean } | null;
  memberships: (MembershipInput & { gpoName: string })[];
  contracts: ContractInput[];
  resolvePrice(product: { id: string; sku: string; category: string | null; listPrice: unknown; currency: string; prices?: { id: string; pricebookId: string | null; pricebook?: { name: string } | null; contractId: string | null; price: unknown; currency: string; effectiveFrom: Date; effectiveTo: Date | null; tier: string | null; minQty: unknown; maxQty: unknown; volumeTierName: string | null; status: string; approvalState: string; productId: string }[] }, quantity: Money): PriceResolution;
  resolveCost(product: { id: string; cogs: unknown; currency: string; costs?: CostInput[] }): CostResolution;
  /** The single account-level contract (LOCAL) if any, for snapshotting on a proposal. */
  primaryContractId: string | null;
  primaryGpo: { id: string; name: string; tier: string | null } | null;
};

export async function loadPricingContext(opts: { accountId: string | null; asOf?: Date; currency?: string }): Promise<PricingContext> {
  const asOf = opts.asOf ?? new Date();
  const account = opts.accountId
    ? await prisma.account.findUnique({ where: { id: opts.accountId }, include: { memberships: { include: { gpo: true } } } })
    : null;
  const currency = opts.currency ?? account?.currency ?? "USD";
  const memberships = (account?.memberships ?? []).map((m) => ({ gpoId: m.gpoId, gpoName: m.gpo.name, tier: m.tier, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo }));
  const gpoIds = memberships.map((m) => m.gpoId);
  const parentId = account?.parentAccountId ?? null;
  const contracts = await prisma.contract.findMany({
    where: {
      OR: [
        { type: "NATIONAL" },
        ...(gpoIds.length ? [{ type: "GPO", gpoId: { in: gpoIds } }] : []),
        ...(parentId ? [{ type: "IDN", OR: [{ parentAccountId: parentId }, { accountId: parentId }] }] : []),
        ...(account ? [{ type: "LOCAL", accountId: account.id }] : []),
      ],
    },
    include: { scopes: true, entries: true },
  });
  const contractInputs: ContractInput[] = contracts.map((c) => ({
    id: c.id, contractNumber: c.contractNumber, name: c.name, type: c.type, status: c.status, accountId: c.accountId, parentAccountId: c.parentAccountId, gpoId: c.gpoId,
    tier: c.tier, currency: c.currency, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo, precedence: c.precedence,
    scopes: c.scopes.map((s) => ({ productFamily: s.productFamily, productId: s.productId })),
    entries: c.entries.map((e) => ({ id: e.id, productId: e.productId, price: e.price, currency: e.currency, effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo, tier: e.tier, minQty: e.minQty, maxQty: e.maxQty, volumeTierName: e.volumeTierName, status: e.status, approvalState: e.approvalState })),
  }));
  const local = contracts.filter((c) => c.type === "LOCAL" && c.status === "ACTIVE").sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;
  const activeMembership = memberships.find((m) => m.effectiveFrom <= asOf && (m.effectiveTo === null || asOf < m.effectiveTo)) ?? null;

  return {
    accountId: account?.id ?? null,
    asOf,
    currency,
    account: account ? { id: account.id, name: account.name, parentAccountId: account.parentAccountId, currency: account.currency, region: account.region, isStrategic: account.isStrategic } : null,
    memberships,
    contracts: contractInputs,
    primaryContractId: local?.id ?? null,
    primaryGpo: activeMembership ? { id: activeMembership.gpoId, name: activeMembership.gpoName, tier: activeMembership.tier } : null,
    resolvePrice(product, quantity) {
      const listEntries = (product.prices ?? []).filter((e) => e.pricebookId && !e.contractId).map((e) => ({ ...e, pricebookName: e.pricebook?.name ?? null }));
      return resolveFromInputs({
        product: { id: product.id, sku: product.sku, family: product.category, listPrice: product.listPrice, currency: product.currency },
        listEntries,
        account: account ? { id: account.id, parentAccountId: account.parentAccountId, currency: account.currency } : null,
        memberships,
        contracts: contractInputs,
        asOf,
        quantity: D(quantity),
        currency,
      });
    },
    resolveCost(product) {
      return resolveCostFromInputs({ productId: product.id, fallbackCogs: product.cogs, fallbackCurrency: product.currency, costs: product.costs ?? [], asOf, currency, region: account?.region ?? null, plant: null });
    },
  };
}

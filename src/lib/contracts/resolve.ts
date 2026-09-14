/**
 * Deterministic price resolution — the waterfall.
 *
 *   List → National → GPO tier → IDN / parent account → Local account contract
 *
 * `resolveFromInputs` is pure (no I/O) and fully tested; `PricingContext` loads the
 * inputs for an account once and resolves many products against them. The result
 * carries every step, including the ones that lost and why, so the UI and the audit
 * trail can show "which price applies and why" without re-deriving anything.
 */
import { Decimal, money, type Money } from "@/lib/money";

export type PriceLevel = "LIST" | "NATIONAL" | "GPO" | "IDN" | "LOCAL";
const NATURAL_RANK: Record<PriceLevel, number> = { LIST: 0, NATIONAL: 1, GPO: 2, IDN: 3, LOCAL: 4 };

export type ContractInput = {
  id: string;
  contractNumber: string;
  name: string;
  type: string; // LIST | NATIONAL | GPO | IDN | LOCAL
  status: string;
  accountId: string | null;
  parentAccountId: string | null;
  gpoId: string | null;
  tier: string | null;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  precedence: number;
  scopes: { productFamily: string | null; productId: string | null }[];
  entries: EntryInput[];
};

export type EntryInput = {
  id: string;
  productId: string;
  price: unknown; // Decimal-like
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  tier: string | null;
  minQty: unknown | null;
  maxQty: unknown | null;
  volumeTierName: string | null;
  status: string;
  approvalState: string;
  pricebookName?: string | null;
};

export type MembershipInput = { gpoId: string; gpoName?: string; tier: string | null; effectiveFrom: Date; effectiveTo: Date | null };

export type ResolveInputs = {
  product: { id: string; sku: string; family: string | null; listPrice: unknown | null; currency: string };
  listEntries: EntryInput[]; // legacy price-list (pricebook) entries for this product
  account: { id: string; parentAccountId: string | null; currency: string } | null;
  memberships: MembershipInput[];
  contracts: ContractInput[];
  asOf: Date;
  quantity: Money;
  currency?: string; // requested; defaults to account currency then product currency
};

export type PriceStep = {
  level: PriceLevel;
  price: string | null;
  currency: string;
  contractId?: string;
  contractNumber?: string;
  contractName?: string;
  entryId?: string;
  tier?: string | null;
  volumeTier?: string | null;
  rank: number;
  applied: boolean;
  reason: string;
};

export type PriceResolution = {
  price: Money | null;
  currency: string;
  source: PriceLevel | null;
  contractId: string | null;
  entryId: string | null;
  steps: PriceStep[];
  explanation: string;
  asOf: string;
};

const within = (asOf: Date, from: Date, to: Date | null) => from.getTime() <= asOf.getTime() && (to === null || asOf.getTime() < to.getTime());

function bandMatches(e: EntryInput, qty: Money): boolean {
  const lo = money(e.minQty as never), hi = money(e.maxQty as never);
  if (lo !== null && qty.lt(lo)) return false;
  if (hi !== null && qty.gt(hi)) return false;
  return true;
}

/** Pick the entry that applies for this product/qty/date inside one contract or price list. */
export function pickEntry(entries: EntryInput[], productId: string, asOf: Date, qty: Money, currency: string): { entry: EntryInput | null; reason: string } {
  const forProduct = entries.filter((e) => e.productId === productId);
  if (!forProduct.length) return { entry: null, reason: "no entry for this SKU" };
  const live = forProduct.filter((e) => e.status === "ACTIVE" && e.approvalState === "APPROVED" && within(asOf, e.effectiveFrom, e.effectiveTo));
  if (!live.length) return { entry: null, reason: "entry exists but is expired, pending or not yet effective" };
  const sameCcy = live.filter((e) => e.currency === currency);
  if (!sameCcy.length) return { entry: null, reason: `entry priced in ${live[0].currency}, not ${currency} (no silent conversion)` };
  const banded = sameCcy.filter((e) => bandMatches(e, qty));
  if (!banded.length) return { entry: null, reason: `quantity ${qty.toString()} outside every volume band` };
  // Most specific band (narrowest) then latest effective date.
  banded.sort((a, b) => {
    const wa = money(a.maxQty as never)?.minus(money(a.minQty as never) ?? 0) ?? new Decimal(1e12);
    const wb = money(b.maxQty as never)?.minus(money(b.minQty as never) ?? 0) ?? new Decimal(1e12);
    if (!wa.eq(wb)) return wa.lt(wb) ? -1 : 1;
    return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  });
  return { entry: banded[0], reason: banded.length > 1 ? "most specific volume band / latest effective entry" : "effective entry" };
}

function inScope(c: ContractInput, product: ResolveInputs["product"]): boolean {
  if (!c.scopes.length) return true;
  return c.scopes.some((s) => (s.productId && s.productId === product.id) || (s.productFamily && product.family && s.productFamily.toLowerCase() === product.family.toLowerCase()));
}

export function resolveFromInputs(input: ResolveInputs): PriceResolution {
  const currency = input.currency ?? input.account?.currency ?? input.product.currency;
  const steps: PriceStep[] = [];
  const asOf = input.asOf;

  // ---- LIST --------------------------------------------------------------
  const listFromProduct = money(input.product.listPrice as never);
  if (listFromProduct !== null && input.product.currency === currency) {
    steps.push({ level: "LIST", price: listFromProduct.toString(), currency, rank: 0, applied: false, reason: "catalog list price" });
  } else {
    const pick = pickEntry(input.listEntries, input.product.id, asOf, input.quantity, currency);
    if (pick.entry) steps.push({ level: "LIST", price: money(pick.entry.price as never)!.toString(), currency, entryId: pick.entry.id, rank: 0, applied: false, reason: `price list ${pick.entry.pricebookName ?? ""}`.trim() });
    else steps.push({ level: "LIST", price: null, currency, rank: 0, applied: false, reason: listFromProduct !== null ? `list price is in ${input.product.currency}, not ${currency}` : pick.reason });
  }

  // ---- Contract tiers -----------------------------------------------------
  const activeMemberships = input.memberships.filter((m) => within(asOf, m.effectiveFrom, m.effectiveTo));
  for (const c of input.contracts) {
    const level = (c.type === "LIST" ? "LIST" : c.type) as PriceLevel;
    if (!(level in NATURAL_RANK)) continue;
    const base = { level, currency, contractId: c.id, contractNumber: c.contractNumber, contractName: c.name, tier: c.tier, rank: c.precedence > 0 ? 10 + c.precedence : NATURAL_RANK[level], applied: false };
    if (c.status !== "ACTIVE") { steps.push({ ...base, price: null, reason: `contract status ${c.status}` }); continue; }
    if (!within(asOf, c.effectiveFrom, c.effectiveTo)) { steps.push({ ...base, price: null, reason: `contract not in force on ${asOf.toISOString().slice(0, 10)}` }); continue; }
    if (c.currency !== currency) { steps.push({ ...base, price: null, reason: `contract currency ${c.currency} ≠ ${currency}` }); continue; }
    if (!inScope(c, input.product)) { steps.push({ ...base, price: null, reason: "SKU / family outside contract scope" }); continue; }
    if (level === "GPO") {
      const m = activeMemberships.find((x) => x.gpoId === c.gpoId);
      if (!m) { steps.push({ ...base, price: null, reason: "account is not an active member of this GPO" }); continue; }
      if (c.tier && m.tier && c.tier.toLowerCase() !== m.tier.toLowerCase()) { steps.push({ ...base, price: null, reason: `contract tier ${c.tier} ≠ membership tier ${m.tier}` }); continue; }
    }
    if (level === "IDN") {
      const parent = input.account?.parentAccountId ?? null;
      const ok = (c.parentAccountId && c.parentAccountId === parent) || (c.accountId && c.accountId === parent);
      if (!ok) { steps.push({ ...base, price: null, reason: "not the account's parent / IDN" }); continue; }
    }
    if (level === "LOCAL") {
      if (!input.account || c.accountId !== input.account.id) { steps.push({ ...base, price: null, reason: "contract belongs to another account" }); continue; }
    }
    const pick = pickEntry(c.entries, input.product.id, asOf, input.quantity, currency);
    if (!pick.entry) { steps.push({ ...base, price: null, reason: pick.reason }); continue; }
    steps.push({ ...base, price: money(pick.entry.price as never)!.toString(), entryId: pick.entry.id, volumeTier: pick.entry.volumeTierName, reason: pick.reason });
  }

  // ---- Choose -------------------------------------------------------------
  const priced = steps.filter((s) => s.price !== null);
  priced.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    // Same rank (e.g. two local contracts): the customer-favourable price wins, and we say so.
    return new Decimal(a.price!).cmp(new Decimal(b.price!));
  });
  const winner = priced[0] ?? null;
  if (winner) {
    winner.applied = true;
    const tied = priced.filter((s) => s !== winner && s.rank === winner.rank);
    if (tied.length) winner.reason += "; lowest price among equal-precedence contracts";
  }
  const explanation = winner
    ? `${winner.level}${winner.contractNumber ? ` (${winner.contractNumber})` : ""} applies at ${currency} ${winner.price}: ${winner.reason}. ` +
      steps.filter((s) => s !== winner).map((s) => `${s.level}${s.contractNumber ? ` ${s.contractNumber}` : ""}: ${s.price !== null ? `${s.price} — outranked` : s.reason}`).join("; ")
    : `No applicable price: ${steps.map((s) => `${s.level}: ${s.reason}`).join("; ")}`;
  return {
    price: winner ? new Decimal(winner.price!) : null,
    currency,
    source: winner?.level ?? null,
    contractId: winner?.contractId ?? null,
    entryId: winner?.entryId ?? null,
    steps: steps.sort((a, b) => a.rank - b.rank),
    explanation,
    asOf: asOf.toISOString(),
  };
}

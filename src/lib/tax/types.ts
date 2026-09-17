/**
 * Tax provider contract (Tier 3.7). A provider turns a quote's lines and addresses into
 * tax amounts; Crosswalk never computes sales tax itself beyond the MANUAL rate a rep enters.
 * Amounts are plain strings/numbers here (the caller owns the decimal arithmetic) — the
 * provider is a transport, not a ledger.
 */
export type Address = { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postalCode?: string | null; country?: string | null };

export type TaxLine = { number: string; itemCode: string | null; description: string | null; quantity: string; amount: string; taxCode?: string | null };

export type TaxRequest = {
  currency: string;
  date: string; // YYYY-MM-DD
  customerCode: string;
  exemptionNo?: string | null;
  shipFrom: Address | null;
  shipTo: Address;
  lines: TaxLine[];
  /** Freight as its own line (providers tax freight by jurisdiction rules). */
  freight?: { amount: string; taxCode?: string | null } | null;
};

export type TaxResult = {
  provider: string;
  totalTax: string;
  totalTaxable: string;
  totalExempt: string;
  lines: { number: string; tax: string; taxable: string; rate: number | null }[];
  summary: { jurisdiction: string; taxName: string; rate: number | null; tax: string }[];
  note?: string | null;
  raw?: unknown;
};

export interface TaxProvider {
  readonly name: string;
  configured(): boolean;
  calculate(req: TaxRequest): Promise<TaxResult>;
}

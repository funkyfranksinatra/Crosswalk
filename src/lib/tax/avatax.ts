/**
 * Avalara AvaTax REST v2 adapter — `POST /api/v2/transactions/create` as an uncommitted
 * SalesOrder (a quote never creates a tax document). Credentials from the environment:
 *   AVATAX_ACCOUNT_ID, AVATAX_LICENSE_KEY, AVATAX_COMPANY_CODE, AVATAX_ENV (sandbox|production)
 *   AVATAX_ITEM_TAX_CODE (default P0000000), AVATAX_FREIGHT_TAX_CODE (default FR020100)
 * TAX_DRY_RUN=true returns zero tax without calling Avalara (demos, CI).
 * Fetch is injectable for tests; the recorded shape follows Avalara's TransactionModel.
 */
import { money, ZERO } from "@/lib/money";
import { log } from "@/lib/log";
import type { Address, TaxProvider, TaxRequest, TaxResult } from "./types";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike | null = null;
export function setAvataxFetchForTests(fn: FetchLike | null) { fetchImpl = fn; }

export function avataxConfig() {
  const accountId = process.env.AVATAX_ACCOUNT_ID?.trim(), licenseKey = process.env.AVATAX_LICENSE_KEY?.trim(), companyCode = process.env.AVATAX_COMPANY_CODE?.trim();
  const env = (process.env.AVATAX_ENV ?? "sandbox").toLowerCase();
  const baseUrl = process.env.AVATAX_BASE_URL?.trim() || (env === "production" ? "https://rest.avatax.com" : "https://sandbox-rest.avatax.com");
  return { accountId, licenseKey, companyCode, env, baseUrl, configured: Boolean(accountId && licenseKey && companyCode), dryRun: (process.env.TAX_DRY_RUN ?? "false").toLowerCase() === "true", itemTaxCode: process.env.AVATAX_ITEM_TAX_CODE?.trim() || "P0000000", freightTaxCode: process.env.AVATAX_FREIGHT_TAX_CODE?.trim() || "FR020100" };
}

const addr = (a: Address | null | undefined) => (a ? { line1: a.line1 ?? undefined, line2: a.line2 ?? undefined, city: a.city ?? undefined, region: a.region ?? undefined, postalCode: a.postalCode ?? undefined, country: a.country ?? "US" } : undefined);

export class AvataxProvider implements TaxProvider {
  readonly name = "avatax";
  configured() { return avataxConfig().configured; }
  async calculate(req: TaxRequest): Promise<TaxResult> {
    const cfg = avataxConfig();
    if (!cfg.configured) throw new Error("AvaTax is not configured (AVATAX_ACCOUNT_ID / AVATAX_LICENSE_KEY / AVATAX_COMPANY_CODE)");
    if (!req.shipTo || !(req.shipTo.postalCode || (req.shipTo.city && req.shipTo.region))) throw new Error("A ship-to address (postal code, or city + state) is needed to calculate tax");
    if (cfg.dryRun) {
      return { provider: "avatax (dry run)", totalTax: "0", totalTaxable: "0", totalExempt: req.lines.reduce((s, l) => s.plus(money(l.amount) ?? ZERO), ZERO).toString(), lines: req.lines.map((l) => ({ number: l.number, tax: "0", taxable: "0", rate: null })), summary: [], note: "dry run (TAX_DRY_RUN=true) — no call to Avalara; tax shown as 0" };
    }
    const body = {
      type: "SalesOrder", companyCode: cfg.companyCode, date: req.date, customerCode: req.customerCode.slice(0, 50), currencyCode: req.currency, commit: false,
      ...(req.exemptionNo ? { exemptionNo: req.exemptionNo } : {}),
      addresses: { ...(req.shipFrom ? { shipFrom: addr(req.shipFrom) } : {}), shipTo: addr(req.shipTo) },
      lines: [
        ...req.lines.map((l) => ({ number: l.number, quantity: Number(l.quantity), amount: Number(l.amount), itemCode: l.itemCode ?? undefined, description: l.description?.slice(0, 255) ?? undefined, taxCode: l.taxCode ?? cfg.itemTaxCode })),
        ...(req.freight && money(req.freight.amount)?.gt(0) ? [{ number: "FREIGHT", quantity: 1, amount: Number(req.freight.amount), itemCode: "FREIGHT", description: "Freight", taxCode: req.freight.taxCode ?? cfg.freightTaxCode }] : []),
      ],
    };
    if (!req.shipFrom) log.warn("tax.avatax_no_ship_from", { note: "shipFrom missing; Avalara uses the company's default location" });
    const auth = Buffer.from(`${cfg.accountId}:${cfg.licenseKey}`).toString("base64");
    const res = await (fetchImpl ?? fetch)(`${cfg.baseUrl}/api/v2/transactions/create`, { method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json", "x-avalara-client": "Crosswalk; 0.5; Crosswalk; ; " }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.TAX_TIMEOUT_MS ?? 20_000)) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { throw new Error(`AvaTax returned a non-JSON ${res.status} response`); }
    if (!res.ok) {
      const err = json.error as { code?: string; message?: string; details?: { message?: string; description?: string }[] } | undefined;
      throw new Error(`AvaTax ${res.status}: ${err?.message ?? text.slice(0, 200)}${err?.details?.[0]?.description ? ` — ${err.details[0].description}` : ""}`);
    }
    const lines = ((json.lines as { lineNumber?: string; tax?: number; taxableAmount?: number; details?: { rate?: number }[] }[]) ?? []).map((l) => ({ number: String(l.lineNumber ?? ""), tax: String(l.tax ?? 0), taxable: String(l.taxableAmount ?? 0), rate: l.details?.length ? l.details.reduce((s, d) => s + (d.rate ?? 0), 0) : null }));
    const summary = ((json.summary as { jurisName?: string; taxName?: string; rate?: number; tax?: number }[]) ?? []).map((s) => ({ jurisdiction: s.jurisName ?? "", taxName: s.taxName ?? "", rate: s.rate ?? null, tax: String(s.tax ?? 0) }));
    return { provider: this.name, totalTax: String(json.totalTax ?? 0), totalTaxable: String(json.totalTaxable ?? 0), totalExempt: String(json.totalExempt ?? 0), lines, summary, note: `AvaTax ${cfg.env}${req.exemptionNo ? ` · exemption ${req.exemptionNo}` : ""}`, raw: { id: json.id, code: json.code, status: json.status, totalAmount: json.totalAmount } };
  }
}

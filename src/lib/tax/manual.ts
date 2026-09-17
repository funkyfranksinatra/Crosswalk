/**
 * MANUAL tax: one rate the rep (or the account default) supplies. Freight is taxed when
 * TAX_FREIGHT=true (state rules differ; the default leaves freight untaxed). The math is
 * decimal.js through the shared money helpers — never floats.
 */
import { money, round, ZERO, type Money } from "@/lib/money";
import type { TaxProvider, TaxRequest, TaxResult } from "./types";

export class ManualTaxProvider implements TaxProvider {
  readonly name = "manual";
  constructor(private rate: Money) {}
  configured() { return true; }
  async calculate(req: TaxRequest): Promise<TaxResult> {
    const taxFreight = (process.env.TAX_FREIGHT ?? "false").toLowerCase() === "true";
    const exempt = Boolean(req.exemptionNo);
    let taxable = ZERO, tax = ZERO;
    const lines = req.lines.map((l) => {
      const amt = money(l.amount) ?? ZERO;
      const t = exempt ? ZERO : round(amt.times(this.rate), req.currency);
      taxable = taxable.plus(exempt ? ZERO : amt); tax = tax.plus(t);
      return { number: l.number, tax: t.toString(), taxable: (exempt ? ZERO : amt).toString(), rate: exempt ? 0 : this.rate.toNumber() };
    });
    if (req.freight && taxFreight && !exempt) { const f = money(req.freight.amount) ?? ZERO; const t = round(f.times(this.rate), req.currency); taxable = taxable.plus(f); tax = tax.plus(t); lines.push({ number: "FREIGHT", tax: t.toString(), taxable: f.toString(), rate: this.rate.toNumber() }); }
    const total = req.lines.reduce((s, l) => s.plus(money(l.amount) ?? ZERO), ZERO).plus(money(req.freight?.amount) ?? ZERO);
    return { provider: this.name, totalTax: tax.toString(), totalTaxable: taxable.toString(), totalExempt: total.minus(taxable).toString(), lines, summary: [{ jurisdiction: "manual rate", taxName: exempt ? "exempt" : "sales tax", rate: exempt ? 0 : this.rate.toNumber(), tax: tax.toString() }], note: exempt ? `Exempt (certificate ${req.exemptionNo})` : `Manual rate ${this.rate.times(100).toFixed(3)}%${taxFreight ? ", freight taxed" : ", freight untaxed"}` };
  }
}

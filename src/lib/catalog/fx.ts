/**
 * Explicit currency conversion. Nothing calls this implicitly: callers ask for a
 * conversion, get back the rate row they used, and store its id. Same-currency
 * conversion is the identity and records no rate.
 */
import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";

export type Conversion = { amount: Money; from: string; to: string; rateId: string | null; rate: string; asOf: string };

export async function convert(amount: Money, from: string, to: string, asOf = new Date()): Promise<Conversion> {
  if (from === to) return { amount, from, to, rateId: null, rate: "1", asOf: asOf.toISOString() };
  const row = await prisma.exchangeRate.findFirst({ where: { fromCurrency: from, toCurrency: to, asOf: { lte: asOf } }, orderBy: { asOf: "desc" } });
  if (!row) throw new Error(`No exchange rate ${from}→${to} on or before ${asOf.toISOString().slice(0, 10)}. Add one under Settings → Exchange rates.`);
  const rate = money(row.rate)!;
  return { amount: amount.times(rate), from, to, rateId: row.id, rate: rate.toString(), asOf: row.asOf.toISOString() };
}

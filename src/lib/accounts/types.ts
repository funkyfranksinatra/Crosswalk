/** Account types — one vocabulary for the API, the CRM sync and the database CHECK constraint. */
export const ACCOUNT_TYPES = ["SOLD_TO", "SHIP_TO", "BILL_TO", "IDN", "HEALTH_SYSTEM", "GROUP", "GPO_MEMBER"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
/** CRM feeds spell types their own way ("Sold-To"); unknown values fall back rather than fail the row. */
export function normalizeAccountType(v: unknown, fallback: AccountType = "SOLD_TO"): AccountType {
  const s = String(v ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (ACCOUNT_TYPES as readonly string[]).includes(s) ? (s as AccountType) : fallback;
}

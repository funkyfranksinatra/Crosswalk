/**
 * Catalog / model number (CFN) handling.
 *
 * Sales-rep spreadsheets are messy: Excel turns "174006" into the number
 * 174006, hospitals prefix distributor item numbers ("3583" + "174006"),
 * and reps type "SIG45-AMT" for "SIG45AMT". We keep the raw value for
 * display and match on a normalised form; the resolver (src/lib/pipeline/resolve.ts
 * `variantsFor`) generates the tiered lookup variants before falling back to the LLM.
 */

export function normalizeCfn(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = typeof raw === "number" ? formatNumberCell(raw) : String(raw);
  // Invisible characters a copy-paste drags along (BOM, zero-width, NBSP) and typographic dashes
  // ("B12‑LT" pasted from a PDF) are the same catalog number.
  // Compatibility folding first: fullwidth "ＡＢＣ１２３" pasted from an East-Asian PDF is "ABC123".
  s = s.normalize("NFKC");
  s = s.replace(/[\u00A0\u2000-\u200D\u202F\u2060\uFEFF]/g, " ").replace(/[\u2010-\u2015\u2212\u2043]/g, "-");
  s = s.trim().toUpperCase();
  // collapse internal whitespace
  s = s.replace(/\s+/g, "");
  return s;
}

function formatNumberCell(n: number): string {
  // 1190500 -> "1190500"; 1.19e6 style floats from Excel are integers in practice
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/**
 * Spreadsheet placeholders that mean "there is no product here", not a catalog number:
 * a curated sheet's "No Match" in the SKU column, a report's TOTAL row, "N/A", "TBD"…
 * Nothing that passes this may become an own product, a candidate or a cross.
 */
const PLACEHOLDER_SKUS = new Set(["NOMATCH", "NO-MATCH", "NONE", "NA", "N/A", "N-A", "TBD", "TBA", "TOTAL", "SUBTOTAL", "DISC", "DISCONTINUED", "DELETE", "UNKNOWN", "PENDING", "?", "-", "--", "NULL", "X"]);
export function isPlaceholderSku(raw: unknown): boolean {
  const s = normalizeCfn(raw);
  if (!s) return true;
  if (PLACEHOLDER_SKUS.has(s) || PLACEHOLDER_SKUS.has(s.replace(/[^A-Z0-9?/-]/g, ""))) return true;
  // "NO MATCH FOUND", "NOT APPLICABLE", "SEE NOTES", and anything without a digit or at least 3 letters.
  if (/^(NO|NOT)(MATCH|EQUIV|APPLIC|AVAIL|CROSS)/.test(s) || /^SEE[A-Z]*$/.test(s)) return true;
  return !/[0-9]/.test(s) && !/[A-Z]{3,}/.test(s);
}

/** Strip characters that are commonly optional in catalog numbers. */
export function compactCfn(cfn: string): string {
  return cfn.replace(/[^A-Z0-9]/g, "");
}

/** Cheap check used by the intake parser to skip junk rows. */
export function looksLikeCfn(s: string): boolean {
  // Three or more alphanumerics in total — not in one run: hyphenated short segments ("IN-12-4",
  // a Genicon-style code) are real catalog numbers and used to be dropped at intake.
  // At most 42 characters (the intake reports longer values as "longer than any catalog number").
  return /^[A-Z0-9][A-Z0-9\-./_]{1,41}$/.test(s) && s.replace(/[^A-Z0-9]/g, "").length >= 3;
}

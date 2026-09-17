/**
 * Catalog / model number (CFN) handling.
 *
 * Sales-rep spreadsheets are messy: Excel turns "174006" into the number
 * 174006, hospitals prefix distributor item numbers ("3583" + "174006"),
 * and reps type "SIG45-AMT" for "SIG45AMT". We keep the raw value for
 * display and match on a normalised form, and we generate a short list of
 * plausible variants for lookup before falling back to the LLM.
 */

export function normalizeCfn(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = typeof raw === "number" ? formatNumberCell(raw) : String(raw);
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

/**
 * Ordered lookup variants: most specific first. Each variant is tagged so
 * the resolution note can explain *why* a hit was accepted.
 */
export function cfnVariants(cfnNorm: string): { value: string; reason: string }[] {
  const out: { value: string; reason: string }[] = [];
  const seen = new Set<string>();
  const push = (value: string, reason: string) => {
    const v = value.trim();
    if (v.length >= 3 && !seen.has(v)) {
      seen.add(v);
      out.push({ value: v, reason });
    }
  };

  push(cfnNorm, "exact");
  const compact = compactCfn(cfnNorm);
  push(compact, "punctuation removed");

  // Trailing "X" / "-S" / "S" style suffixes often mean sterile / single pack
  if (/[A-Z0-9]X$/.test(compact) && compact.length > 5) push(compact.slice(0, -1), "trailing X removed");
  if (/-S$/.test(cfnNorm)) push(cfnNorm.slice(0, -2), "-S suffix removed");

  // Distributor / hospital item-number prefixes: e.g. "3583174006" -> "174006"
  // Only when the remainder still looks like a real catalog number.
  const m = compact.match(/^(\d{3,5})([A-Z0-9]{5,})$/);
  if (m) push(m[2], `leading prefix ${m[1]} removed`);

  // Leading zeros dropped by Excel: "0104" -> "104"; we can't add zeros
  // back reliably, but we can try a couple of common widths.
  if (/^\d+$/.test(compact) && compact.length < 6) {
    push(compact.padStart(6, "0"), "zero-padded to 6");
    push(compact.padStart(5, "0"), "zero-padded to 5");
  }

  return out;
}

/** Cheap check used by the intake parser to skip junk rows. */
export function looksLikeCfn(s: string): boolean {
  return /^[A-Z0-9][A-Z0-9\-./_]{1,40}$/.test(s) && /[A-Z0-9]{3,}/.test(s);
}

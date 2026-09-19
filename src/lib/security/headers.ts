/**
 * Security headers (Tier 0.5). A nonce-based Content Security Policy for pages — Next.js
 * picks the nonce up from the CSP request header for its own inline scripts — plus the
 * usual hardening headers on every response. Pure; the proxy applies them.
 *
 * Choices, and why:
 *   script-src  'self' 'nonce-…' 'strict-dynamic'   no inline or third-party script runs
 *               without the per-request nonce ('unsafe-eval' only under `next dev`, for
 *               React's stack reconstruction)
 *   style-src   'self' 'unsafe-inline'              Tailwind is a stylesheet, but the UI sets
 *               a few `style=` attributes (bar widths, brand colours); inline styles cannot
 *               execute code, so this is the accepted trade
 *   img-src     'self' data: blob:                  branding logos and generated previews are
 *               data URLs
 *   connect-src 'self'                              the browser only ever talks to this app
 *   frame-ancestors 'none'                          never framed (clickjacking)
 *   upgrade-insecure-requests                       only when the request arrived over TLS
 * CSP_REPORT_ONLY=true switches to Content-Security-Policy-Report-Only for a soft rollout.
 */

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function contentSecurityPolicy(nonce: string, opts: { dev?: boolean; https?: boolean; extraConnect?: string[] } = {}): string {
  const connect = ["'self'", ...(opts.extraConnect ?? [])].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only once the app is actually served over TLS: on plain HTTP it would break every asset load.
    ...(opts.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Headers every response carries (pages, API, downloads). */
export function hardeningHeaders(opts: { https: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "cross-origin-opener-policy": "same-origin",
    "x-dns-prefetch-control": "off",
  };
  if (opts.https) h["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  return h;
}

/** Whether the request arrived over TLS (directly, or as the proxy reports it). */
export function isHttps(url: URL, headers: Headers): boolean {
  return url.protocol === "https:" || headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
}

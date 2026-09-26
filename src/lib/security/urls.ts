/**
 * Outbound URL policy for operator-configured endpoints (integration base URLs, extraction
 * endpoints, FX providers): http(s) only, no credentials in the URL, and no loopback, link-local,
 * private-range or metadata hosts — the application must never be a proxy into its own network
 * (SSRF). Pure; offered to the integration field validator (src/lib/integrations/core/fields.ts,
 * WS5) and usable by any route that accepts a URL from a person.
 *
 * Literal addresses are classified here; a DNS name that resolves to a private address is
 * only caught at connect time — pair this with egress rules on the platform for a full answer.
 */
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata", "instance-data", "ip6-localhost", "ip6-loopback"]);

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return true;
  if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.test(s)) return ipv4Private(s.slice(7));
  const mapped = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1
  if (mapped) { const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16); return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  return /^(fc|fd|fe[89ab])/.test(s);
}

export type UrlProblem = "scheme" | "credentials" | "host" | "private" | "unparsable";

/** Why a URL may not be used as an outbound endpoint, or null when it may. */
export function outboundUrlProblem(raw: string): UrlProblem | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return "unparsable"; }
  if (!/^https?:$/.test(u.protocol)) return "scheme";
  if (u.username || u.password) return "credentials";
  const host = u.hostname.toLowerCase();
  if (!host) return "host";
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "private";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? ipv4Private(host) : host.includes(":") ? ipv6Private(host) : /^0x[0-9a-f]+$|^\d+$/.test(host)) return "private"; // decimal / hex single-number hosts resolve to loopback-class addresses
  return null;
}

export function assertOutboundUrl(raw: string, label = "URL"): URL {
  const problem = outboundUrlProblem(raw);
  if (problem) throw new Error({ scheme: `${label} must be http(s)`, credentials: `${label} must not embed credentials`, host: `${label} has no host`, private: `${label} must not point at a loopback, link-local, private or metadata address`, unparsable: `${label} is not a valid URL` }[problem]);
  return new URL(raw.trim());
}

import { NextResponse } from "next/server";
import { handleSalesforceWebhook } from "@/lib/integrations/salesforce/webhook";

const MAX_BYTES = 256 * 1024;

/**
 * Unauthenticated endpoint: the HMAC signature is the authentication. No session, no cookies
 * — the proxy opens exactly `POST /api/webhooks/salesforce` (src/proxy.ts OPEN). The size cap
 * is checked on the declared length before reading and on the real byte length after.
 */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BYTES) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const r = await handleSalesforceWebhook(req.headers, raw);
  return NextResponse.json(r.body, { status: r.status });
}

import { NextResponse } from "next/server";
import { handleSalesforceWebhook } from "@/lib/integrations/salesforce/webhook";

/** Unauthenticated endpoint: the HMAC signature is the authentication. No session, no cookies. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 256 * 1024) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const r = await handleSalesforceWebhook(req.headers, raw);
  return NextResponse.json(r.body, { status: r.status });
}

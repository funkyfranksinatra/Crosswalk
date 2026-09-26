import { handle } from "@/lib/api";
import { renewalPipeline } from "@/lib/compliance";
import { scopeFor, contractWhere } from "@/lib/auth/scope";
/** `?days=` is a whole number of days 1–3650 (default 180); anything else is a 400, never NaN into a date. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("days");
  return handle("view_pricing", async (actor) => {
    const days = raw === null || raw === "" ? 180 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("days must be a whole number between 1 and 3650");
    return renewalPipeline(days, contractWhere(await scopeFor(actor)));
  });
}

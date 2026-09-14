import { handle } from "@/lib/api";
import { renewalPipeline } from "@/lib/compliance";
export async function GET(req: Request) { const days = Number(new URL(req.url).searchParams.get("days") ?? 180); return handle("view_pricing", async () => renewalPipeline(days)); }

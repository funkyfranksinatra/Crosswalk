import { handle } from "@/lib/api";
import { queueFor } from "@/lib/approvals/service";
export async function GET() { return handle("view_pricing", async (actor) => queueFor(actor)); }

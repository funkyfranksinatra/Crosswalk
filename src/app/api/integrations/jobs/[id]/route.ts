import { handle } from "@/lib/api";
import { jobDetail } from "@/lib/integrations/core/admin";

/** One sync job with its row-level errors. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle("configure_settings", async () => jobDetail((await ctx.params).id));
}

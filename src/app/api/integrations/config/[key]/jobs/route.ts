import { handle } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { listJobs } from "@/lib/integrations/core/admin";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return handle("configure_settings", async () => {
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) throw new Error("not found");
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
    return { jobs: await listJobs(key, Number.isFinite(limit) ? limit : 50) };
  });
}

import { handle } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { testConnection } from "@/lib/integrations/core/runner";

export async function POST(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  return handle("configure_settings", async (actor) => {
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) throw new Error("not found");
    return testConnection(key, actor.id);
  });
}

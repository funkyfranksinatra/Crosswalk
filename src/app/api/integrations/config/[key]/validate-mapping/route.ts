import { handle, body } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { validateIntegrationMapping } from "@/lib/integrations/core/runner";

/** Validate the effective mapping against the canonical specs; `live: true` also checks field names against the provider. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return handle("configure_settings", async () => {
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) throw new Error("not found");
    const { live } = await body<{ live?: boolean }>(req);
    return validateIntegrationMapping(key, live === true);
  });
}

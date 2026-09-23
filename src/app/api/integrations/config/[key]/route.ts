import { handle, body } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { integrationDetail, saveIntegration, type AdminSaveBody } from "@/lib/integrations/core/admin";

type Ctx = { params: Promise<{ key: string }> };
const keyOf = async (ctx: Ctx) => { const { key } = await ctx.params; if (!isIntegrationKey(key)) throw new Error("not found"); return key; };

/** Definition + saved configuration (secrets as present/absent only) + recent jobs. */
export async function GET(_req: Request, ctx: Ctx) {
  return handle("configure_settings", async () => integrationDetail(await keyOf(ctx)));
}

/** Save provider, non-secret config, secrets (value = set, "" = clear, absent = keep), mapping overrides, schedule, enabled. */
export async function PUT(req: Request, ctx: Ctx) {
  return handle("configure_settings", async (actor) => {
    const k = await keyOf(ctx);
    const out = await saveIntegration(k, await body<AdminSaveBody>(req), actor.id);
    return { ...out, detail: await integrationDetail(k) };
  });
}

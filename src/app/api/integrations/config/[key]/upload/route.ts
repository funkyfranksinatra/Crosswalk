import { handle } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { runSync } from "@/lib/integrations/core/runner";
import { definition } from "@/lib/integrations/core/registry";

const MAX_BYTES = 25 * 1024 * 1024;

/** Run a file-based sync (roster, contract prices) on an uploaded file instead of the configured location. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return handle("configure_settings", async (actor) => {
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) throw new Error("not found");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("attach a CSV or XLSX file");
    if (file.size > MAX_BYTES) throw new Error("file is larger than 25 MB");
    if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("only .csv and .xlsx files are accepted");
    const def = await definition(key);
    const syncType = String(form.get("syncType") ?? def.syncTypes.find((s) => s.acceptsUpload)?.id ?? "");
    return runSync(key, syncType, "manual", actor.id, { upload: { filename: file.name, buffer: Buffer.from(await file.arrayBuffer()) } });
  });
}

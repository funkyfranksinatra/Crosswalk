import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { runSync } from "@/lib/integrations/core/runner";
import { definition } from "@/lib/integrations/core/registry";

/**
 * Manual sync. `mode: "test"` runs the first page inline (the "sync a test record" button —
 * no watermark moves); otherwise the run is queued on integration.sync (one per integration +
 * sync type at a time) and the caller polls the jobs list. `full: true` ignores the watermark.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return handle("configure_settings", async (actor) => {
    const { key } = await ctx.params;
    if (!isIntegrationKey(key)) throw new Error("not found");
    const b = await body<{ syncType?: string; mode?: "test" | "queue" | "inline"; full?: boolean }>(req);
    const def = await definition(key);
    const syncType = String(b.syncType ?? def.syncTypes[0]?.id ?? "");
    if (!def.syncTypes.some((s) => s.id === syncType)) throw new Error(`syncType must be one of ${def.syncTypes.map((s) => s.id).join(", ") || "(none)"}`);
    if (b.mode === "test") return runSync(key, syncType, "manual", actor.id, { maxPages: 1 });
    if (b.mode === "inline") return runSync(key, syncType, "manual", actor.id, { full: b.full === true });
    const running = await prisma.integrationSyncJob.findFirst({ where: { integrationKey: key, syncType, status: "RUNNING" }, select: { id: true } });
    if (running) throw new Error(`a ${syncType} sync is already running (job ${running.id})`);
    const { enqueue } = await import("@/lib/jobs/boss");
    const { jobId, deduplicated } = await enqueue("integration.sync", { key, syncType, trigger: "manual", actorUserId: actor.id, full: b.full === true }, { singletonKey: `integration:${key}:${syncType}` });
    if (deduplicated) throw new Error(`a ${syncType} sync is already queued`);
    return { queued: true, queueJobId: jobId };
  });
}

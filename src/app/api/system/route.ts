import { handle, body } from "@/lib/api";
import { prisma } from "@/lib/db";
import { channelsConfigured } from "@/lib/notifications";
import { llmConfig } from "@/lib/llm/client";

/** Settings → System: queues, recent failures, feeds, alerts, model — for people with configure_settings. */
export async function GET() {
  return handle("configure_settings", async () => {
    const { queueHealth, recentFailures, jobsEnabled } = await import("@/lib/jobs/boss");
    const { feedStatuses } = await import("@/lib/feeds");
    const { activeAlerts } = await import("@/lib/observability/alerts");
    const { bucketState } = await import("@/lib/gudid/http");
    const { ttlDays } = await import("@/lib/gudid/refresh");
    const [queues, failures, feeds, alerts, recentAlerts] = await Promise.all([
      jobsEnabled() ? queueHealth().catch(() => []) : Promise.resolve([]),
      jobsEnabled() ? recentFailures(20).catch(() => []) : Promise.resolve([]),
      feedStatuses(),
      activeAlerts(),
      prisma.alert.findMany({ where: { resolvedAt: { not: null } }, orderBy: { resolvedAt: "desc" }, take: 10 }),
    ]);
    const llmRecent = await prisma.llmCall.groupBy({ by: ["ok"], _count: { _all: true }, where: { createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    return {
      jobs: { enabled: jobsEnabled(), mode: process.env.JOBS_WORKER ?? "inline", queues, failures },
      feeds,
      alerts: { active: alerts, recentlyResolved: recentAlerts },
      model: { ...llmConfig(), last24h: { ok: llmRecent.find((r) => r.ok)?._count._all ?? 0, failed: llmRecent.find((r) => !r.ok)?._count._all ?? 0 } },
      openfda: { ...bucketState(), cacheTtlDays: ttlDays() },
      notifications: channelsConfigured(),
      logging: { format: process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "pretty"), level: process.env.LOG_LEVEL ?? "info" },
      tenancy: await (await import("@/lib/tenancy")).tenancyStatus(),
      embeddings: await (await import("@/lib/match/embeddings")).embeddingCoverage(),
      tax: (await import("@/lib/tax")).taxProviderStatus(),
    };
  });
}

/** Actions: evaluate alerts now; refresh stale GUDID records now. */
export async function POST(req: Request) {
  return handle("configure_settings", async (actor) => {
    const { action } = await body<{ action?: string }>(req);
    const { enqueue } = await import("@/lib/jobs/boss");
    if (action === "evaluate-alerts") { const { evaluateAlerts } = await import("@/lib/observability/alerts"); return evaluateAlerts(); }
    if (action === "refresh-gudid") return enqueue("gudid.refresh", { limit: 500 }, { singletonKey: "refresh:manual" });
    if (action === "retry-failed") {
      const { getBoss } = await import("@/lib/jobs/boss");
      const { recentFailures } = await import("@/lib/jobs/boss");
      const boss = await getBoss();
      let resumed = 0;
      // `retry` is for failed jobs (`resume` is for cancelled ones); a retried run resumes from its checkpoint.
      for (const f of await recentFailures(50)) { await boss.retry(f.queue, f.id).then(() => resumed++).catch(() => undefined); }
      const { audit } = await import("@/lib/audit");
      await audit({ actorUserId: actor.id, entityType: "Jobs", entityId: "retry-failed", action: "JOBS_RETRIED", after: { resumed } });
      return { resumed };
    }
    throw new Error("action must be evaluate-alerts, refresh-gudid or retry-failed");
  });
}

import { handle, body } from "@/lib/api";
import { FEEDS, feedStatuses, requestIngest, type FeedName } from "@/lib/feeds";
import { prisma } from "@/lib/db";

export async function GET() {
  return handle("configure_settings", async () => ({ feeds: await feedStatuses(), runs: await prisma.feedRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 }) }));
}

/** Run a feed now (queued). */
export async function POST(req: Request) {
  return handle("configure_settings", async (actor) => {
    const { feed, force } = await body<{ feed?: string; force?: boolean }>(req);
    if (!feed || !(feed in FEEDS)) throw new Error(`feed must be one of ${Object.keys(FEEDS).join(", ")}`);
    return requestIngest(feed as FeedName, actor.id, Boolean(force));
  });
}

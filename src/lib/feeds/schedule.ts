/**
 * Register every feed's cron with pg-boss (idempotent per feed key) and, optionally,
 * run the feeds once at worker start so a fresh deployment is never behind.
 */
import type { PgBoss } from "pg-boss";
import { FEEDS, feedCron, type FeedName } from "./index";
import { log } from "@/lib/log";

export async function scheduleFeeds(boss: PgBoss) {
  for (const name of Object.keys(FEEDS) as FeedName[]) {
    const cron = feedCron(name);
    const key = `feed-${name}`;
    if (!cron) { await boss.unschedule("feed.ingest", key).catch(() => undefined); continue; }
    await boss.schedule("feed.ingest", cron, { feed: name, trigger: "schedule" }, { tz: "UTC", key, singletonKey: `feed:${name}`, missed: "once" });
  }
  if (process.env.FEEDS_RUN_ON_START === "true") {
    for (const name of Object.keys(FEEDS) as FeedName[]) {
      if (!feedCron(name)) continue;
      await boss.send("feed.ingest", { feed: name, trigger: "startup" }, { singletonKey: `feed:${name}` });
    }
    log.info("feeds.startup_ingest_queued", { feeds: Object.keys(FEEDS) });
  }
}

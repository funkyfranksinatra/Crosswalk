import { handle, body } from "@/lib/api";
import { inboxFor, unreadCount, markRead } from "@/lib/notifications";

export async function GET(req: Request) {
  return handle(null, async (actor) => {
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unread") === "1";
    const [items, unread] = await Promise.all([inboxFor(actor.id, { unreadOnly, take: Number(url.searchParams.get("take") ?? 50) || 50 }), unreadCount(actor.id)]);
    return { items, unread };
  });
}

/** Mark read: { ids: [...] } or { all: true }. Only the caller's own rows are ever touched. */
export async function POST(req: Request) {
  return handle(null, async (actor) => {
    const b = await body<{ ids?: string[]; all?: boolean }>(req);
    if (b.all) return { marked: await markRead(actor.id, "all") };
    if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === "string")) throw new Error("ids must be a list of notification ids");
    return { marked: await markRead(actor.id, b.ids.slice(0, 500)) };
  });
}

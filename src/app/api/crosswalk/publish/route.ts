import { handle, body } from "@/lib/api";
import { publishVersion } from "@/lib/xref/governance";
export async function POST(req: Request) { return handle("publish_crosswalk", async (actor) => publishVersion(actor.id, (await body<{ notes?: string }>(req)).notes)); }

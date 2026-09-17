import { handle, body } from "@/lib/api";
import { prisma } from "@/lib/db";
import { KINDS, setPreference, channelsConfigured, type Kind } from "@/lib/notifications";

export async function GET() {
  return handle(null, async (actor) => ({ kinds: KINDS, channels: channelsConfigured(), preferences: await prisma.notificationPreference.findMany({ where: { userId: actor.id } }) }));
}

export async function PATCH(req: Request) {
  return handle(null, async (actor) => {
    const b = await body<{ kind?: string; inApp?: boolean; email?: boolean; teams?: boolean }>(req);
    if (!b.kind || (b.kind !== "*" && !KINDS.includes(b.kind as Kind))) throw new Error(`kind must be * or one of ${KINDS.join(", ")}`);
    const patch: { inApp?: boolean; email?: boolean; teams?: boolean } = {};
    for (const k of ["inApp", "email", "teams"] as const) if (typeof b[k] === "boolean") patch[k] = b[k];
    return setPreference(actor.id, b.kind as Kind | "*", patch);
  });
}

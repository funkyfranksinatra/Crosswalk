import { handle, body } from "@/lib/api";
import { prisma } from "@/lib/db";
import { resolveReviewItem } from "@/lib/integrations/core/admin";
import { can, AuthError } from "@/lib/auth";

/**
 * Resolve a review item. Roster items (link / supersede) need manage_contracts; contract-price
 * items need import_competitor_pricing; document items need verify_competitor_pricing;
 * anything else needs configure_settings.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(null, async (actor) => {
    const { id } = await ctx.params;
    const item = await prisma.integrationReviewItem.findUnique({ where: { id }, select: { integrationKey: true } });
    if (!item) throw new Error("not found");
    const k = item.integrationKey;
    const perm = k.startsWith("gpo:") ? "manage_contracts" : k === "competitor-contracts" ? "import_competitor_pricing" : k === "documents" ? "verify_competitor_pricing" : "configure_settings";
    if (!can(actor, perm)) throw new AuthError(`Missing permission: ${perm}`, 403);
    return resolveReviewItem(id, await body(req), actor.id);
  });
}

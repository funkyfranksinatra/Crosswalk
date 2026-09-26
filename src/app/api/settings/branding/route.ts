import { handle, body } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getBranding, saveBranding } from "@/lib/branding";

export async function GET() { return handle("view_pricing", async () => getBranding()); }
export async function PUT(req: Request) {
  return handle("configure_settings", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("branding must be a JSON object");
    const saved = await saveBranding(b);
    await audit({ actorUserId: actor.id, entityType: "Setting", entityId: "branding", action: "UPDATED", after: { ...saved, logoDataUrl: saved.logoDataUrl ? `<${saved.logoDataUrl.length} chars>` : null } });
    return saved;
  });
}

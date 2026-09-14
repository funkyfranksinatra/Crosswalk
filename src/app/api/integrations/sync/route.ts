import { handle, body } from "@/lib/api";
import { syncCrmAccounts, syncErp, syncGpoMemberships } from "@/lib/integrations/sync";
import { getCompany } from "@/lib/settings";
export async function POST(req: Request) {
  return handle("manage_contracts", async (actor) => {
    const { system } = await body<{ system: "crm" | "erp" | "gpo" }>(req);
    if (system === "crm") return syncCrmAccounts(actor.id);
    if (system === "erp") return syncErp(actor.id, (await getCompany()).id);
    if (system === "gpo") return syncGpoMemberships(actor.id);
    throw new Error("unknown system");
  });
}

import { handle } from "@/lib/api";
import { listIntegrations } from "@/lib/integrations/core/admin";

/** Settings → Integrations overview. Read needs configure_settings: statuses reveal what is connected. */
export async function GET() {
  return handle("configure_settings", async () => ({ integrations: await listIntegrations() }));
}

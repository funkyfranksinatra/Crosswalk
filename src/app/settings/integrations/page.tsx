import { PageHeader } from "@/components/ui";
import { getActor, can } from "@/lib/auth";
import { IntegrationsAdmin } from "./admin";
import { redirect } from "next/navigation";

/** Settings → Integrations. Reading configuration needs configure_settings (the API enforces it too). */
export default async function IntegrationSettingsPage() {
  const actor = await getActor();
  if (!actor || !can(actor, "configure_settings")) redirect("/settings");
  return (
    <>
      <PageHeader eyebrow="Configuration" title="Integrations" description="CRM, ERP, GPO rosters, document extraction, exchange rates and competitor contract prices. Configure, test, map, sync — no code changes. Secrets are sealed at rest and never shown after saving." />
      <IntegrationsAdmin canConfigure={can(actor, "configure_settings")} />
    </>
  );
}

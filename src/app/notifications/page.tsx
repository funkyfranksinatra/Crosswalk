import { getActor } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { Inbox } from "./inbox";

export default async function NotificationsPage() {
  const actor = await getActor();
  if (!actor) return null;
  return (
    <>
      <PageHeader eyebrow="You" title="Notifications" description="Runs finishing, approvals needing you, decisions on your proposals, crosses to review, and system alerts. Email and Teams delivery follow the switches below when those channels are configured." />
      <Inbox />
    </>
  );
}

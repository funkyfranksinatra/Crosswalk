import { handle } from "@/lib/api";
import { isIntegrationKey } from "@/lib/integrations/core/config";
import { listReviews } from "@/lib/integrations/core/admin";

/** The review / exception queue. Anyone who can view pricing can read it; resolving needs the owning permission. */
export async function GET(req: Request) {
  return handle("view_pricing", async () => {
    const q = new URL(req.url).searchParams;
    const key = q.get("key");
    const status = q.get("status");
    return { items: await listReviews({ key: key && isIntegrationKey(key) ? key : null, kind: q.get("kind"), status: status === "RESOLVED" || status === "DISMISSED" ? status : "OPEN" }) };
  });
}

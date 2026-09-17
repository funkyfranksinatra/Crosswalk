import { handle } from "@/lib/api";
import { driftFor } from "@/lib/proposals/drift";
import { can } from "@/lib/auth";
import type { ProposalDrift } from "@/lib/proposals/drift";

/** Cost and floor deltas are commercially sensitive: a rep sees that they moved, not by how much. */
function redactDrift(actor: Parameters<typeof can>[0], d: ProposalDrift): ProposalDrift {
  if (can(actor, "view_cost")) return d;
  return { ...d, lines: d.lines.map((l) => ({ ...l, changes: l.changes.map((c) => (c.field === "cost" || c.field === "floorPrice" ? { ...c, from: null, to: null, note: c.note ?? "changed" } : c)) })) };
}

/** What moved under this proposal since it was snapshotted (cost/floor figures redacted per role). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async (actor) => {
    const d = await driftFor(id);
    return redactDrift(actor, d);
  });
}

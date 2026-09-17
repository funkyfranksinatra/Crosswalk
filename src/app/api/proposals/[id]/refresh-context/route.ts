import { handle } from "@/lib/api";
import { refreshContext } from "@/lib/proposals/drift";
import { redactJsonForActor, can } from "@/lib/auth";
import type { ProposalDrift } from "@/lib/proposals/drift";

/** Cost and floor deltas are commercially sensitive: a rep sees that they moved, not by how much. */
function redactDrift(actor: Parameters<typeof can>[0], d: ProposalDrift): ProposalDrift {
  if (can(actor, "view_cost")) return d;
  return { ...d, lines: d.lines.map((l) => ({ ...l, changes: l.changes.map((c) => (c.field === "cost" || c.field === "floorPrice" ? { ...c, from: null, to: null, note: c.note ?? "changed" } : c)) })) };
}

/** Re-snapshot an unlocked draft to today's contracts, costs, policies and crosswalk version. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => { const r = await refreshContext(actor, id); return redactJsonForActor(actor, { ...r, drift: redactDrift(actor, r.drift) }); });
}

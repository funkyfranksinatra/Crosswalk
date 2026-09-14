import { NextResponse } from "next/server";
import { getCompany } from "@/lib/settings";
import { enrichOwnProducts } from "@/lib/gudid/enrich";

let job: { running: boolean; done: number; total: number; enriched: number; missing: number; startedAt: number } | null = null;

export async function GET() {
  return NextResponse.json(job ?? { running: false });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (job?.running) return NextResponse.json({ ok: true, alreadyRunning: true });
  const company = await getCompany();
  job = { running: true, done: 0, total: 0, enriched: 0, missing: 0, startedAt: Date.now() };
  enrichOwnProducts(company.id, (m) => {
    const match = m.match(/(\d+)\/(\d+) \((\d+) enriched, (\d+) missing\)/);
    if (match && job) { job.done = +match[1]; job.total = +match[2]; job.enriched = +match[3]; job.missing = +match[4]; }
  }, { onlyMissing: body.onlyMissing !== false })
    .then((r) => { if (job) { job.running = false; job.enriched = r.enriched; job.missing = r.missing; job.total = r.total; job.done = r.total; } })
    .catch(() => { if (job) job.running = false; });
  return NextResponse.json({ ok: true });
}

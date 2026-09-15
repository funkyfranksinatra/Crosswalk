import { NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import { llmConfig } from "@/lib/llm/client";
import { prisma } from "@/lib/db";
import { authorize } from "@/lib/api";
import { audit } from "@/lib/audit";

export async function GET() {
  const { deny } = await authorize(null);
  if (deny) return deny;
  const s = await getSettings();
  const llm = llmConfig();
  const calls = await prisma.llmCall.groupBy({ by: ["purpose", "ok"], _count: { _all: true }, _avg: { durationMs: true } });
  return NextResponse.json({ ...s, llm: { available: llm.available, model: llm.model, baseURL: llm.baseURL ?? null }, calls });
}

export async function POST(req: Request) {
  const { actor, deny } = await authorize("configure_settings");
  if (deny) return deny;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const before = await getSettings();
  await saveSettings(body);
  const after = await getSettings();
  await audit({ actorUserId: actor.id, entityType: "Settings", entityId: "global", action: "UPDATE", before, after });
  return NextResponse.json(after);
}

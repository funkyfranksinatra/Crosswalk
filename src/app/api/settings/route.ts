import { NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import { llmConfig } from "@/lib/llm/client";
import { prisma } from "@/lib/db";

export async function GET() {
  const s = await getSettings();
  const llm = llmConfig();
  const calls = await prisma.llmCall.groupBy({ by: ["purpose", "ok"], _count: { _all: true }, _avg: { durationMs: true } });
  return NextResponse.json({ ...s, llm: { available: llm.available, model: llm.model, baseURL: llm.baseURL ?? null }, calls });
}

export async function POST(req: Request) {
  const body = await req.json();
  await saveSettings(body);
  return NextResponse.json(await getSettings());
}

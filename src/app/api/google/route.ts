import { NextResponse } from "next/server";
import { googleStatus, googleSelfTest } from "@/lib/sheets/google";
import { authorize } from "@/lib/api";

export async function GET(req: Request) {
  const { deny } = await authorize(null);
  if (deny) return deny;
  const test = new URL(req.url).searchParams.get("test");
  const status = googleStatus();
  return NextResponse.json({ ...status, ...(test ? { test: await googleSelfTest() } : {}) });
}

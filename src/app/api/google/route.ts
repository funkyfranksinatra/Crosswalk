import { NextResponse } from "next/server";
import { googleStatus, googleSelfTest } from "@/lib/sheets/google";

export async function GET(req: Request) {
  const test = new URL(req.url).searchParams.get("test");
  const status = googleStatus();
  return NextResponse.json({ ...status, ...(test ? { test: await googleSelfTest() } : {}) });
}

import { NextResponse } from "next/server";

/** The small HTML answer for a failed sign-in step (the browser is on a top-level navigation, so JSON would be unreadable). */
export function signInFailedPage(message: string, status: number): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:15px system-ui;max-width:32rem;margin:4rem auto;color:#222"><h1 style="font-size:20px">Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="/api/auth/oidc/start">Try again</a> · <a href="/">Home</a></p></body>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

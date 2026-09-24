"use client";

/**
 * App-level error boundary. Rendered inside the root layout when a page throws, so the
 * sidebar stays and the person can retry or go back without a blank screen. No inline
 * scripts or styles are emitted here — the CSP nonce pattern (src/proxy.ts) is unaffected.
 */
import { useEffect } from "react";
import Link from "next/link";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("page error", error.digest ?? error.message); }, [error]);
  return (
    <div className="card p-8 max-w-xl mx-auto mt-10 text-center" role="alert">
      <div className="text-[16px] font-semibold text-ink">Something went wrong on this page</div>
      <p className="text-muted mt-2 text-[13px]">The rest of Crosswalk is still working. Try again, or go back to the overview.{error.digest ? <span className="block mono text-[11.5px] mt-2">Reference: {error.digest}</span> : null}</p>
      <div className="mt-5 flex justify-center gap-2">
        <button type="button" className="btn-primary" onClick={() => reset()}>Try again</button>
        <Link href="/" className="btn-secondary">Overview</Link>
      </div>
    </div>
  );
}

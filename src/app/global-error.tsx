"use client";

/** Last-resort boundary for errors thrown by the root layout itself (no sidebar available). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", padding: 40, color: "#16181d", background: "#f6f5f1" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Crosswalk could not render this page</h1>
        <p style={{ color: "#6b7079", fontSize: 13 }}>{error.digest ? `Reference: ${error.digest}` : "An unexpected error occurred."}</p>
        <button type="button" onClick={() => reset()} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #e4e2dc", background: "#fff", cursor: "pointer" }}>Try again</button>
      </body>
    </html>
  );
}

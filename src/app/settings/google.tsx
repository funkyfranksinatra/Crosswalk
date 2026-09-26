"use client";

import { useState } from "react";
import { Card, Chip } from "@/components/ui";

export function GoogleCard({ status }: { status: { configured: boolean; email: string | null; project: string | null; folderId: string | null; canWrite: boolean } }) {
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function runTest() {
    if (busy) return;
    setBusy(true);
    try { const res = await fetch("/api/google?test=1", { cache: "no-store" }); const r = await res.json().catch(() => ({})); setTest(res.ok && r.test ? r.test : { ok: false, message: r.error ?? `Test failed (${res.status})` }); }
    catch { setTest({ ok: false, message: "Could not reach the server" }); } finally { setBusy(false); }
  }
  return (
    <Card title="Google Sheets & Drive" subtitle="Free for anyone demoing — no Excel licence needed" actions={status.configured ? <button type="button" className="btn-secondary" onClick={runTest} disabled={busy}>{busy ? "Testing…" : "Test connection"}</button> : null}>
      <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
        <dt className="text-muted">Read links</dt><dd><Chip tone="exact">Always on</Chip> <span className="text-muted">sheets shared as “Anyone with the link”</span></dd>
        <dt className="text-muted">Private sheets</dt><dd>{status.configured ? <><Chip tone="exact">On</Chip> <span className="text-muted">share with</span> <span className="mono">{status.email}</span></> : <Chip tone="alt">Needs service account</Chip>}</dd>
        <dt className="text-muted">Drive write-back</dt><dd>{status.canWrite ? <><Chip tone="exact">On</Chip> <span className="text-muted">folder</span> <span className="mono">{status.folderId}</span></> : status.configured ? <Chip tone="alt">Set GOOGLE_DRIVE_FOLDER_ID</Chip> : <Chip tone="alt">Off</Chip>}</dd>
      </dl>
      {test && <div role="status" className={`mt-3 rounded-lg px-3 py-2 text-[12.5px] ${test.ok ? "bg-exact-soft text-exact" : "bg-none-soft text-none"}`}>{test.message}</div>}
      {!status.canWrite && (
        <div className="mt-4 rounded-lg bg-panel-2 border border-line p-3 text-[12.5px] text-ink-2">
          <div className="font-medium text-ink mb-1">Optional: one-click exports into Drive (free, ~10 minutes)</div>
          <ol className="list-decimal ml-4 space-y-1">
            <li>Google Cloud Console → create a project → enable the <b>Google Drive API</b> and <b>Google Sheets API</b>.</li>
            <li>IAM & Admin → Service Accounts → create one → Keys → <b>Add key → JSON</b>. Save it next to the app.</li>
            <li>In Drive, create a folder for Crosswalk exports and <b>share it with the service-account email as Editor</b> (a Shared Drive folder is best in Workspace).</li>
            <li>Add to <span className="kbd">.env</span> and restart:</li>
          </ol>
          <pre className="mono mt-2 text-[12px]">GOOGLE_SERVICE_ACCOUNT_JSON=./google-service-account.json{"\n"}GOOGLE_DRIVE_FOLDER_ID=1AbC…   # folder id from its URL</pre>
        </div>
      )}
    </Card>
  );
}

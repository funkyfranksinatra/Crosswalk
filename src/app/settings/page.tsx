import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { llmConfig } from "@/lib/llm/client";
import { PageHeader, Card, Chip } from "@/components/ui";
import { SettingsForm } from "./form";
import { GoogleCard } from "./google";
import { IntegrationsCard } from "./integrations";
import { SystemCard } from "./system";
import { getActor, can } from "@/lib/auth";
import { googleStatus } from "@/lib/sheets/google";

export default async function SettingsPage() {
  const actor = await getActor();
  const s = await getSettings();
  const llm = llmConfig();
  const calls = await prisma.llmCall.groupBy({ by: ["purpose", "ok"], _count: { _all: true }, _avg: { durationMs: true, inputTokens: true, outputTokens: true } });
  const recent = await prisma.llmCall.findMany({ orderBy: { createdAt: "desc" }, take: 8 });
  return (
    <>
      <PageHeader eyebrow="Configuration" title="Settings" description="Ranking weights and model status. Secrets live in .env, never in the database." />
      <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
        <SettingsForm weights={s.weights} maxCandidates={s.maxCandidates} companyName={s.companyName} />
        <div className="space-y-4">
          <Card title="Model" subtitle="OpenAI-compatible Responses API with structured outputs">
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
              <dt className="text-muted">Status</dt><dd>{!llm.available ? <Chip tone="alt">Heuristic mode</Chip> : recent.length && !recent.some((r) => r.ok) ? <Chip tone="none">Key set, but calls are failing</Chip> : recent.some((r) => r.ok) ? <Chip tone="exact">Working</Chip> : <Chip tone="info">Key set · untested</Chip>}</dd>
              <dt className="text-muted">Model ID</dt><dd className="mono">{llm.model} <span className="text-muted">(LLM_MODEL)</span></dd>
              <dt className="text-muted">Endpoint</dt><dd className="mono">{llm.baseURL ?? "https://api.openai.com/v1"}</dd>
              <dt className="text-muted">Used for</dt><dd>attribute binning · candidate grading · hints for codes GUDID can&apos;t find</dd>
            </dl>
            {!llm.available && (
              <div className="mt-4 rounded-lg bg-panel-2 border border-line p-3 text-[12.5px] text-ink-2">
                Add to <span className="kbd">.env</span> and restart:
                <pre className="mono mt-2 text-[12px]">OPENAI_API_KEY=sk-…{"\n"}LLM_MODEL=gpt-5.6-astra{"\n"}# OPENAI_BASE_URL=https://…/v1  (optional gateway)</pre>
              </div>
            )}
            {calls.length > 0 && (
              <div className="mt-4">
                <div className="eyebrow mb-2">Calls so far</div>
                <table className="table">
                  <thead><tr><th>Purpose</th><th>OK</th><th className="text-right">Count</th><th className="text-right">Avg ms</th><th className="text-right">Avg in/out tokens</th></tr></thead>
                  <tbody>{calls.map((c) => <tr key={c.purpose + c.ok}><td>{c.purpose}</td><td>{c.ok ? "yes" : "no"}</td><td className="mono text-right">{c._count._all}</td><td className="mono text-right">{Math.round(c._avg.durationMs ?? 0)}</td><td className="mono text-right">{Math.round(c._avg.inputTokens ?? 0)}/{Math.round(c._avg.outputTokens ?? 0)}</td></tr>)}</tbody>
                </table>
                {recent.some((r) => !r.ok) && <div className="mt-2 rounded-md bg-none-soft text-none px-3 py-2 text-[12px]"><b>Last error:</b> {recent.find((r) => !r.ok)?.error}<div className="mt-1 opacity-90">A 404 / &quot;model not found&quot; means <span className="mono">LLM_MODEL</span> isn&apos;t an ID this API key can call — check your provider&apos;s model list and restart the server after editing .env.</div></div>}
              </div>
            )}
          </Card>
          {can(actor, "configure_settings") && <SystemCard />}
          <IntegrationsCard canSync={can(actor, "manage_contracts")} />
          <GoogleCard status={googleStatus()} />
          <Card title="Data sources">
            <ul className="text-[13px] space-y-2">
              <li><b>openFDA Device UDI</b> — searchable mirror of AccessGUDID; used for catalog-number lookup and own-catalog enrichment. Optional <span className="kbd">OPENFDA_API_KEY</span> raises the rate limit.</li>
              <li><b>Google Sheets</b> — link-shared sheets are read with no credentials; a service account (above) adds private reads and Drive write-back. .xlsx/.csv downloads always open in Sheets for free.</li>
              <li><b>Curated sheets</b> — <span className="mono">data/reference/Endomechanical.xlsx</span>; re-seed with <span className="kbd">npm run db:seed</span> after editing.</li>
              <li><b>Database</b> — PostgreSQL via Prisma (<span className="mono">DATABASE_URL</span>); browse with <span className="kbd">npm run db:studio</span>. Background jobs live in the <span className="mono">pgboss</span> schema of the same database.</li>
              <li><b>Scheduled feeds</b> — drop CSV exports in <span className="mono">INTEGRATION_FEED_DIR</span> (crm-*, erp-*, gpo-*, pricing, competitor-sizes, competitor-prices) and they are ingested on the schedules shown under System; <span className="mono">FEED_&lt;NAME&gt;_CRON</span> overrides, <span className="mono">off</span> disables.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

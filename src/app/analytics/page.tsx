import { PageHeader, Card, Stat, Empty } from "@/components/ui";
import { getActor } from "@/lib/auth";
import { winLoss, pricingEffectiveness, conversion, crossReferenceAccuracy } from "@/lib/analytics";
import { fmtMoney, fmtPct } from "@/components/commercial";

const pct = (v: number | null | undefined, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);

export default async function AnalyticsPage() {
  const actor = await getActor();
  if (!actor?.permissions.has("view_analytics")) return <Empty title="Analytics require the view analytics permission" />;
  const [wl, pe, cv, acc] = await Promise.all([winLoss(), pricingEffectiveness(), conversion(), crossReferenceAccuracy()]);
  const margin = actor.permissions.has("view_margin");
  return (
    <>
      <PageHeader eyebrow="Analytics" title="Commercial feedback loop" description="Win/loss, pricing effectiveness, conversion after the win, and cross-reference acceptance. Rep acceptance is reported separately from validated accuracy — they are not the same number." />
      <div className="grid grid-cols-6 gap-3 mb-5">
        <Stat label="Decided deals" value={wl.deals} hint={`${wl.won} won · ${wl.lost} lost`} />
        <Stat label="Win rate" value={pct(wl.winRate)} tone="exact" />
        <Stat label="Median discount to win" value={pe.medianDiscountToWin ? fmtPct(pe.medianDiscountToWin) : "—"} hint={`avg ${pe.avgDiscountToWin ? fmtPct(pe.avgDiscountToWin) : "—"}`} />
        <Stat label="Recommendation followed" value={pct(pe.recommendationFollowedPct)} hint={`${pe.floorExceptions} floor exceptions`} tone="accent" />
        <Stat label="Post-win conversion" value={pct(cv.conversionRate)} hint={`${cv.converted} of ${cv.won} won lines shipped`} />
        <Stat label="Top-1 acceptance" value={pct(acc.top1AcceptanceRate)} hint={`validated accuracy ${acc.validatedCount ? pct(acc.validatedAccuracy) : "n/a (no ground truth yet)"}`} tone="close" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card title="Win / loss by competitor" padded={false}><Table cols={["Competitor", "Deals", "Won", "Win rate", "Value"]} rows={wl.byCompetitor.map((r) => [String(r.competitor), r.deals, r.won, pct(r.winRate), fmtMoney(r.value as string, "USD", { compact: true })])} /></Card>
        <Card title="Win / loss by product family" padded={false}><Table cols={["Family", "Deals", "Won", "Win rate"]} rows={wl.byFamily.map((r) => [r.family, r.deals, r.won, pct(r.winRate)])} /></Card>
        <Card title="Win / loss by discount band" padded={false}><Table cols={["Discount from list", "Deals", "Won", "Win rate"]} rows={wl.byDiscountBand.map((r) => [String(r.band), r.deals, r.won, pct(r.winRate)])} /></Card>
        <Card title="Loss reasons" padded={false}><Table cols={["Reason", "Count"]} rows={wl.lossReasons.map((r) => [r.reason, r.count])} /></Card>
        <Card title="Pricing effectiveness" subtitle={`${pe.linesPriced} priced lines · ${pe.linesWon} won · approvals ${pe.approvalsApproved}/${pe.approvalsTotal} approved (${pct(pe.approvalFrequencyPct)} of lines needed one)`} padded={false}>
          <Table cols={["Month", "Won revenue", ...(margin ? ["Margin"] : [])]} rows={pe.marginTrend.map((m) => [m.month, fmtMoney(m.revenue, "USD", { compact: true }), ...(margin ? [fmtPct(m.marginPct)] : [])])} />
        </Card>
        <Card title="Competitor price spread" subtitle="Min–max across observations per competitor code" padded={false}><Table cols={["Code", "Obs.", "Min", "Max"]} rows={pe.competitorPriceSpread.slice(0, 15).map((s) => [s.sku, s.observations, fmtMoney(s.min), fmtMoney(s.max)])} /></Card>
        <Card title="Conversion by family" subtitle="Won lines that have shipped at least once" padded={false}><Table cols={["Family", "Won", "Converted"]} rows={cv.byFamily.map((r) => [String(r.family), r.won, r.converted])} /></Card>
        <Card title="Cross-reference acceptance" subtitle={`${acc.decisions} decisions · override rate ${pct(acc.overrideRate)} · avg engine confidence accepted ${acc.avgConfidenceAccepted.toFixed(2)} vs overridden ${acc.avgConfidenceOverridden.toFixed(2)}`} padded={false}>
          <Table cols={["Family", "Decisions", "Top-1 acceptance"]} rows={acc.byFamily.map((r) => [r.family, r.decisions, pct(r.acceptance)])} />
        </Card>
        <Card title="Acceptance over time" padded={false}><Table cols={["Month", "Decisions", "Acceptance"]} rows={acc.overTime.map((r) => [r.month, r.decisions, pct(r.acceptance)])} /></Card>
        <Card title="Override reasons" padded={false}><Table cols={["Reason", "Count"]} rows={acc.overrideReasons.map((r) => [r.reason, r.count])} /></Card>
      </div>
    </>
  );
}

function Table({ cols, rows }: { cols: string[]; rows: (string | number | null)[][] }) {
  if (!rows.length) return <div className="p-5 text-[13px] text-muted">No data yet.</div>;
  return <table className="table !text-[12.5px]"><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === "number" || (typeof c === "string" && /^[$\d%.,–\-—]+$/.test(c)) ? "mono" : ""}>{c ?? "—"}</td>)}</tr>)}</tbody></table>;
}

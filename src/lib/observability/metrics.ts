/**
 * In-process metrics registry with a Prometheus text exporter (no dependency).
 * Counters and gauges are per process; a multi-process deployment scrapes each one.
 * The database-derived gauges (queue depth, last run resolution rate…) are filled in by
 * `collectDbMetrics()` at scrape time so they are consistent across processes.
 */
type Labels = Record<string, string | number>;
type Series = Map<string, { labels: Labels; value: number }>;

const counters = new Map<string, { help: string; series: Series }>();
const gauges = new Map<string, { help: string; series: Series }>();
const histograms = new Map<string, { help: string; buckets: number[]; series: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }> }>();

const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort());

export function counter(name: string, help: string) {
  if (!counters.has(name)) counters.set(name, { help, series: new Map() });
  const c = counters.get(name)!;
  return {
    inc(labels: Labels = {}, by = 1) {
      const k = key(labels);
      const s = c.series.get(k) ?? { labels, value: 0 };
      s.value += by;
      c.series.set(k, s);
    },
  };
}

export function gauge(name: string, help: string) {
  if (!gauges.has(name)) gauges.set(name, { help, series: new Map() });
  const g = gauges.get(name)!;
  return {
    set(labels: Labels, value: number) { g.series.set(key(labels), { labels, value }); },
    clear() { g.series.clear(); },
  };
}

export function histogram(name: string, help: string, buckets: number[]) {
  if (!histograms.has(name)) histograms.set(name, { help, buckets, series: new Map() });
  const h = histograms.get(name)!;
  return {
    observe(labels: Labels, value: number) {
      const k = key(labels);
      const s = h.series.get(k) ?? { labels, counts: new Array(h.buckets.length).fill(0), sum: 0, count: 0 };
      h.buckets.forEach((b, i) => { if (value <= b) s.counts[i]++; });
      s.sum += value; s.count++;
      h.series.set(k, s);
    },
  };
}

// ---- the application's series ------------------------------------------------------------
export const httpRequests = counter("crosswalk_http_requests_total", "API requests by route and status");
export const httpDuration = histogram("crosswalk_http_request_seconds", "API request latency", [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
export const openFdaRequests = counter("crosswalk_openfda_requests_total", "openFDA calls by outcome (ok, rate_limited, server_error, error)");
export const openFdaWait = histogram("crosswalk_openfda_wait_seconds", "Time spent waiting for the openFDA token bucket", [0.01, 0.1, 0.5, 1, 2.5, 5, 10, 30]);
export const llmCalls = counter("crosswalk_llm_calls_total", "Model calls by purpose and outcome");
export const llmTokens = counter("crosswalk_llm_tokens_total", "Model tokens by direction");
export const jobsProcessed = counter("crosswalk_jobs_total", "Jobs by queue and outcome");
export const runsFinished = counter("crosswalk_runs_total", "Cross-reference runs by outcome");
export const notificationsSent = counter("crosswalk_notifications_total", "Notifications by kind and channel outcome");
export const alertsFiring = gauge("crosswalk_alerts_firing", "Alerts currently firing by severity");
export const queueDepth = gauge("crosswalk_queue_jobs", "Jobs per queue and state");
export const queueOldestReady = gauge("crosswalk_queue_oldest_ready_seconds", "Age of the oldest ready job per queue");
export const lastRunResolution = gauge("crosswalk_last_run_resolution_ratio", "Resolved / total lines of the most recent completed run");
export const lastRunMatch = gauge("crosswalk_last_run_match_ratio", "Matched / total lines of the most recent completed run");
export const feedAge = gauge("crosswalk_feed_age_seconds", "Seconds since each feed last ingested successfully");
export const processInfo = gauge("crosswalk_process_start_seconds", "Process start time (unix seconds)");
processInfo.set({ pid: process.pid }, Math.floor(Date.now() / 1000));

const fmtLabels = (l: Labels) => { const e = Object.entries(l); return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(",")}}` : ""; };

/** Prometheus exposition format 0.0.4. */
export function render(): string {
  const out: string[] = [];
  for (const [name, c] of counters) {
    out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
    for (const s of c.series.values()) out.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
  }
  for (const [name, g] of gauges) {
    out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
    for (const s of g.series.values()) out.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
  }
  for (const [name, h] of histograms) {
    out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
    for (const s of h.series.values()) {
      h.buckets.forEach((b, i) => out.push(`${name}_bucket${fmtLabels({ ...s.labels, le: b })} ${s.counts[i]}`));
      out.push(`${name}_bucket${fmtLabels({ ...s.labels, le: "+Inf" })} ${s.count}`, `${name}_sum${fmtLabels(s.labels)} ${s.sum}`, `${name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Test/inspection helper. */
export function snapshot() {
  const o: Record<string, Record<string, number>> = {};
  for (const [name, c] of counters) o[name] = Object.fromEntries([...c.series.values()].map((s) => [key(s.labels), s.value]));
  for (const [name, g] of gauges) o[name] = Object.fromEntries([...g.series.values()].map((s) => [key(s.labels), s.value]));
  return o;
}

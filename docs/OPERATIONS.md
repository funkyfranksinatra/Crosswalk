# Operating Crosswalk

What runs in the background, how to watch it, and what to do when something is wrong.
Everything here was added by the Tier 1 (pilot quality) work; `FEATURES.md` has the
inventory, `ARCHITECTURE.md` the engine, `INTEGRATIONS.md` the systems of record.

## Processes

A deployment is one Next.js server (`npm start`) plus, optionally, worker processes
(`npm run worker`). Background work — cross-reference runs, GUDID imports, feed
ingestion, notification deliveries, alert checks, GUDID cache refresh — goes through a
pg-boss queue that lives in the `pgboss` schema of the application database. No broker,
no extra service.

| `JOBS_WORKER` | Web server | Worker process |
| --- | --- | --- |
| `inline` (default) | enqueues **and** processes jobs (`src/instrumentation.ts` starts the workers) | not needed; extra `npm run worker` processes add throughput |
| `external` | only enqueues | required: `npm run worker` (one or more) |
| `off` | no queue (scripts, tests) | — |

Each queue has a retry policy, a **heartbeat** and an expiry (`src/lib/jobs/queues.ts`).
The heartbeat is the crash detector: a worker refreshes it every 30 s while a job runs,
and a job whose process died is failed and retried within a minute or two. Expiry (23 h)
is only the backstop for a handler that hangs. Handlers resume: a run continues after its
last completed stage (`Request.checkpoint`), an import continues at its page cursor and
over the same plan of sub-queries (`GudidImport.cursorJson`). Rows the database says are
running with no live job are re-queued at worker start (`jobs.recovered_*` log lines) and
resume too; after the retry cap they are marked failed instead of looping. A queue
interruption (heartbeat lapse, shutdown) is never shown as "cancelled" — only a person's
Cancel is.

A second "run this request" while one is queued or running is a no-op (`exclusive`
queue policy per key), so a double-click or a retrying client cannot start two runs.

## Watching it

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /api/health` | anyone (load balancer) | 200 `ready` / `degraded` (queue stalled) / 503 `down`; only "does the database answer, does the queue answer" — no names, counts or topology |
| `GET /api/metrics` | `Authorization: Bearer $METRICS_TOKEN` or an ADMIN session | Prometheus text: HTTP requests/latency by route, openFDA calls by outcome and wait, model calls/tokens, runs by outcome, queue depth and oldest waiting job, feed age, alerts firing, last run's resolution/match ratio |
| `GET /api/observability/export?kind=llm|runs|sync|feeds|alerts|jobs&since=…` | ADMIN | NDJSON for a log stack that pulls |
| Settings → System | `configure_settings` | queues, recent failures (retry button), feeds (run now), active/resolved alerts, model/openFDA/notification/logging status |
| stdout | — | one JSON line per event (`LOG_FORMAT=json`, the production default), every line tagged with the request id the proxy assigned (`x-request-id`, also returned to the client) |

Log events worth alerting on in the log stack: `run.failed`, `jobs.failed` with
`finalAttempt: true`, `feed.failed`, `openfda.retry` bursts, `notify.delivery_failed`.

## Alerts

`alerts.evaluate` runs every `ALERTS_CRON` (default 5 min) and on demand from Settings.
Rules and thresholds (`src/lib/observability/alerts.ts`):

| Rule | Fires when | Severity |
| --- | --- | --- |
| `model_unreachable` | a model is configured and ≥ 60 % of the last 5 calls (30 min) failed | CRITICAL |
| `resolution_rate_low` | the last completed run (≥ 5 lines) resolved < `ALERT_RESOLUTION_MIN` (0.7) | WARNING |
| `runs_failing` | > `ALERT_RUN_FAILURES` (2) failed runs in 24 h | WARNING |
| `queue_stalled` | a ready job has waited > `ALERT_QUEUE_STALL_MIN` (15) min — no worker | WARNING, CRITICAL at 4× |
| `jobs_failed` | jobs exhausted their retries in 24 h | WARNING |
| `feed_stale` | a connected, scheduled feed has no OK run inside its window | WARNING |
| `feed_failed` | a feed's last run failed | CRITICAL |

An alert notifies ADMIN and PRICING_DIRECTOR users once when it starts firing, again every
`ALERT_RENOTIFY_HOURS` (6) while it keeps firing, and is marked resolved as soon as the
condition clears.

## Notifications

In-app is always on (bell in the sidebar, `/notifications`). Email needs `SMTP_URL` and
`MAIL_FROM`; Teams needs an incoming-webhook `TEAMS_WEBHOOK_URL`. External deliveries are
jobs on `notify.deliver` with backoff (5 attempts), recorded per channel on the
notification. Each person switches channels per event kind on `/notifications`.

Events: run complete/failed (creator), approval requested (everyone with the authority to
decide it — never the submitter), approval decided / proposal fully approved (owner and
submitter), cross proposed by a rep (clinical + marketing reviewers), feed failed, alert,
job failed after retries (admins).

A Teams incoming webhook posts to ONE channel: everything a person switches on for Teams
(including approvers' comments on their proposals) is visible to everyone in that channel.
Use a deal-desk channel and leave the personal kinds on email or in-app.

`NOTIFY_DRY_RUN=true` records deliveries without sending — for demos and CI.

## Feeds

`INTEGRATION_FEED_DIR` is watched on cron (UTC; `FEED_<NAME>_CRON`, `off` to disable):

| Feed | Files | Default schedule | Stale after |
| --- | --- | --- | --- |
| crm | crm-accounts.csv, crm-opportunities.csv | 02:00 daily | 36 h |
| erp | erp-skus.csv, erp-costs.csv, erp-purchases.csv | 02:30 daily | 36 h |
| gpo | gpo-memberships.csv | Mondays 03:00 | 8 days |
| pricing | pricing.csv (Catalog → Import pricing layout) | 02:15 daily | 36 h |
| competitor-sizes | competitor-sizes.csv (Catalog → Competitor sizes layout) | Mondays 04:00 | 8 days |
| competitor-prices | competitor-prices.csv (Competitor pricing → Import layout) | 02:45 daily | 8 days |

An unchanged file (same hash as the last OK run) is skipped; every run is a `FeedRun`.
"Sync now" in Settings → Integrations goes through the same path. When the Salesforce /
SAP adapters are implemented and their credentials set, the crm/erp feeds pull from the
API instead of the files.

## openFDA

All calls go through one client (`src/lib/gudid/http.ts`): a token bucket at 80 % of the
published limit (240/min without `OPENFDA_API_KEY`, 1,000/min with), exponential backoff
with jitter on 429/5xx honouring `Retry-After`, up to `OPENFDA_MAX_ATTEMPTS`. Several
processes sharing one key should lower `OPENFDA_RPM` accordingly.

Cached GUDID records older than `GUDID_CACHE_TTL_DAYS` (90) are served as they are and
re-checked in the background: the nightly `gudid.refresh` sweep (`GUDID_REFRESH_CRON`,
`GUDID_REFRESH_BATCH` rows) plus a one-off refresh the moment a stale code is used in a
run. A changed record clears its bin so the next run re-bins it; a record that vanished is
noted on the row, never deleted.

## Runbook

**A run is stuck at "Queued".** No worker is picking jobs up: check `JOBS_WORKER` on the
web server, or that `npm run worker` is running; `/api/health` reports `degraded` and the
`queue_stalled` alert fires after 15 minutes.

**A run failed.** The request page shows the error and the attempt; the queue retries
twice from the last checkpoint. After the last attempt admins get a `JOB_FAILED`
notification. Fix the cause (usually openFDA reachability or a bad row) and Re-run.

**The server restarted mid-run / mid-import.** Nothing to do: the row is re-queued on
start and resumes.

**A feed is stale.** Settings → System shows the last OK run and the source; check the
file drop landed and the schedule is not `off`. "Run now" forces an ingestion even when the
file is unchanged.

**Email/Teams are not arriving.** Settings → System lists the configured channels;
`/notifications` → Delivery shows the person's switches; Settings → System →
recent failures shows `notify.deliver` errors (SMTP auth, webhook 4xx).

**The model is failing.** `model_unreachable` fires; Settings → Model shows the last error
(a 404 is a wrong `LLM_MODEL`). Runs continue in heuristic mode meanwhile.

**Prompt or bin rules were edited.** `npm run eval:gate` (and CI) fails until the change is
measured and accepted: `npm run eval:model -- --accept` with the model configured, then
commit `data/eval/model-baseline.json`.

**The eval sampled junk ("NOMATCH", `E2E-TEST-CODE`).** Placeholder rows from a spreadsheet
and fixtures from the test suites are refused at intake now, but a database loaded earlier can
still hold them: `npm run catalog:hygiene` reports them, `-- --apply` deactivates the
placeholders (never deletes a product) and removes the fixtures. Then re-run `eval:model`.

**Accuracy numbers are needed.** `npm run benchmark` over `data/benchmark/<case>/`
(see the README there) or `--from-requests` for reviewed lists; results are `BenchmarkRun`
rows and, with `--out docs/benchmarks`, markdown.

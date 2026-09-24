# Operating Crosswalk

What runs in the background, how to watch it, and what to do when something is wrong.
Everything here was added by the Tier 1 (pilot quality) and Tier 3 (product and scale) work; `FEATURES.md` has the
inventory, `ARCHITECTURE.md` the engine, `INTEGRATIONS.md` the systems of record.

## Processes

A deployment is one Next.js server (`npm start`) plus, optionally, worker processes
(`npm run worker`). Background work — cross-reference runs, GUDID imports, feed
ingestion, notification deliveries, alert checks, GUDID cache refresh, embedding refresh,
analytics snapshots, public-bid pulls — goes through a pg-boss queue that lives in the
`pgboss` schema of the application database. No broker,
no extra service.

| `JOBS_WORKER` | Web server | Worker process |
| --- | --- | --- |
| `inline` (default) | enqueues **and** processes jobs (`src/instrumentation.ts` starts the workers) | not needed; extra `npm run worker` processes add throughput |
| `external` | only enqueues | required: `npm run worker` (one or more) |
| `off` | no queue (scripts, tests) | — |

Only those three words are modes. Any other value (`on`, `yes`, `1`) is logged once as
`env.invalid` and read as `inline`, so a typo never leaves a queue that nobody works. The same
reader guards every numeric setting of the queue (`JOBS_POOL_MAX` 1–100,
`JOBS_MAINTENANCE_SECONDS` 1–86400, `GUDID_REFRESH_BATCH`, `EMBED_REFRESH_BATCH`): out-of-range
or non-numeric values fall back to the default and are logged. A malformed cron
(`ALERTS_CRON`, `GUDID_REFRESH_CRON`, `EMBED_REFRESH_CRON`, `ANALYTICS_CRON`, `RETENTION_CRON`,
`FEED_<NAME>_CRON`) is logged as `jobs.schedule_failed` and leaves only that schedule off; the
workers, the other schedules and orphan recovery still start.

**Supported topology and process-local state.** One web process plus one worker (or one web
with inline workers). Everything the queue, feeds, alerts, notifications, integrations and
analytics need lives in the database, so a web + worker split and extra workers are safe. What
is *not* shared between processes: the API rate limiter and the catalog-enrichment progress
(security / correctness state — run a single web instance, or rate-limit at the proxy), and the
openFDA memo and token bucket and the in-process metrics counters (caches — lower `OPENFDA_RPM`
per process when several share a key; scrape every process). No distributed limiter is built.

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

The "final attempt" a handler reports (and the `JOB_FAILED` notification admins get) follows
the job's own retry limit when a `send()` overrode the queue's, so an exhausted job is always
reported. On `SIGTERM` the process waits up to 10 s for active handlers, then fails the jobs
still running as "pg-boss shut down while active" — they are retried by the next process
instead of sitting active until the heartbeat lapses. The stalled-queue signal on
`/api/health` and in the `queue_stalled` alert is read live from the job table (the oldest
job that is ready and not picked up), not from pg-boss's cached counters, which refresh at
most once a minute.

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

An unchanged file (same hash as the last OK run with no rejected rows) is skipped; every run
is a `FeedRun`. "Sync now" in Settings → Integrations goes through the same path. One ingestion
per feed at a time, whichever door it came through: the check and the RUNNING row are written
under a per-feed advisory lock, so a schedule and a "Sync now" arriving together (or two worker
processes) cannot ingest the same file twice; a RUNNING row older than 12 h belongs to a process
that died and is closed as FAILED by the next run rather than blocking the feed. When the
Salesforce / SAP / GPO integrations are **enabled under Settings → Integrations** the crm / erp /
gpo feeds pull from them (no files needed; such runs carry no hash and are never "unchanged").
The retired `SF_*` / `SAP_*` environment variables select nothing: while they are set without the
matching integration enabled, the crm / erp feed runs fail with a message saying exactly that.

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

## Tier 3 additions

**Embedding retrieval.** Needs pgvector in the database (Neon has it; CI uses the
`pgvector/pgvector` image; a local Postgres needs the extension package) and the model key.
`npm run embed` embeds the catalog and cached competitor products once; `embed.refresh` runs
nightly (`EMBED_REFRESH_CRON`, `EMBED_REFRESH_BATCH` rows, oldest-embedded first, so a large
catalog is covered over successive nights) and after catalog imports, re-embedding only rows
whose text changed. The migration requires pgvector (`CREATE EXTENSION vector`): a database
without it does not migrate, so "no pgvector" is not a runtime mode. A run says in its log whether each line was retrieved by neighbours or by the
attribute scan; Settings → System shows coverage. `EMBEDDINGS=off` returns to the scan.

**Tax.** `PROVIDER` mode on a proposal calls AvaTax with an uncommitted SalesOrder (never a
tax document) using `AVATAX_*`; `TAX_DRY_RUN=true` for demos. The figure carries a
fingerprint of what was taxed (priced lines, freight, ship-to); when that differs from the
quote as it stands the figure is stale — the workspace shows "recalculate" and both exports
refuse until it is. Notes, approvals and unchanged saves do not disturb it. Freight and tax never enter
margin, floors or approvals. The ship-from is the Branding address.

**Public bids.** `bids.ingest` pulls SAM.gov (needs `SAM_API_KEY`; the public key allows a
handful of calls a day, so one call per configured NAICS, `SAM_MAX_PAGES` pages; a 429 fails
the run without the queue retrying it) and USAspending (no key) on `BIDS_CRON`; each pull is a
`FeedRun` (`bids-sam`, `bids-usaspending`) visible on the Public bids page. Manual pulls are
once an hour per source. With `JOBS_WORKER=off` nothing pulls; analytics then refresh only
from the button and embeddings only from `npm run embed`. Keywords / NAICS / PSC / look-back are set on that page. Portal tabulations are
imported as files; a row with a competitor code and unit price becomes a `PUBLIC_BID_DB`
price observation.

**Analytics.** Reports are snapshots (`AnalyticsSnapshot`) refreshed hourly
(`ANALYTICS_CRON`), 30 s after an outcome or decision, and by the Refresh button; older than
`ANALYTICS_STALE_MINUTES` is shown as stale.

**Delegation.** An approver hands their queue to a colleague from the deal desk ("Delegate my
approvals"). The delegate decides in their own name; the request and audit record on whose
behalf. Admins can set one for anyone; revoking is immediate.

**Branding.** Settings → Branding: logo (PNG/JPEG under 300 KB), legal name, address,
colours, titles and terms for the quote and contract-offer PDFs.

## Tier 0 additions

**Sign-in.** With `SSO_ISSUER` + `SSO_CLIENT_ID` the sign-in screen offers "Sign in with
SSO" (`/api/auth/oidc/start`); a failed callback shows the reason on a plain page and
`oidc.callback.failed` is logged with it. Sessions last `SESSION_TTL_HOURS` (12); sign-out
clears the session and, when the provider has an end-session endpoint, sends the browser
there. A user whose token maps to no role is refused with "no Crosswalk role" — fix the
group membership or `SSO_ROLE_MAP`. `docs/DEPLOYMENT.md` § Identity has the provider setup.

**"Account not found" for a rep who should see it.** Scoping: reps and regional managers see
accounts they own (`Account.ownerUserId`), in their territory (`User.territory` matches
`Account.territory`, case-insensitive, comma-separated allowed), unassigned accounts, and
children of a visible IDN. Set the owner or territory on the account (or the user).

**Start-up refused ("Refusing to start: …").** The production configuration check
(`src/lib/secrets.ts`) found a development or placeholder secret, an example database
password, or a remote database without `sslmode`. `npm run secrets:check` (or the image's
`check` role) prints the same list; fix the environment, never the check.

**429 Too many requests.** Per-client, per-minute limits by route class (`RATE_LIMIT_AUTH`
20, `RATE_LIMIT_HEAVY` 60, `RATE_LIMIT_API` 600) plus a per-instance ceiling of
`RATE_LIMIT_GLOBAL_FACTOR` (20) × each; the response carries `Retry-After`. Behind a load
balancer, the proxy must send `X-Forwarded-For` and `TRUST_PROXY_HOPS` must point at the
real client entry, or every user shares one bucket.

**Something on a page is blocked by the CSP.** Only scripts carrying the per-request nonce
run; a browser extension or an injected script shows as a CSP violation in the console.
`CSP_REPORT_ONLY=true` switches to report-only while investigating.

**A migration fails with "violates check constraint".** A row holds a value outside the
application's own lists (`src/lib/db/constraints.ts`). `npm run db:preflight` names the
constraint and the count (on an empty database it only reports how many checks it skipped —
nothing to check yet); correct the rows. Prisma has recorded the migration as failed, and the
constraint migrations are idempotent (`DROP CONSTRAINT IF EXISTS` before every `ADD`), so the
recovery is: `npx prisma migrate resolve --rolled-back <migration name>` then
`npx prisma migrate deploy` again — verified on a database frozen at migration 10 with
violating rows (the failed deploy changed no rows; the retry applied every constraint).

**Retention.** Nothing is deleted until `RETENTION_ENABLED=true`; `npm run retention --
--dry-run` shows what the windows would remove; every sweep is a `RETENTION_SWEEP` audit
event. Customer request data needs an explicit `RETENTION_REQUESTS_DAYS`. `docs/BACKUPS.md`.

**A break-glass approval.** An ADMIN approved their own request: the proposal's approvals
tab shows a break-glass pill, the audit trail has `BREAK_GLASS_APPROVAL` with the reason,
and the other ADMINs and PRICING_DIRECTORs were notified. Review these monthly.

## Tier 2 additions (integrations)

- **Schedules** — each enabled integration with a cron expression gets one pg-boss schedule per
  sync type (`integration.sync`, key `integration-<key>-<type>`, singleton per integration + type).
  Saving a configuration re-applies its schedule without a restart; worker start re-applies all.
- **Watching** — Settings → Integrations shows health, last sync, last error and the run history per
  integration; `/api/integrations/config` (admin) lists all; `/api/integrations/jobs/<id>` returns a
  run with its row errors. Log events: `integration.sync.start|done|failed`, `integration.http` / `integration.http_error` / `integration.http_failed`,
  `integration.webhook.*`, `integration.quote_writeback*`, `integration.test*`.
- **Stuck runs** — a RUNNING job older than 12 h is marked CANCELLED at worker start
  (`cancelStaleJobs`); pg-boss retries transient (retryable) failures twice with back-off.
- **Secrets** — sealed under `INTEGRATIONS_ENCRYPTION_KEY`; losing the key means re-entering every
  integration secret (configuration and mappings survive). Rotate by setting the new key and
  re-saving each integration's secrets.
- **Mocks in production** — refused unless `INTEGRATIONS_ALLOW_MOCK=true`; the card says MOCK.
- **Review queue** — `/api/integrations/review` (open items); nothing there has been applied.
  Roster items need `manage_contracts`, contract-price items `import_competitor_pricing`,
  document items `verify_competitor_pricing`.
- **Document bytes** — `DOCUMENT_STORAGE_DIR` (default `./.data/documents`), keyed by document id.

## Engine throughput (Sept 23, 2026)

A run's wall time on a remote database is mostly round trips, not matching. Measured on the
30-line MSK list and a 300-line library list (local Postgres, heuristic mode, identical outputs
verified candidate-by-candidate):

| | 30 lines | 300 lines |
| --- | --- | --- |
| statements before → after | 366 → 138 | 4,872 → 1,998 |
| wall time (local) | 2.9 s → 1.4 s | 18.9 s → 4.6 s |

What changed (none of it alters a result): per-line progress counters are written at most every
`PROGRESS_WRITE_MS` (400 ms; stage changes and final counts always write); candidates are persisted
in chunks of 50 lines with three set-based statements per chunk instead of four per line; the
curated-description and imported-size lookups in the binning stage are one query per run instead
of two per code; resolution looks variants up per tier in parallel (tiers ≥ 2 still only when
tiers 0–1 found no exact hit); openFDA search answers are memoised in-process for
`OPENFDA_MEMO_SECONDS` (300; `0` disables) so pass 2 and sibling lines do not repeat a query —
the cache-expiry refresh always asks live. Profile a list yourself with
`npm run profile:run -- <intake file>` (query counts by statement, slow statements, stage times).

Remaining per-line cost is inherent: one cache lookup, the GUDID library lookup(s), and the
competitor-product upsert per resolved code. Model runs are bounded by the provider: grading
groups run two at a time and are cached by input hash, so a repeat run is free.

## Match quality evaluation (Sept 24, 2026)

`docs/MATCH_QUALITY_MODEL.md` is the specification; three tools measure it.

- `npx tsx scripts/eval-pacr.ts run <PACR export.xlsx> --label <name> [--rebin] [--fresh] [--llm]` seeds the
  benchmark account (0001583870) and its contract prices from the export, runs the list under that
  account and writes `docs/eval/<name>.json` (one raw record per line). `--rebin` drops cached bins
  first so binner changes take effect without a `BIN_VERSION` bump; `--fresh` re-resolves the codes.
- `npx tsx scripts/eval-pacr.ts report docs/eval/<name>.json --before docs/eval/baseline.json [--out file.md] [--json]`
  computes every metric (intake accounting, resolution, grades, agreement with PACR, curated-sheet
  top-1/top-3, diameter and component mismatches measured the same way for both systems, pricing
  under the account's contracts, the REQ-7628 PACR-win table) from the raw records, so a baseline
  captured before a change and a run captured after are judged by the same code.
- `npx tsx scripts/eval.ts --no-crosses [--family "…"]` remains the cross-family attribute-only check
  against the curated sheets; run it per family before and after any matcher change (generalisation gate).
- `npx vitest run tests/unit/match-quality.test.ts tests/unit/pacr-regression.test.ts` is the offline gate:
  size-parser matrix, registry, constraints, scoring, intake accounting, the PACR-win cases and the
  adversarial cases, judged from `tests/fixtures/trocar-benchmark.json` exactly as the pipeline judges a line.

Run `scripts/seed-sanford-benchmark.ts --clean` to remove the benchmark contracts and price entries.

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

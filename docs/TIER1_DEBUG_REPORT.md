# Tier 1 debug report — scope: the pilot-quality build only

**Date:** September 17, 2026 · **Scope:** the code added by the Tier 1 build (commits `0a6f353` … `bb662fd`: job queue, openFDA client and cache expiry, learning loop, scheduled feeds, size worklist, benchmark, model-eval gate, Vitest, observability, notifications, context drift). Everything outside that scope was left to the earlier full-application report (`FULL_APPLICATION_DEBUG_REPORT.md`) and to a later full pass, as asked.

**Method.** Two independent adversarial reviews of the new modules (one on the queue / pipeline / openFDA layer, one on the domain modules and API surface), followed by reproduction, fixing and regression testing of every accepted finding, a live crash test against a production build (kill −9 mid-import, restart, watch recovery), and a second pass over the fixes themselves. Findings are numbered as they were raised; "Status" says what was done. Fixes landed in `6c29502` and `f4b478b`.

## Summary

| | Count |
| --- | --- |
| Findings raised | 62 (24 queue / pipeline / openFDA, 29 domain and API, 6 from the second pass over the fixes, 3 rejected) |
| Accepted and fixed | 54 |
| Accepted, documented, deliberately not changed | 5 |
| Rejected after investigation | 3 |
| P0 | 3 (all fixed) |
| P1 | 9 (all fixed) |
| P2 | 20 (all fixed) |
| P3 | 27 (22 fixed, 5 documented) |

**Most serious.** The custom database adapter handed to pg-boss wrapped every result as `{ rows }`. pg-boss's maintenance pass runs multi-statement SQL whose driver result is an *array* of results, so the wrapper produced `{ rows: undefined }` and the pass crashed every minute — silently, in the `error` event. Consequences: no job expiry, no heartbeat failure, no retention. A worker killed mid-run left its job `active` for ever; nothing in the unit or database suites caught it because none of them killed a process. Found by the live test. Fixed by passing the raw driver result through (pg-boss unwraps it itself); verified by killing a server 4 s into a 4,432-record import — the heartbeat lapsed, pg-boss retried, attempt 2 resumed at the persisted cursor and completed.

**Most interesting chain.** A queue-side abort (job expiry or graceful shutdown) fired the same `signal` the code used for user cancellation. The handler wrote `status: cancelled`, logged "Cancelled by request" and notified the rep — then the retry started 30 s later, flipped the row back to `running` and completed, while (in the expiry case) the original handler was still alive and writing candidates alongside it. Four reasonable pieces — one signal for two meanings, a status written on abort, a retry that resumes, a phase with no cancellation point — made a run that could show *cancelled → running → complete* and end with duplicate rank-1 candidates. Fixed by distinguishing `RunInterrupted` from `RunCancelled`, leaving status and checkpoint untouched on an interruption, making every progress write die on an aborted signal, and adding cancellation points to the long phase.

## Findings

### Queue, pipeline, openFDA (review 1 + live test)

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| Q0 | **P0** | pg-boss adapter wrapped multi-statement results → maintenance crashed every minute; no expiry/heartbeat/retention (live test) | Fixed: raw driver result passed through; `jobs.boss_error` would now be a real error |
| Q1 | P1 | `signal.aborted` treated as user cancel → bogus "Cancelled", zombie attempt running alongside the retry | Fixed: `RunInterrupted`; status/checkpoint kept; `setStage` throws on abort; no notification |
| Q2 | P1 | `cancelRun` / `cancelImport` reset the flag and claimed "cancelled" for a job already picked up → run proceeds, exclusive key released, second concurrent run possible via recovery | Fixed: flag cleared only by the handler that honours it; "cancelled" only when the row was still queued (conditional update); queued→running transition conditional on the flag |
| Q3 | P1 | Killed process left the job `active` for `expireInSeconds` (3–8 h); recovery skipped it; cancel could not reach it | Fixed: `heartbeatSeconds: 60` on every long queue (job-level too, so existing queues get it); expiry raised to the 23 h backstop; SIGTERM/SIGINT hand jobs back (`stopBoss`) |
| Q4 | P1 | Non-final failures shown as `failed`; `enqueueRun` reset the row before knowing the send was deduplicated (wiped checkpoint, orphaned "queued" row) | Fixed: `finalAttempt` passed in; non-final → `queued` + reason; enqueue first, reset only when a job was created; orphan re-queued with `resume` |
| Q5 | P2 | Queue options edited in code never reached an existing queue | Fixed: `updateQueue` after `createQueue` when they differ |
| Q6 | P2 | Orphan recovery bypassed the retry cap → a process-killing request re-queued for ever | Fixed: attempts monotonic across retries and restarts; recovery marks the row failed past the cap |
| Q7 | P2 | "Resolve only pending lines" resume branch unreachable | Fixed: gated on resuming, not on the checkpoint value |
| Q8 | P2 | No cancellation point across candidate build / scoring / grading | Fixed: checks inside every loop and before grading |
| Q9 | P2 | Import cursor indexed a plan recomputed per attempt (bucket order shifts) → silent gaps | Fixed: plan persisted with the cursor; resume walks the same leaves; over-cap buckets logged |
| Q10 | P2 | Enqueue failure stranded a QUEUED import / queued request | Fixed: row failed with the reason; API answers 503 |
| Q11 | P2 | `startWorkers` failure at boot never retried | Fixed: exponential retry in `instrumentation.ts` |
| Q12 | P2 | A 429 drained only the caller's bucket; other workers kept hitting openFDA; full jitter allowed 0 ms retries | Fixed: process-wide pause for Retry-After (or ≥ 5 s); equal jitter |
| Q13 | P2 | Refresh sweep wedged on permanently failing rows; per-code refresh ignored eligibility (could overwrite a `manual` row) | Fixed: error stamps `gudidCheckedAt`; same filter on both paths |
| Q14 | P3 | Logger: `token` matched `tokens`; nested objects unscrubbed; `requestId` field collision; boss timers inherited a request's log context | Fixed: anchored key regex + value-shape detection, recursive scrub, `crossRef` field, detached start |
| Q15 | P3 | Run log read-modify-write lost lines under concurrency | Fixed: atomic `jsonb` append keeping the last 200 (and, from the second pass, in chronological order) |
| Q16 | P3 (8 items) | Expiry-failed jobs bypass `onFinalFailure`; `dbHandle` not on `globalThis`; policy-mismatch fallback keeps the old policy; `null` request body → 500; refresh note accumulated; Phase C non-transactional; over-cap bucket silent; non-JSON 200 threw a raw `SyntaxError` | Six fixed. Two documented: a hung handler's final failure is surfaced by the `jobs_failed` alert rather than a per-request notification; a queue whose policy differs *and* holds jobs keeps running with a warning (never dropped) |

### Domain modules and API surface (review 2)

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| D1 | **P0** | `proposeCross` upserted on `(ownSku, code, "rep")` and rewrote `matchType` on an APPROVED cross — a rep could change a published tier without review | Fixed: non-draft crosses refuse a re-proposal; only DRAFT/RETIRED/REJECTED are editable |
| D2 | **P0** (raised P1, upgraded) | "Mark reviewed" recorded `acceptedTop: false` on every line (route always passed the key; no fallback to the current selection) → the accuracy analytics would report the matcher overridden on every reviewed line | Fixed: key only when present; "reviewed" judges the current selection |
| D3 | P1 | Evidence inflated by toggling; a reviewed/approved cross could be un-retired and its justification overwritten by a rep | Fixed: one endorsement per request line; reviewed crosses only gain evidence |
| D4 | P1 | "Run now" never forced (flag not in the job payload); a run with rejected rows "consumed" the file for ever | Fixed: `force` through the queue; only clean runs consume a hash; rejected rows count as failed |
| D5 | P1 | Dedupe compared titles, so a resubmission within the hour never reached approvers | Fixed: `dedupeKey` column, keyed on the submission |
| D6 | P1 | `RUN_FAILED` never sent; raw driver text would have been the body | Fixed: sent on the final attempt with `publicErrorMessage` |
| D7 | P2 | A rule that threw auto-resolved its alerts, then re-notified on recovery | Fixed: rules own fingerprint families; a failed rule leaves its alerts untouched |
| D8 | P2 | `/api/health` unauthenticated yet expensive (hashed every feed file) and revealed queue/feed topology | Fixed: liveness-only (two queries); detail moved behind `configure_settings`; file hashes cached by mtime/size |
| D9 | P2 | Floor drift only detected when cost changed (policy or list-price moves missed) | Fixed: floor recomputed unconditionally (rounded like the recommender — the first fix produced perpetual drift until this was noticed) |
| D10 | P2 | Deep redaction nulled `summary.byField.cost` → "null cost changes" in the banner | Fixed: targeted redaction of deltas only |
| D11 | P2 | Refresh could interleave with a submission | Fixed: refresh claims the same `lockedAt` lock submission uses |
| D12 | P2 | "Sync now" ran outside the queue, concurrently with the scheduler | Fixed: queued on the feed path and awaited; one ingestion per feed at a time (DB claim) |
| D13 | P2 | Model-eval sample not reproducible (unstable order, non-permuting sort) | Fixed: stable order + seeded Fisher–Yates |
| D14 | P2 | Untrimmed `ownSku` bypassed the unique key | Fixed |
| D15 | P2 | Severity sorted as text (CRITICAL last) | Fixed: ranked in code |
| D16 | P3 | `name in FEEDS` accepted prototype keys | Fixed: `Object.hasOwn` |
| D17 | P3 | Submitter-on-behalf notified of their own request | Fixed |
| D18 | P3 | `reportJson` truncated mid-document | Fixed: bounded arrays, valid JSON |
| D19 | P3 | `lastNotifiedAt` set even when delivery failed | Fixed |
| D20 | P3 | Alert / last-run gauges never set on the web process | Fixed: filled at scrape time |
| D21 | P3 | Server paths in feed responses | Fixed: file names only |
| D22 | P3 | Size worklist double-counted re-uploaded lists; mixed currencies | Fixed: latest request per (account, code); USD observations |
| D23 | P3 | BENCH-* requests visible in lists and the resolution alert | Fixed: excluded |
| D24 | P3 | `OPEN` paths matched by prefix | Fixed: exact match |
| D25 | P3 | Export 500 on an unreadable log | Fixed |
| D26 | P3 | Teams webhook is one shared channel | Documented (OPERATIONS.md) — a property of Teams incoming webhooks, not a defect |
| D27 | P3 | Scheduled competitor-price imports attributed to an arbitrary ADMIN | Documented; fails clearly when no ADMIN exists |
| D28 | P3 | RUNNING feed rows from a dead process never became "failed" | Fixed: treated as failed after the queue's window |
| D29 | P3 | `Request.createdByUserId` has no FK | Documented; a missing recipient is skipped, never fatal |

### Second pass (over the fixes)

| # | Sev | Finding | Status |
| --- | --- | --- | --- |
| S1 | P1 | The new atomic log append kept the newest 200 lines but emitted them newest-first | Fixed; test asserts a real run reads oldest → newest |
| S2 | P2 | Two reps overriding the same code at the same instant: the second `create` lost the unique race | Fixed: becomes an endorsement |
| S3 | P2 | The in-flight guard in `enqueueRun` blocked the create route (a new request is "queued" before it has a job) | Fixed: guard requires a live job; orphans re-queued with resume |
| S4 | P3 | Settings → "Retry failed jobs" called `resume()` (cancelled jobs) instead of `retry()` | Fixed |
| S5 | P3 | `JOBS_SCHEMA` interpolated into SQL unvalidated | Fixed: identifier check |
| S6 | P3 | Test fixture for drift depended on contract insertion order | Fixed (test) |

### Rejected after investigation

| # | Raised as | Why rejected |
| --- | --- | --- |
| R1 | Token-bucket math exceeds the limit | Only if `OPENFDA_RPM` is set to the full published limit; the default is 80 % and the burst fits (32 + 3.2 × 60 = 224 < 240) |
| R2 | Migration unsafe | All new NOT NULL columns have defaults; new tables only; verified applied on three databases |
| R3 | `Retry-After` date parsing | Junk dates parse to a past time → 0 ms, which is harmless |

## Verification

| Suite | Local Postgres 16 | Neon `debug-run` (WebSocket driver) |
| --- | --- | --- |
| `npm test` (Vitest: pure checks 40, Tier 1 units 10, recorded replay 1, Tier 1 database 24) | 75 passed | 75 passed |
| `npm run test:enterprise` | 18 passed | 18 passed |
| `npm run test:adversarial` | 24 passed | 24 passed |
| `npm run check` / `check:enterprise` | 19 / 21 passed | 19 / 21 passed |
| `npm run eval:gate` | OK (warns: no baseline yet) | OK |
| `tsc --noEmit`, `next build` | clean | clean |

**Live crash test** (production build, local Postgres): GUDID import of Applied Medical (4,432 records, 5 pages) started through the API; process killed with SIGKILL 4 s in. Job `active` with `heartbeat_on` set; server restarted 13 s later; heartbeat lapsed at ~60 s; pg-boss moved the job to `retry`; attempt 2 started at 02:07 after the kill, logged "Resumed (attempt 2) at query 1, page 1 after an interruption", fetched all 4,432 records and finished "completed on attempt 2". Before fix Q0 the same job stayed `active` indefinitely.

**Live API checks** (role cookies against the production build): `/api/health` 200 without a session and reveals nothing; `/api/metrics` 401 without a token, Prometheus text with `Bearer $METRICS_TOKEN`; `/api/system` 403 for a rep, full picture for an admin; `x-request-id` returned on every API response and present in the matching JSON log line; `/api/observability/export` 403 for a rep; a request created through the API ran on the inline worker, a re-run was cancelled while queued, and the creator received the `RUN_COMPLETE` notification.

## What was deliberately left alone

- **Expiry-failed jobs do not raise a per-request `RUN_FAILED`** (Q16a): pg-boss fails them outside the handler. The `jobs_failed` alert covers it; with heartbeats, expiry now only means a genuine hang.
- **One shared Teams channel** (D26): inherent to incoming webhooks; documented, personal kinds default to off for Teams.
- **No ownership scoping on drift / notifications / worklists**: horizontal access control is a Tier 0 item and out of this scope.
- **Benchmark and model-eval baselines are unmeasured**: both need data the organisation supplies (historical lists, a model key). The gate warns rather than fails until a baseline is accepted.

## Files changed by the hunt

`src/lib/jobs/{boss,queues,workers,shutdown}.ts`, `src/instrumentation.ts`, `src/lib/pipeline/run.ts`, `src/lib/gudid/{http,refresh,library}.ts`, `src/lib/log.ts`, `src/lib/xref/{learning,governance}.ts`, `src/lib/feeds/index.ts`, `src/lib/notifications/index.ts`, `src/lib/observability/alerts.ts`, `src/lib/proposals/drift.ts`, `src/lib/eval/{model,benchmark}.ts`, `src/lib/catalog/size-coverage.ts`, `src/app/api/{health,metrics,system,feeds,requests,integrations/sync,observability/export}/…`, `src/app/api/proposals/[id]/{drift,refresh-context}/route.ts`, `src/app/api/requests/[id]/lines/[lineId]/route.ts`, `src/proxy.ts`, `src/components/ui.tsx`, `prisma/schema.prisma` + migration `20260917120000_tier1_fixes`, `scripts/test-enterprise.ts`, `tests/db/tier1.test.ts`, `tests/unit/tier1-units.test.ts`, `docs/OPERATIONS.md`.

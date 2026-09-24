# Backups, recovery and retention

The database is almost the whole state of Crosswalk: catalog, curated crosses, requests (which
carry a prospect's purchase list), proposals, contracts, prices, costs, audit trail, the job
queue (`pgboss` schema) and the `Document` rows with their extracted fields and observations.

**One thing lives outside it: the bytes of uploaded documents** (invoices, POs, bid files sent
to extraction), written to `DOCUMENT_STORAGE_DIR` (default `./.data/documents`, one file per
document id). A database dump does not contain them; after a restore the `Document` rows,
extractions, review items and price observations are all there, but "open the source
document" and "re-run extraction" need the files. Back the directory up alongside the dump
(or point `DOCUMENT_STORAGE_DIR` at a mounted, separately backed-up bucket), and copy it back
before the drill's "open a proposal" step includes a document. Everything else is the
database: back it up and you have backed up the system.

## What Neon gives you

| Mechanism | What it is | Where it stands today |
| --- | --- | --- |
| **Point-in-time restore** | Every branch keeps a write-ahead history; a branch can be reset to any instant inside the retention window, or a new branch created from that instant (`restore_snapshot` / "Restore" in the console). | Project history retention is **6 hours**. Raise it to **7 days** (Launch plan or above; up to 30) before customer data lands — `Project settings → Storage → History retention`. |
| **Branches** | `main` (production), `staging`, `ci` — each a copy-on-write child of `main` at the moment it was created, with its own compute and password. | Created 19 Sept 2026. `staging` and `ci` are refreshed from `main` with `reset_from_parent` (or the console) when they should catch up; they never feed back. |
| **Snapshots** | A named, immutable copy of a branch at an instant, kept independent of the history window. | Use for release checkpoints: take one before every `prisma migrate deploy` on `main`. A schedule (`set_snapshot_schedule`) can take a daily one. |
| **Encryption** | Storage is encrypted at rest (AES-256) and every connection is TLS (`sslmode=verify-full` is what the app enforces). | Nothing to configure. |

PITR and snapshots live inside Neon. An **off-platform copy** protects against the account
itself (billing lapse, deleted project, compromised credentials): take a logical dump to your
own storage on a schedule.

## Runbook

### Daily logical dump (off-platform)

```sh
# From a box with the Postgres 17 client tools and the production DATABASE_URL (pooler host is fine).
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file "crosswalk-$(date -u +%Y%m%dT%H%M%SZ).dump"
# The uploaded document bytes are not in the database: archive the directory with the dump.
tar -czf "crosswalk-documents-$(date -u +%Y%m%dT%H%M%SZ).tgz" -C "${DOCUMENT_STORAGE_DIR:-./.data/documents}" .
# Encrypt before it leaves the box, then copy to versioned object storage with a lifecycle
# rule (e.g. keep 35 daily, 12 monthly). The client's major version must match the server's
# (pg_dump 16 refuses a Postgres 17 server): use the postgresql-client-17 tools for a pg17 database.
```

A restore into a fresh branch (never straight over `main`):

```sh
pg_restore --dbname "$STAGING_DATABASE_URL" --clean --if-exists --no-owner --no-privileges crosswalk-….dump
```

### Point-in-time restore (Neon)

1. Note the instant to return to (UTC) and **stop the web and worker processes** so nothing
   writes during the operation.
2. In the console (or `restore_snapshot` via the API): restore `main` to that timestamp.
   Neon keeps the pre-restore state as a backup branch — nothing is lost by trying.
3. Start the app; check `/api/health`, then Settings → System (tenancy line, queue counts).
4. Write the incident down: what was restored, from when, why, who approved.

### Before every production migration

```sh
npm run db:preflight            # rows that would violate the CHECK constraints
# take a Neon snapshot of main ("pre-<version>")
npx tsx scripts/with-secrets.ts -- npx prisma migrate deploy
```

The container entrypoint runs `migrate deploy` on start; the snapshot is the operator's step.

### Quarterly restore drill

Restore the latest logical dump into `staging`, start a staging instance against it, sign in
and open a proposal. If this takes more than an hour or fails, the backup is not a backup.
Record the date and duration in this file.

| Date | Dump | Restore time | Result |
| --- | --- | --- | --- |
| 2026-09-24 (local drill, debug run WS5) | `pg_dump --format=custom --no-owner --no-privileges` of a seeded local database (74 tables incl. `pgboss`, 1.2 MB, 0.3 s) | `pg_restore` into a fresh database: 0.7 s | Row counts identical in every table; no sequences to reset (ids are cuids); `vector` extension, `OwnProduct.embedding vector(1536)` (352 embedded rows) and the HNSW index restored; 15 migrations recorded. Document bytes were, as expected, not in the dump. Evidence: `docs/debug-runs/2026-09-24-full-application/evidence/ws5/backup-roundtrip.txt`. |

## Retention

Retention is a sweep the worker runs nightly (`retention.sweep`, `RETENTION_CRON`, default
02:45 UTC) — **only when `RETENTION_ENABLED=true`**. Out of the box nothing is deleted.

| Data | Variable | Default once enabled | Notes |
| --- | --- | --- | --- |
| Cross-reference requests (the prospect's purchase list, lines, candidates) | `RETENTION_REQUESTS_DAYS` | **never** — must be set explicitly | Only finished requests (`complete`/`failed`/`cancelled`) that no proposal references. Match decisions (learning data) are kept and unlinked. This window is a legal/commercial decision; see [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md). |
| Model-call telemetry (`LlmCall`) | `RETENTION_LLM_CALLS_DAYS` | 90 | |
| Integration sync log | `RETENTION_SYNC_LOG_DAYS` | 180 | |
| Feed / bid-pull runs | `RETENTION_FEED_RUNS_DAYS` | 180 | Running rows are never touched. |
| Read in-app notifications | `RETENTION_NOTIFICATIONS_DAYS` | 180 | Unread ones stay. |
| Analytics snapshots | `RETENTION_SNAPSHOTS_DAYS` | 90 | The newest snapshot of every report always survives. |
| Resolved alerts | `RETENTION_ALERTS_DAYS` | 90 | |
| **Audit events** | — | **never** | Not deletable by this job. |
| Proposals, contracts, prices, costs, catalog, crosses, accounts | — | never | Commercial records of the deployed company. |

`RETENTION_DRY_RUN=true` makes the nightly sweep report only. By hand:

```sh
npm run retention -- --dry-run    # what the windows would remove, per class
npm run retention                 # do it (RETENTION_ENABLED=true, or --force)
```

Each sweep — dry or real — writes one `RETENTION_SWEEP` / `RETENTION_DRY_RUN` audit event with
the counts. Deletes are batched (`RETENTION_BATCH`, default 5,000 rows per class per night);
a long backlog drains over several nights rather than in one long transaction.

Deleting a request removes it from the live database only. It remains in Neon's history
window and in any logical dump until those age out — retention of backups is the dump
storage's lifecycle rule, and the policy should say so.

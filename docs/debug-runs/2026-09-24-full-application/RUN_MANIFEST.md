# Run manifest — full-application debugging run

| Field | Value |
|---|---|
| Started (UTC) | 2026-09-24T06:56:30Z |
| Repository | /home/claude/cracr (cloud workspace copy of funkyfranksinatra/Crosswalk) |
| Starting commit | `ccfc6e8` on `main` (= BUILD_NOTES.md commit; code identical to `1b43393` + docs) |
| Working branch | `debug/2026-09-24-full-application` (created from `main`; no uncommitted user changes existed — `git status` was clean) |
| Remote | origin = GitHub (no credentials in this workspace; nothing is pushed by this run) |
| OS / runtime | Linux 6.18.44-fc-v37; Node v22.22.2; npm 10.9.7 |
| Package versions (lockfile) | next 16.3.5;react 19.2.8;typescript 5.9.3;tailwindcss 4.3.3;prisma 7.10.0;@prisma/client 7.10.0;@prisma/adapter-pg 7.10.0;@prisma/adapter-neon 7.10.0;pg-boss 12.33.0;decimal.js 10.6.0;openai 7.15.0;exceljs 4.4.0;pdfkit 0.20.2;jose 6.2.12;vitest 5.0.1;zod 4.6.4; |
| Docker | not available in this workspace (`docker info` fails) — container roles are exercised via the entrypoint script directly, image build marked BLOCKED |
| Database (disposable) | local PostgreSQL 16.13 at localhost:5432, database `crosswalk_dbg`, adapter `pg`, pgvector installed; created empty by this run, migrated with `prisma migrate deploy`, seeded with `prisma/seed.ts` (reference sheets present) and `prisma/seed-enterprise.ts` (demo) — see evidence/logs/00-bootstrap-dbg.log |
| Database (evaluation reference, read-only for this run) | `crosswalk_ref` on the same server: the matcher-evaluation DB used for the REQ-7628 report (3,652 curated crosses) |
| Neon | never touched by this run |
| Env file | `.env.local.dbg` (gitignored): DATABASE_URL → crosswalk_dbg, DATABASE_ADAPTER=pg, COMPANY_NAME, SESSION_SECRET, ALLOW_DEV_SIGNIN=true, JOBS_WORKER=off, NOTIFY_DRY_RUN=true, LOG_SILENT=true. No values recorded here. |
| Reference data | data/reference/{Endomechanical.xlsx, SSXrefReport_REQ-7604.xlsx, CrossReference_0001880967.xlsx} present (private, gitignored); used read-only |
| Model | no OPENAI_API_KEY in this workspace → heuristic mode; model paths are exercised with the in-repo mock/fault providers only |
| External services | openFDA reachable through the workspace proxy (recorded fixtures used for tests); Salesforce/SAP/GPO/OCR/FX/AvaTax/SAM/SMTP/Teams/Google: no credentials → mock/contract tests only |
| Browser | Chromium via Playwright (`/opt/pw-browsers`) against the local production build |

| Finished (UTC) | 2026-09-24 ~13:30 |
| Final state | the single commit on `debug/2026-09-24-full-application` on top of `ccfc6e8` (`git log -1`); see FINAL_REPORT.md |

# Tier 0 debug report — security and deployment readiness

Scope: **only the Tier 0 changes** (commits `9287235` … `50aa899` and the fix commit
`0ea82fb`). Nothing outside the eight Tier 0 items was reviewed or re-tested beyond running
the existing suites to prove they still pass. Full-system testing stays deferred, as agreed.

Date: 19 September 2026. Build under test: `next build` of the fix commit, run against a
local Postgres 16 with pgvector and the demo seed, plus a local stand-in OpenID Connect
provider (real RS256 keys, discovery, JWKS, token endpoint) for the sign-in flow. No Docker
daemon is available in the build environment; the image's runtime file set was exercised
directly (see below) and the image itself is built and booted by CI on push.

## Method

1. Three independent adversarial reviews of the Tier 0 diff, each with a different lens:
   security / authorization / data exposure; correctness / data integrity / migrations /
   configuration; concurrency / jobs / failure modes / UI–API contract / deployment plumbing.
   Every finding was verified against the source (several live, against a running build)
   before being accepted; several review claims were rejected after checking.
2. `tests/unit/tier0-units.test.ts` (34 cases) and `tests/db/tier0.test.ts` (20 cases)
   extended to pin each fix.
3. Live checks on the production build: scope bypass attempts as a seeded rep, audit-trail
   scoping, security headers by scheme, account-type validation; a complete OIDC sign-in
   (start → provider → callback → session → `/api/auth/me` → replay refused → sign-out →
   provisioned user and audit events) against the stand-in provider; a deliberately broken
   `SSO_ROLE_MAP` stopping the server with the reason as its last log line; rate limiting
   returning `429` with `Retry-After`; ten pages and a client-side navigation under the
   nonce CSP with zero violations (headless Chromium).
4. The container's runtime file set assembled exactly as the Dockerfile copies it and run
   through the entrypoint: preflight → `prisma migrate deploy` → `next start` → `/api/health`
   ready → worker `ready`; the `check` role refusing a weak secret with exit code 1.

## Findings

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| P0 | 2 | 2 | 0 |
| P1 | 6 | 6 | 0 |
| P2 | 14 | 14 | 0 |
| P3 | 16 | 13 | 3 (documented below) |

### P0 — would have defeated the feature

1. **Ownership scoping was bypassed by percent-encoding one character of the id.** The
   proxy recorded the raw path; the scope hook matched `[a-z0-9]{20,}`, so `%6F` in an id
   made it skip while Next decoded the param for the handler. Confirmed live: plain id →
   404, encoded id → 200 with the foreign account. Every `/api/{accounts,requests,proposals,
   contracts}/<id>/…` route was affected. Fix: the proxy decodes the path (undecodable →
   400) and the hook is fail-closed — any segment that is not a short plain word is treated
   as an id and must be visible; malformed ids are 404. Pinned by DB tests (encoded id,
   undecodable, junk, short-but-not-a-word). Verified live: encoded id → 404 for the rep,
   200 for an unscoped role.
2. **Open redirect after SSO sign-in via a tab in `next`.** `"/\t/evil.com"` passed the
   checks and the URL parser strips tabs, resolving to `//evil.com`. A victim would land on
   an attacker's page with a fresh session. Fix: control characters refused, the value is
   resolved against a fixed origin and re-checked (origin, credentials, `//` pathname,
   `/api/`); the callback redirects on `APP_BASE_URL`, never the request origin. Unit test
   covers tab, NUL, `/..//evil.com`, credentials and the resolved form.

### P1 — would have shipped broken or leaked

- **`/api/proposals/[id]/export` resolved the actor itself** and so skipped the scope hook: a
  rep could download any proposal's quote. Now `authorize()`. Verified live.
- **`/api/audit` returned any entity's trail** (or the latest 200 company-wide events) to
  every `view_pricing` user. Scoped roles must now name an account / request / proposal /
  contract in their book; anything else is 404. Verified live.
- **The nested `recommend` route ignored the parent proposal id** — a rep could read (and,
  with `apply`, rewrite) a line of an out-of-scope proposal through an in-scope parent, and
  the recommendation carried unredacted floor and margin. Now the line must belong to the
  proposal in the path and the result goes through the redaction helper.
- **Approvals were not territory-scoped**: a regional manager saw and could decide every
  discount request in the company. Queue and decide now apply the proposal scope; a scoped
  approver's queue is their book of business. DB test pins queue and decide, before and
  after the territory changes.
- **`chk_Account_type` rejected values the accounts API accepts** (`BILL_TO`, `GPO_MEMBER`)
  because the constraint was written from a stale schema comment. One `ACCOUNT_TYPES`
  vocabulary now feeds the API validator, the CRM sync (unknown values normalise to
  `SOLD_TO`) and the constraint; the unit test pins it. Verified live (`BILL_TO` 200; an
  invalid type gets the vocabulary in the 400).
- **A failed start-up left a zombie server.** A secret-provider error or a weak-config
  refusal inside `register()` was cached by Next and every request answered 500 forever —
  unhealthy but never restarted. Now the failure is logged and the process exits (after
  three attempts for a transient provider error). Verified live with a bad `SSO_ROLE_MAP`:
  `refusing to start: SSO_ROLE_MAP maps 'grp' to unknown role 'NOT_A_ROLE'`, exit 1.

### P2 — wrong under realistic conditions

- **Rate limiter**: spoofed `X-Forwarded-For` values bought unlimited attempts, and a flood
  of them reset everyone's counters (`clear()`). Now an instance-wide ceiling per class
  (`RATE_LIMIT_GLOBAL_FACTOR` × the client limit, default 20×) bounds any client identity,
  and eviction drops the oldest windows only. Behind a proxy that does not send the header
  every user shares one bucket — documented as a hard requirement.
- **Implicit role mapping granted roles from arbitrary directory group names** (`finance`,
  `admin`) even with a map configured. Now the implicit mapping applies only when no map is
  set, and is exact-case.
- **Account linking by email re-bound an account already linked to a different subject** —
  a colliding address at the provider would take over the account and its roles. Now
  refused with "linked to a different identity"; `email_verified: false` refused.
- **`upgrade-insecure-requests` and `Secure` cookies keyed off `NODE_ENV`**: a production
  build on a LAN address over plain HTTP would upgrade every asset load to https (broken
  page) and drop the sign-in cookies (sign-in loop). Now the CSP rule follows the request
  scheme and cookies follow `APP_BASE_URL`; TLS is documented as required beyond localhost,
  and the callback explains a missing state cookie.
- **Retention deleted up to 5,000 requests plus cascades inside Prisma's default 5-second
  interactive transaction** — a first sweep over history would time out and, since requests
  run first, nothing else would run either. Now requests go in chunks of 25 (at most 200 a
  night) with no long transaction.
- **A malformed `RETENTION_*_DAYS` took the whole job system down**, and the inline retry
  re-registered every queue's poller each time (growing `request.run` concurrency). The
  config read is guarded; queue registration is once per process.
- **compose overrode `APP_BASE_URL` and `TRUST_PROXY_HOPS` from `.env`** with shell values —
  a real deployment's OIDC redirect URI would silently become `http://localhost:3000`.
  Removed; only `DATABASE_URL` is composed.
- **Image build**: the build stage inherited `NODE_ENV=development`; a developer's stale
  `src/generated` could overwrite the freshly generated Prisma client in the runtime image.
  Both fixed (`.dockerignore`, explicit `NODE_ENV=production`).
- **CHECK constraints were added with a full-table exclusive lock**; now `NOT VALID` +
  `VALIDATE CONSTRAINT` (share-update-exclusive during the scan). Existing rows are still
  validated; the migration regenerated and re-pinned.
- **Price-entry supersede wrote `effectiveTo < effectiveFrom`** for a future-dated prior
  entry, which the new `term_order` constraint would now reject mid-batch. A prior that
  starts at or after the new entry is superseded without an end date.
- **`/api/contracts/renewals` and `/api/intelligence`** returned all accounts' data to scoped
  roles; contract scope and account-linked observation scope applied.
- **Proposal from a request**: the request's own account is now checked as writable, not only
  an explicitly supplied `accountId`.
- **`SESSION_SECRET` was demanded in proxy-header SSO mode**, where nothing is signed; and an
  upgraded header-contract deployment would have been silently signed out because the same
  variables now select the built-in client. `SSO_MODE` unset is a start-up warning with the
  instruction; the secret is required only in oidc mode or with dev sign-in.
- **The retention DB test ran a real, unscoped sweep against whatever `DATABASE_URL` was
  loaded** — on a laptop whose `.env` points at Neon that would have deleted a year of
  history. The suite now runs only against a loopback database.

### P3 — fixed

Sign-in screen used `<Link>` for a route that 302s off-origin (double request, console
error) → plain anchor; `/start` errors were JSON on a top-level navigation → the same HTML
page as the callback, configuration errors kept to the log; OIDC config now validated at
start-up (discovery failure logged, not fatal); `with-secrets` forwards SIGTERM/SIGINT to
`prisma migrate deploy`; the entrypoint runs the constraint preflight before migrating
(`PREFLIGHT_ON_START=false` to skip); `db-preflight` loads secrets before the Prisma client;
the inbox's Teams default for `BREAK_GLASS` matched to the server; rebate `type`/`basis` and
ERP `costType` pre-validated so a bad value is a 400 with the vocabulary, not a database
error; a user with zero roles is scoped rather than unscoped; a missing `x-crosswalk-path`
on an API request is logged; the Tier 3 analytics-snapshot test no longer depends on no
worker having run since the seed.

### P3 — open, by choice

- **Per-instance rate limiting.** Several web instances each keep their own windows; the
  ceiling is per instance. A shared limiter belongs at the load balancer, as documented.
- **Contract entries are written one row at a time, not in a transaction** (pre-existing);
  a mid-batch validation error leaves earlier rows committed. Now less likely to trip on the
  new constraint, still worth a transaction when contracts are next touched.
- **`npm run test:enterprise` / `test:adversarial` pass but the process does not exit on its
  own** (a handle stays open after `prisma.$disconnect()`). Pre-existing — reproduced at
  commit `0056855` before any Tier 0 change — noted so nobody attributes it to Tier 0.

## Review claims rejected after verification

- "CSRF on OIDC logout / dev sign-in": cookies are `SameSite=Lax`, no state-changing GET.
- "State forgery / login CSRF": state, nonce and PKCE verifier are HMAC-sealed in an HttpOnly,
  path-scoped cookie; state compared with `timingSafeEqual`; nonce, issuer, audience, expiry
  and token age all checked (unit tests inject each failure).
- "`x-sso-subject` can be spoofed in oidc mode": the proxy's `hasSession` shortcut only lets
  the request reach the handler, which then 401s; the header is read only in proxy mode.
- "Proxy `matcher` with `missing` is invalid": compiled with Next's own matcher builder.
- "Header duplication between `next.config` and the proxy": both go through `setHeader`,
  one value each.
- "Every other enum list": all 43 remaining enum constraints were grepped against every write
  in `src/`, `scripts/` and `prisma/`; only `Account.type` was wrong.
- "Snapshot 'keep newest' `NOT` clause breaks with zero rows": `NOT: undefined` is valid.
- "pg-boss schedule key / policy": `retention-cron` satisfies the key rule; `exclusive` +
  `singletonKey` prevent a concurrent second sweep.

## Verified live (production build)

Rep vs admin: foreign account 404 plain and encoded, 200 for admin encoded; audit trail 404
for the rep with or without a filter, 200 for admin; the rep's account list excludes the
foreign account; undecodable path 400; `BILL_TO` accepted, `WHATEVER` refused with the
vocabulary. Headers: no `upgrade-insecure-requests` and no HSTS over plain HTTP, both
present with `X-Forwarded-Proto: https`; nonce on all 13 inline scripts; 0 CSP violations
across `/`, requests, proposals, accounts, contracts, analytics, catalog, settings, bids,
approvals and a client-side navigation. Rate limit: 20 sign-in-route hits then `429` with
`Retry-After` and `x-ratelimit-*`. OIDC against the stand-in provider: `/start` 302 with
`code_challenge_method=S256` and the state cookie; provider → callback; callback 302 to the
requested `/proposals` with the session cookie; `/api/auth/me` returns the provisioned
SALES_REP; replaying the callback fails with the state-cookie explanation; sign-out returns
the provider's end-session URL and the session is gone; `SSO_SIGN_IN` / `SSO_SIGN_OUT`
audited; dev sign-in 404 while SSO is on. Start-up refusal on a bad role map exits 1 with
the reason. Runtime file set: preflight clean, migrations applied, web ready, worker ready,
`check` role exit 1 on a short secret.

Suites after the fixes: Vitest 147 (Tier 0 unit 34, Tier 0 DB 20), `test:enterprise` 18,
`test:adversarial` 24, `check` 19, `check:enterprise` 21, `tsc` and `next build` clean.
Neon: `crosswalk_owner` rotated, `staging` and `ci` branches created, preflight clean on
`main`.

## What Alex still has to do

- `npm install` (jose), `npx prisma migrate deploy` (two migrations: break-glass column,
  CHECK constraints — run `npm run db:preflight` first), `npx prisma generate`.
- Update `.env` with the rotated Neon password (sent in the chat, not in this report).
- Decide and set `SSO_*` with the identity provider (`docs/DEPLOYMENT.md` § Identity); until
  then the development sign-in stays as before.
- Sign `docs/DATA_ACCESS_POLICY.md`, raise Neon history retention, schedule the dump; then
  `RETENTION_ENABLED=true` with the agreed `RETENTION_REQUESTS_DAYS`.
- CI's new `image` job runs on the next push and is the first real Docker build of the
  Dockerfile.

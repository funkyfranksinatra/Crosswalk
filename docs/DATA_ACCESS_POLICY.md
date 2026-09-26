# Data access policy

What Crosswalk holds, who may see it, how it is protected, and how long it is kept. This is
the document legal and the data owner sign; the enforcement points are named so the policy
can be checked against the code rather than trusted.

Status: **draft for sign-off** — the retention window for customer purchase data (§5) and
the SSO role mapping (§3) are decisions the organisation makes; everything else is how the
build behaves today.

## 1. Data classes

| Class | Examples | Sensitivity | Where |
| --- | --- | --- | --- |
| **Prospect purchase data** | The competitor codes, quantities and prices a prospect buys (`Request`, `RequestLine`, uploaded bid files as `Document`) | **Confidential — customer's** | Received from the customer for a bid; the most sensitive class |
| **Competitor price intelligence** | Observed competitor prices, their source, who reported them | Confidential — commercial | `CompetitorPriceObservation`, `PublicAward` (public bids are public data) |
| **Own commercial data** | Costs, floors, margins, pricing policies, proposals, contracts, rebates | Confidential — internal, cost/margin restricted further | `StandardCost`, `PricingPolicy`, `Proposal*`, `Contract*`, `PriceEntry` |
| **Catalog and crosses** | Own SKUs, GUDID records, curated equivalences | Internal | `OwnProduct`, `KnownCross`, `CrosswalkVersion` |
| **Accounts** | Customer accounts, hierarchy, GPO membership, ownership/territory | Internal | `Account`, `GpoMembership` |
| **People** | Users' names and work emails, roles, SSO subject | Personal data (employees) | `User`, `UserRole` |
| **Audit and telemetry** | Who did what and when; model calls; job and feed runs | Internal, integrity-critical | `AuditEvent`, `LlmCall`, `FeedRun`, `SyncLog` |

No payment data, no patient data, no personal data about customers' staff beyond what a
rep types into a note.

## 2. Identity

- Production sign-in is the organisation's identity provider over **OpenID Connect**
  (`SSO_ISSUER`, `SSO_CLIENT_ID`; authorization code + PKCE; ID token validated against the
  provider's keys). Crosswalk issues its own signed session (`SESSION_SECRET`, 12 h by
  default) — enforcement: `src/lib/auth/oidc.ts`, `src/lib/auth/index.ts`.
- The development sign-in (pick a seeded user) is refused on a production build unless
  `ALLOW_DEV_SIGNIN=true`; a production start with that flag and no SSO logs a warning
  (`src/lib/secrets.ts`). It must never be set on an instance that holds customer data.
- Deactivating a user (`isActive=false`) ends access at their next request, whatever the
  provider says; deleting them from the provider ends it at session expiry.
- **Authenticating-proxy mode** (`SSO_MODE=proxy`): an upstream SSO proxy terminates OIDC and
  asserts the signed-in user in `x-sso-subject`. Because the application cannot see which
  network hop set a header, the proxy must also send `x-sso-proxy-secret` carrying
  `SSO_PROXY_SHARED_SECRET` (16+ characters, compared in constant time); a subject header
  without it — or with the secret unset — is ignored and the caller is anonymous
  (`proxySubjectFromHeaders`, `src/lib/auth/index.ts`). Outside proxy mode both headers are
  stripped by `src/proxy.ts` before any handler runs. The proxy in front of the application
  must be the only route to it (network policy), and must overwrite both headers on every
  request so a client cannot supply them.

## 3. Authorisation

Two layers, both server-side, both on every request:

- **What a role may do** — the permission matrix in `src/lib/auth/permissions.ts` (tested in
  `scripts/check-enterprise.ts`). Cost and margin are separate permissions (`view_cost`,
  `view_margin`): responses are redacted for roles without them, including nested JSON
  (`redactForActor`, `redactJsonForActor`).
- **Which accounts a role may see** (Tier 0.2) — `SALES_REP` and `REGIONAL_MANAGER` see the
  accounts they own, accounts in their territory, unassigned accounts, children of IDNs they
  own or cover, and anything they created; requests, proposals and contracts follow their
  account. Every other role sees everything. Whether the children of an IDN *nobody owns yet*
  are visible to every scoped user (as the IDN is) or follow their own owner and territory is a
  per-company choice — Settings → "Account visibility" (`scopeUnassignedParent`, default
  `inherit`: visible, the behaviour before the setting existed; `own` narrows it — give regional
  managers territories first, or they lose sight of their reps' accounts and the approvals on
  them); the choice is audited like every setting. A row outside the caller's scope is a 404, never a 403
  (`src/lib/auth/scope.ts`, enforced centrally for every `/api/{accounts,requests,proposals,
  contracts}/<id>/…` route in `src/lib/api.ts`).

**Shared competitor cache** (`PATCH /api/competitor/{id}`). Competitor products resolved from
GUDID are cached once per catalog number and shared by every request that names that code, so
a correction (choose another GUDID record, retype the manufacturer or description) is visible
company-wide and re-bins / re-embeds the product for every later match. Policy: a user with
`manage_catalog` (product marketing, pricing analysts, contracting, admin) may correct any
cached row; a user with only `run_cross_reference` may correct a row only when a request in
their own scope has a line resolved to it (`requestWhere`), i.e. they are correcting something
they can see on their own review screen. Anything else is a 404 (the cache is not
enumerable). Every correction is audited (`CompetitorProduct CORRECTED`, before/after) and
clears the cached bin and embedding hash. Rationale: the alternative — per-request copies —
would let the same code carry different identities in different bids, which is worse for
customers than a rep occasionally fixing a shared record under audit.

**Cross-site requests.** Session cookies are `SameSite=Lax`; in addition `src/proxy.ts`
refuses any cookie-authenticated non-GET `/api` request whose `Sec-Fetch-Site` is not
`same-origin`/`none`, or whose `Origin` host is not the host the request was addressed to
(`X-Forwarded-Host` / `Host` / `APP_BASE_URL`) — `src/lib/security/csrf.ts`. Requests with
neither header (scripts) pass: they hold the cookie itself. No CORS headers are ever sent.

Roles come from the SSO claim named by `SSO_ROLE_CLAIM` (mapped through `SSO_ROLE_MAP`; with a
map set, only mapped values count) and are re-synced at every sign-in; when the claim is
absent, roles set in Crosswalk stand. Approvers who are scoped (regional managers) see and
decide only requests on proposals in their book of business.
**Decision needed:** which provider groups map to which roles, and whether `ADMIN` is granted
through the provider at all (recommended: no — assign it in Crosswalk, to a named few).

Approval of one's own discount request is forbidden. An `ADMIN` may override that as a
**break-glass** action only: a written reason is mandatory, the request is stored flagged,
two audit events are written, and every other `ADMIN` and `PRICING_DIRECTOR` is notified
(`src/lib/approvals/service.ts`). Review break-glass events monthly.

## 4. Protection

| Control | Where |
| --- | --- |
| TLS to the database (`sslmode=verify-full` enforced), TLS to the browser (HSTS once served over HTTPS) | `src/lib/db.ts`, `src/lib/security/headers.ts` |
| Encryption at rest | Neon storage (AES-256); dumps are encrypted before leaving the host (BACKUPS.md) |
| Secrets in a secret manager, never in the image or the repo; placeholder or default secrets refuse to start | `src/lib/secrets.ts` (`SECRETS_PROVIDER`) |
| Content Security Policy (nonce-based, no third-party script), clickjacking and MIME hardening | `src/proxy.ts` |
| Rate limits on sign-in, expensive routes and the API (`x-ratelimit-*` on every API response, `Retry-After` on 429) | `src/lib/security/ratelimit.ts` |
| Upload guards: 20 MB intake / imports, 25 MB documents, 256 KB webhook bodies, and a decompression-bomb check on every spreadsheet upload (declared inflated size, per-part size, ratio) | the upload routes, `src/lib/security/archive.ts` |
| Errors: domain errors answer 400/404/409 with their sentence; database, driver and runtime faults answer 500 with a generic message and go to the server log — never a 400 that hides a bug | `src/lib/api.ts` `errorResponse` |
| Database CHECK constraints on every state/type column and on money and quantity signs | `src/lib/db/constraints.ts` |
| Secrets scrubbed from logs; request ids on every log line | `src/lib/log.ts` |
| Audit trail on every commercial action, with before/after and context, redacted per viewer | `src/lib/audit.ts` |
| Model calls (OpenAI) send competitor codes, product descriptions and attributes for binning and grading; the unresolved-code hint prompt also sends the **customer account name** and sibling codes from the same list. Never prices, costs or people. `useLlm=false` on a request keeps a run heuristic; `LLM_SEND_ACCOUNT_NAME=false` drops the account name from prompts. The model layer has no database access and no tools: it sees only the text the application puts in a request, and its answers go back to the application, which applies the hard constraints and writes the results (`AI_BOUNDARY.md`). | `src/lib/llm/tasks.ts`, `src/lib/match/*` |

Not provided by the application and expected from the platform: network isolation of the
database (Neon IP allow-list or private link), WAF/DDoS at the edge, malware scanning of
uploads, endpoint security on operators' machines.

## 5. Retention

Defaults and mechanism are in [BACKUPS.md § Retention](BACKUPS.md#retention). The policy
decisions:

| Data | Proposed | Decision |
| --- | --- | --- |
| Prospect purchase data (requests) | Delete finished requests **365 days** after upload unless a proposal references them; proposals keep their own line snapshot | ☐ agreed / ☐ other: ____ |
| Uploaded bid files (`Document`) | Keep while any observation or purchase references them; otherwise same window as requests (not yet automated) | ☐ |
| Competitor price observations | Keep; decay is modelled by half-life, old observations stop influencing prices on their own | ☐ |
| Audit trail | Keep indefinitely (integrity record) | ☐ |
| Users | Deactivate on leaving; delete personal data on request after 90 days unless named in an audit event | ☐ |
| Backups | Logical dumps 35 daily + 12 monthly; Neon history 7 days | ☐ |

A customer's request to delete their purchase data is served by deleting the `Request`
rows for their account (`npm run retention` with a one-off window, or by hand) and noting
that backups age out on the schedule above.

## 6. Roles and responsibilities

| Role | Responsibility |
| --- | --- |
| Data owner (commercial) | Approves §3 mappings and §5 windows; reviews break-glass events |
| Platform operator | Secrets, backups, restore drills, SSO configuration, `RETENTION_ENABLED` |
| Every user | Uploads only what the customer supplied for the bid; no personal data of customer staff in notes |

## Sign-off

| Name | Role | Date |
| --- | --- | --- |
| | Legal | |
| | Data owner | |
| | Platform operator | |

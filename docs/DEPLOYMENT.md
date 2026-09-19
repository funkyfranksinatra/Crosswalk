# Deployment

How to run Crosswalk somewhere other than a laptop: one container image, a job worker, a
PostgreSQL with pgvector (Neon or your own), an identity provider, and a handful of secrets.
Everything below is what Tier 0 built; [OPERATIONS.md](OPERATIONS.md) covers running it
day to day, [BACKUPS.md](BACKUPS.md) recovery and retention, [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md)
who may see what.

## Topology

```
browser ──TLS──► reverse proxy / load balancer ──► web (next start, :3000)  ──┐
                 (terminates TLS, sets X-Forwarded-*)                        ├──► PostgreSQL 17 + pgvector
                                                    worker (pg-boss jobs)  ──┘        (Neon: main / staging / ci)
                                                                                     identity provider (OIDC)
                                                                                     secret manager (optional)
```

- **web** serves pages and the API. With `JOBS_WORKER=inline` (the default) it also runs the
  job queue in-process — fine for a single instance. With `JOBS_WORKER=external` it leaves
  jobs to one or more **worker** containers, which is what the compose stack does.
- Every instance is stateless: sessions are signed cookies, uploads go to the database, the
  rate limiter is per instance (put a shared one at the proxy when you run several).
- The database must have the `vector` extension available (Neon has it; the
  `pgvector/pgvector:pg17` image has it). The migration creates it.

## The image

```sh
docker build -t crosswalk .
docker run --env-file .env -p 3000:3000 crosswalk           # web; runs `prisma migrate deploy` first
docker run --env-file .env crosswalk worker                  # a worker (set JOBS_WORKER=external on the web)
docker run --env-file .env crosswalk migrate                 # migrations only
docker run --env-file .env crosswalk check                   # secret / config checks; exit code tells
docker run --env-file .env crosswalk npx tsx scripts/retention.ts --dry-run   # any script
```

The entrypoint (`deploy/entrypoint.sh`) is `web | worker | migrate | check | <command>`.
`MIGRATE_ON_START=false` skips the migration on `web` (run `migrate` as a release step
instead; do that when you run more than one web instance so only one migrates).
`HEALTHCHECK` polls `/api/health` (database + queue). CI builds the image and boots it on
every push (`.github/workflows/ci.yml`, job `image`).

## One host with compose

```sh
cp .env.example .env               # SESSION_SECRET, OPENAI_API_KEY, SSO_*, APP_BASE_URL, …
export POSTGRES_PASSWORD='a-real-password'
docker compose -f deploy/docker-compose.yml up -d --build
```

`deploy/docker-compose.yml` runs `db` (pgvector, not published), `web` and `worker`;
`DATABASE_URL` is composed from `POSTGRES_PASSWORD` and overrides the one in `.env`. Point
`DATABASE_URL` at Neon and drop the `db` service for the managed-database variant.

## Environment

The full list with comments is `.env.example`. What a deployment must decide:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres URL. Neon: the pooler host with `sslmode=verify-full` (the app upgrades `require` to `verify-full` itself). `DATABASE_ADAPTER=pg` (default) over TCP; `neon-ws` where only outbound HTTPS is allowed. |
| `SESSION_SECRET` | Signs sessions. 16+ random characters; production refuses the development key. |
| `APP_BASE_URL` | Public URL (`https://crosswalk.example.com`): links in notifications and the OIDC redirect URI. |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_ROLE_CLAIM`, `SSO_ROLE_MAP` | Identity — see below. |
| `OPENAI_API_KEY` | Matching model; without it runs are heuristic. `OPENFDA_API_KEY` raises the GUDID rate limit. |
| `JOBS_WORKER` | `inline` (default) or `external` with worker containers. |
| `SECRETS_PROVIDER` | `env` (default), `aws`, `vault`, `doppler`, `file` — see Secrets. |
| `TRUST_PROXY_HOPS` | Which `X-Forwarded-For` entry is the client (default 1: set by the nearest proxy). |
| `RATE_LIMIT_*`, `CSP_REPORT_ONLY` | Request security (defaults are sensible; see `.env.example`). |
| `RETENTION_*` | Off until `RETENTION_ENABLED=true`; see BACKUPS.md. |
| `NODE_ENV=production` | Set by the image. A production build refuses weak configuration (below). |

Never set `ALLOW_DEV_SIGNIN=true` on a shared instance; it exists for a demo box nobody
outside the team can reach, and the server logs a warning while it is on.

## Identity (OIDC)

Register Crosswalk with the provider as a web application with redirect URI
`<APP_BASE_URL>/api/auth/oidc/callback`:

- **Entra ID**: App registration → Authentication → Web platform, that redirect URI; a client
  secret (or none — PKCE is used either way); App roles named after Crosswalk roles
  (`SALES_REP`, `PRICING_DIRECTOR`, …) assigned to users/groups. `SSO_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`,
  `SSO_ROLE_CLAIM=roles`.
- **Okta**: OIDC web app, same redirect URI; add a `groups` claim to the ID token filtered
  to the Crosswalk groups. `SSO_ISSUER=https://<org>.okta.com` (or the authorization server
  URL), `SSO_ROLE_CLAIM=groups`, `SSO_ROLE_MAP="CW-Reps=SALES_REP,CW-Pricing=PRICING_ANALYST,…"`.
- **Keycloak**: `SSO_ROLE_CLAIM=realm_access.roles`.

Users are created on first sign-in (`SSO_AUTO_PROVISION=true`, the default) with the roles
the token carries; the claim is authoritative on every sign-in. A pre-created user is matched
by email and gains the provider subject. `ADMIN` is best assigned in Crosswalk to a named few
rather than through the provider. To keep an authenticating reverse proxy that already
terminates OIDC, set `SSO_MODE=proxy` and have it send `x-sso-subject`.

## Secrets

Secrets can stay in the environment (a `.env` file the orchestrator mounts, Kubernetes
secrets as env) or come from a secret manager, fetched once at start-up by web, worker and
the migrate step:

| `SECRETS_PROVIDER` | Configuration |
| --- | --- |
| `aws` | `AWS_SECRET_ID` (a JSON secret of `KEY: value`); credentials from the usual chain; `npm install @aws-sdk/client-secrets-manager` (not bundled) |
| `vault` | `VAULT_ADDR`, `VAULT_TOKEN` or `VAULT_TOKEN_FILE`, `VAULT_SECRET_PATH` (KV v2 path such as `secret/data/crosswalk/prod`), `VAULT_NAMESPACE` |
| `doppler` | `DOPPLER_TOKEN` (service token; `DOPPLER_PROJECT`/`DOPPLER_CONFIG` if unbound) |
| `file` | `SECRETS_FILE` — JSON or `KEY=value` lines (a mounted secret volume) |

Values fill keys the environment does not already set (`SECRETS_OVERRIDE=true` reverses
that). Key names are logged; values never are.

**A production build refuses to start** when `SESSION_SECRET` is the development key, shorter
than 16 characters or a placeholder; when `DATABASE_URL` uses a default/example password on a
non-loopback host or has no `sslmode` for a remote host; or when an API secret is a
placeholder. `npm run secrets:check` (or the image's `check` role) runs the same check.

## Releases

1. `npm run db:preflight` against the target database (rows that would violate the CHECK
   constraints), and a Neon snapshot of `main` (BACKUPS.md).
2. Deploy the new image with `MIGRATE_ON_START=true` on a single web instance, or run the
   `migrate` role once, then roll the rest.
3. `GET /api/health` → `ok`; Settings → System shows the version, queue counts, tenancy line.
4. Roll back by deploying the previous image; migrations are additive and the previous code
   runs against the newer schema.

Branch plan on Neon: `main` for production, `staging` for release rehearsal (reset from
`main` before each), `ci` for GitHub Actions when the CI job is switched from the ephemeral
service container to Neon. Each has its own password; rotate with the console or the API.

## Behind the proxy

- Terminate TLS at the proxy and forward `X-Forwarded-Proto: https` (HSTS and `secure`
  cookies key off it) and `X-Forwarded-For`.
- Pass `/api/health` through unauthenticated for the load balancer; `/api/metrics` is
  token-guarded (`METRICS_TOKEN`).
- Body size: uploads are capped in the app (20 MB bid files); set the proxy's limit at or
  above that.
- The app sets a nonce-based Content Security Policy and the hardening headers itself; do
  not add a second CSP at the proxy.

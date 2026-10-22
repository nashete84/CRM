# CRM

A metadata-driven CRM platform covering sales (leads, accounts, opportunities, forecasting) and service (cases, entitlements, knowledge, routing). Object and field API names follow Salesforce conventions so data can move between the two.

Built clean-room from public documentation. Design decisions and the alternatives rejected are in [DECISIONS.md](DECISIONS.md).

## Layout

| Path | What it is |
|---|---|
| `apps/api` | Fastify HTTP API |
| `packages/db` | Database connection, migrations (Kysely) |

More packages arrive with their build steps: `metadata`, `sharing`, `soql`, then `apps/web`.

## Run locally

Requires Node 22, pnpm 10 and Docker.

```sh
cp .env.example .env
docker compose up -d          # Postgres 16 with the owner and app roles
pnpm install
set -a; . ./.env; set +a
pnpm db:migrate               # runs as the owner role
pnpm dev                      # API on http://localhost:3000
curl localhost:3000/health/ready
```

## Provision an org

There is no self-signup. Create an org and its first user with the admin CLI:

```sh
pnpm --filter @crm/api cli create-org --name "Acme UK" --slug acme-uk \
  --admin-email ana@acme.test --admin-name "Ana Ruiz"

# Development sign-in (needs ALLOW_LOCAL_LOGIN=true)
CRM_PASSWORD='at least twelve characters' \
  pnpm --filter @crm/api cli set-password --org acme-uk --email ana@acme.test

# Single sign-on: register the org's identity provider
pnpm --filter @crm/api cli add-idp --org acme-uk --name Entra \
  --issuer https://login.microsoftonline.com/<tenant>/v2.0 \
  --client-id <client id> --secret-env ACME_ENTRA_SECRET
```

Users then sign in at `/auth/<org slug>/oidc/<provider id>`. Register `APP_ORIGIN/auth/oidc/callback` as the redirect URI at the identity provider.

## Auth endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/auth/login` | Email + password sign-in (development only). Returns a bearer token and sets the session cookie. |
| GET | `/auth/:org/oidc/:provider` | Starts single sign-on with an org's identity provider. |
| GET | `/auth/oidc/callback` | Identity provider redirects here. Starts the session. |
| GET | `/auth/me` | The signed-in user and their org. |
| POST | `/auth/logout` | Ends the current session. |

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

Database tests run when `DATABASE_URL` and `DATABASE_ADMIN_URL` are set and are skipped otherwise. CI always sets them.

## Database roles

- `crm_owner` owns the schema and runs migrations. The API never uses it.
- `crm_app` is what the API connects as. It is not a superuser and cannot bypass row-level security, so tenant isolation applies to every query the API makes.

## Tenant isolation

Every tenant table has an `org_id` column and a row-level security policy. API code reaches tenant data only through `withOrg(db, orgId, fn)`, which scopes one transaction to one org; outside it every tenant table looks empty. A test fails if a new table with an `org_id` column lacks a policy. See DECISIONS.md D-015 to D-017.

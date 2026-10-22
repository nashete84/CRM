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

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

Database tests run when `DATABASE_URL` and `DATABASE_ADMIN_URL` are set and are skipped otherwise. CI always sets them.

## Database roles

- `crm_owner` owns the schema and runs migrations. The API never uses it.
- `crm_app` is what the API connects as. It is not a superuser and cannot bypass row-level security, so tenant isolation (step 2) applies to every query the API makes.

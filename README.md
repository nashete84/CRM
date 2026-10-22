# CRM

A metadata-driven CRM platform covering sales (leads, accounts, opportunities, forecasting) and service (cases, entitlements, knowledge, routing). Object and field API names follow Salesforce conventions so data can move between the two.

Built clean-room from public documentation. Design decisions and the alternatives rejected are in [DECISIONS.md](DECISIONS.md).

## Layout

| Path | What it is |
|---|---|
| `apps/api` | Fastify HTTP API |
| `packages/db` | Database connection, migrations (Kysely), tenant isolation helpers, record IDs |
| `packages/metadata` | Metadata engine: objects, fields, picklists, record types, describe, field value rules |
| `packages/records` | Records: create, read, update, upsert, delete, undelete, purge |

More packages arrive with their build steps: `sharing`, `soql`, then `apps/web`.

## Metadata engine

Objects and fields are rows, not tables, so each org can define its own schema at runtime. API names, field types, limits and the describe format follow Salesforce, so a real org's schema maps 1:1.

```ts
import { withOrg } from "@crm/db";
import { createObject, createField, describeObject } from "@crm/metadata";

await withOrg(db, orgId, async (tx) => {
  const ctx = { tx, orgId };
  await createObject(ctx, { label: "Invoice", pluralLabel: "Invoices",
    nameField: { label: "Invoice Number", type: "AutoNumber", displayFormat: "INV-{0000}" } });
  await createField(ctx, "Invoice__c", { type: "Currency", label: "Total" });
  await createField(ctx, "Invoice__c", { type: "Picklist", label: "Status",
    values: ["Draft", { value: "Sent", isDefault: true }, "Paid"] });
  await createField(ctx, "Invoice__c", { type: "Lookup", label: "Approver", referenceTo: "User" });
  return describeObject(ctx, "Invoice__c"); // Salesforce DescribeSObjectResult shape
});
```

Supported field types: Text, TextArea, LongTextArea, Email, Phone, Url, Number, Currency, Percent, Checkbox, Date, DateTime, Picklist, MultiselectPicklist, Lookup, MasterDetail, AutoNumber. Formula and Roll-Up Summary come with the formula engine. Errors are `MetadataError` with Salesforce-style codes (`DUPLICATE_DEVELOPER_NAME`, `LIMIT_EXCEEDED`, ...) and the input property they refer to.

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

## Records

Every record of every object lives in one `record` table; field values sit in JSONB keyed by field ID. Values are validated and normalised per field type, and the API shape follows Salesforce's REST API.

```ts
import { createRecord, deleteRecord, undeleteRecord, upsertRecord, getRecord } from "@crm/records";

await withOrg(db, orgId, async (tx) => {
  const ctx = { tx, orgId, userId };          // userId: who is acting (audit fields, default owner)
  const { id } = await createRecord(ctx, "Invoice__c", { Client__c: clientId, Total__c: "1234.50" });
  await upsertRecord(ctx, "Client__c", "Code__c", "ACME", { Name: "Acme Ltd" });  // by external ID
  const result = await deleteRecord(ctx, "Client__c", clientId);   // children go to the recycle bin too
  await undeleteRecord(ctx, "Client__c", clientId);                // and come back together
  return getRecord(ctx, "Invoice__c", id);    // { attributes: { type, url }, Id, Name, ..., Total__c: 1234.5 }
});
```

Errors are `RecordError` with Salesforce's per-record shape: `errors: [{ statusCode, message, fields }]`, for example `REQUIRED_FIELD_MISSING`, `DUPLICATE_VALUE`, `INVALID_CROSS_REFERENCE_KEY`, `DELETE_FAILED`.

Records run in system mode: data rules are enforced, permissions and sharing are not yet (step 5).

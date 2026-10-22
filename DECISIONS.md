# DECISIONS.md — CRM platform (Sales + Service)

Format: **Chose** / **Rejected (why)**. Newest at the bottom.

---

## D-001 · Source of truth: clean-room, not reverse engineering
- **Chose:** Build from Salesforce's public documentation (Object Reference, ERDs, Help) and the team's own org metadata. All code and UI original.
- **Rejected:** Running REA against Salesforce's web app. Salesforce's subscription terms prohibit reverse engineering and building competing products, and the risk would extend to any client org used.

## D-002 · Discovery answers (2026-10-22)
| # | Question | Answer |
|---|---|---|
| 1 | Purpose | Internal tool for one company |
| 2 | Scope | Sales + Service, deeper |
| 3 | Customisation | Full metadata-driven custom objects and fields |
| 4 | Tenancy | Multi-tenant from day one ⚠️ *conflicts with #1, open question Q-A* |
| 5 | Security | Full: OWD, role hierarchy, sharing rules, profiles, permission sets |
| 6 | Stack | Claude chooses |
| 7 | Salesforce relationship | Salesforce-compatible API names, 1:1 export mapping |

## D-003 · Stack
- **Chose:** TypeScript pnpm monorepo. `apps/api` (Fastify), `apps/web` (React + Vite + TanStack Query/Router), `packages/metadata`, `packages/soql`, `packages/sharing`. PostgreSQL 16. Kysely for SQL.
- **Rejected:**
  - *Prisma / Drizzle as the data layer.* Both assume a schema fixed at build time, and tenants define objects at runtime. (They could still be used for the platform's own fixed tables; Kysely does both.)
  - *Next.js full-stack.* The API is a product in itself (Salesforce-shaped REST + SOQL). Keeping it a separate service keeps the security boundary in one place.
  - *Django.* Workable, but a single language from the formula engine to the UI is worth more here.

## D-004 · Storing tenant-defined objects
- **Chose:** Metadata as data (`object_def`, `field_def`). All records live in one `record` table: `org_id`, `object_id`, `id` (Salesforce-style 18-char), system fields as real columns, everything else in `data JSONB` keyed by field id (not API name, so renames are free). Filterable, unique and external-id fields are mirrored into a typed `record_index` table (string, number and date columns).
- **Rejected:**
  - *Real Postgres table per object per tenant (runtime DDL).* Thousands of tables, migrations under load, locking on field add.
  - *Salesforce's own flex-column design (Value0…ValueN text columns + pivot tables).* Proven at their scale, but it reimplements typing that JSONB plus an index table give us cheaply.
  - *JSONB expression index per field.* Index count explodes with tenants × fields.

## D-005 · Tenant isolation
- **Chose:** `org_id` on every row, plus Postgres Row-Level Security keyed on a per-transaction `app.org_id` setting. App code filters too, as defence in depth.
- **Rejected:** Schema-per-tenant (migration fan-out) and database-per-tenant (overkill for an internal tool).

## D-006 · Sharing model
- **Chose:** Salesforce semantics, enforced in the data layer (never only in the UI):
  - Org-wide defaults per object: Private / Read / ReadWrite / ControlledByParent.
  - Role hierarchy stored as a closure table.
  - Public groups and queues.
  - A `record_share` table (equivalent of `__Share`) holding row causes: Owner, Rule, Manual, Team.
  - Ownership-based and criteria-based sharing rules.
  - Profiles + permission sets: object CRUD and field-level security.
  - Share rows recomputed asynchronously on owner, role or rule change.
- **Rejected:** Evaluating sharing at query time only. Correct, but too slow for list views over large tables.

## D-007 · Query and API surface
- **Chose:** A SOQL subset compiled to SQL, with sharing and FLS injected at compile time. A REST surface shaped like `/services/data/vXX.X/{sobjects,query}` with describe calls, so exports and tooling map 1:1 (answer #7).
- **Rejected:** GraphQL-first. Not Salesforce-compatible and adds a second authorization path.

## D-008 · Build order
- **Chose:** Platform first, headless (metadata → records → sharing → SOQL → REST), proven with tests before any UI. Then the Sales objects, then Service.
- **Rejected:** UI-first vertical slice. It would hard-code Account/Opportunity and need rewriting once metadata-driven storage lands, which is exactly the redo loop to avoid.

---

## D-009 · Answers to open questions (2026-10-22)
- **Q-A Tenancy → multiple business units of one company.** Keep `org_id` + RLS from step 2 (D-005). No tenant self-signup, no billing. Org provisioning is an admin-only operation.
- **Q-B Code → GitHub `nashete84/CRM`**, branch `main`.
- **Q-C Identity → OIDC SSO** (Entra ID / Okta / Google) plus local email+password for development only, disabled in production by config.

## D-010 · Two database roles
- **Chose:** `crm_owner` owns the schema and runs migrations; `crm_app` is the only role the API uses, created `NOSUPERUSER NOBYPASSRLS`. A test asserts both flags so the guarantee can't silently regress.
- **Rejected:** A single role for both. Table owners and superusers bypass RLS by default, which would make the step 2 tenant isolation a no-op.

## D-011 · Tooling
- **Chose:** Biome for lint + format (one fast tool), Vitest for tests, tsx to run TypeScript directly, Zod for config validation that lists every bad variable at once.
- **Rejected:** ESLint + Prettier (two tools, slower, more config for the same result at this stage). A build step for the API (not needed until we containerise; tsx runs the sources).

## D-012 · No web app yet
- **Chose:** `apps/web` is not scaffolded in step 1. It arrives in step 9, once the API it renders exists.
- **Rejected:** An empty Vite stub now. It would sit unused for eight steps and drift from whatever the API ends up needing.

## D-013 · Health endpoints split
- **Chose:** `/health/live` (process up, no dependencies) and `/health/ready` (database reachable, else 503).
- **Rejected:** A single `/health` that checks the database. An orchestrator would restart healthy API processes during a database blip.

## D-014 · Salesforce-compatible record IDs
- **Chose:** 18-character IDs everywhere: 3-character key prefix (`00D` org, `005` user, `0SO` auth provider), 12 random base62 characters from the CSPRNG, and the 3-character case-checksum suffix. Accept 15-character IDs on input, always emit 18. Each table also has a CHECK constraint on its prefix.
- **Rejected:** UUIDs (breaks answer #7: exports would not map 1:1 to Salesforce shapes). Sequential IDs (leak record counts and creation order between users).

## D-015 · Tenant isolation mechanics
- **Chose:** One `withOrg(db, orgId, fn)` helper opens a transaction and sets `app.org_id` with `set_config(..., true)`, which is transaction-local, so it cannot leak to the next request on a pooled connection. Every policy compares against `app_org_id()`, which returns NULL when unset, so a query outside `withOrg` sees nothing. Cross-tenant references are composite `(org_id, id)` foreign keys.
- **Rejected:** `SET app.org_id` at session level (survives on pooled connections, the classic RLS leak). Filtering only in application code (one forgotten `where` leaks data).
- **Known limit:** the app role can call `set_config` itself, so a SQL injection could switch orgs. All queries are parameterised through Kysely; raw SQL must use the `sql` tag, never string concatenation.

## D-016 · RLS enabled, not forced
- **Chose:** `ENABLE ROW LEVEL SECURITY` without `FORCE`. Table owners bypass non-forced RLS, and the owner role is used only by migrations and two audited functions (D-017). A test asserts that `crm_app` owns no table.
- **Rejected:** `FORCE ROW LEVEL SECURITY`. It would also bind the owner, so the two lookups that must work before an org is known would need a separate BYPASSRLS role, which managed Postgres services often don't allow.

## D-017 · The only two cross-org lookups
- **Chose:** `SECURITY DEFINER` functions with a pinned `search_path`, executable only by `crm_app`: `auth_resolve_org(slug)` returns an org id, and `auth_resolve_session(token_hash, idle)` returns org and user for a live session of an active user. Nothing else in the API can read across orgs.
- **Rejected:** A global `users` table keyed by email for sign-in (a person can belong to more than one business unit, and it would be a cross-org read path in normal code).

## D-018 · Sessions
- **Chose:** Opaque random tokens (256 bits). Only the SHA-256 hash is stored. 12-hour absolute and 2-hour idle expiry, `last_seen_at` written at most once a minute. Browsers get an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` prefixed over https); API clients use `Authorization: Bearer`. Deactivating a user ends their sessions immediately.
- **Rejected:** JWT sessions. They can't be revoked before expiry without a server-side list, which is a session table anyway.

## D-019 · Cross-site request forgery
- **Chose:** Unsafe methods (POST, PUT, PATCH, DELETE) are refused when the `Origin` header names another site, and cookie-authenticated unsafe requests must carry an `Origin`. Bearer requests are exempt because browsers never attach them automatically.
- **Rejected:** CSRF tokens. All supported browsers send `Origin` on unsafe requests, so a token adds state and a round trip for no extra protection. Revisit if the API is ever embedded cross-origin (that needs CORS anyway).

## D-020 · OIDC sign-in
- **Chose:** Authorization code flow with PKCE (S256), state and nonce, via `openid-client` v6. The browser carries login state in a signed, `HttpOnly`, 10-minute cookie scoped to `/auth/oidc`. Returning users are matched only by `(provider, subject)`. Email matching happens once, on first sign-in, and only when the org enabled `allow_email_linking` for that provider and the IdP sent `email_verified: true`. A user can hold one identity per provider. Users are never created on sign-in; administrators provision them.
- **Rejected:** Matching by email on every sign-in (an IdP that lets users change their email becomes an account-takeover path). Just-in-time user creation (anyone in the IdP tenant would get a CRM user without a profile or role).
- **Known limit:** discovery documents and client secrets are cached until the process restarts, so a rotated client secret needs a restart.

## D-021 · Local passwords (development only)
- **Chose:** scrypt (N=2^17, r=8, p=1) with parameters stored in the hash. Every failure (unknown org, unknown email, wrong password, deactivated user, no password set) returns the same message after one scrypt computation, so neither the message nor the timing reveals which. Rate limited per client address (`LOGIN_RATE_LIMIT_PER_MINUTE`, default 10). The route doesn't exist unless `ALLOW_LOCAL_LOGIN=true`, and config refuses that in production.
- **Rejected:** bcrypt (72-byte input limit). Argon2 (needs a native module; scrypt is in Node's standard library).

## D-022 · Error responses
- **Chose:** Salesforce-style bodies `{ errorCode, message }` (`INVALID_SESSION_ID`, `INVALID_LOGIN`). Anything that would be a 5xx returns `UNKNOWN_EXCEPTION` with a generic message; the detail goes only to the log. Authorization headers and cookies are redacted from logs.

## D-023 · Metadata engine scope (step 3)
- **Chose:** 17 field types: Text, TextArea, LongTextArea, Email, Phone, Url, Number, Currency, Percent, Checkbox, Date, DateTime, Picklist, MultiselectPicklist, Lookup, MasterDetail, AutoNumber. Plus picklist values, record types with per-type picklist subsets, and a Salesforce-shaped describe.
- **Deferred:** Formula and Roll-Up Summary (step 7, with the formula engine), so no expression is ever stored before something can validate it. Literal default values other than checkbox defaults also wait for step 7, where Salesforce treats defaults as formulas.
- **Deferred:** HTTP endpoints that change metadata. Without permissions (step 5) any signed-in user could change the schema. The engine ships as a library; the describe API arrives in step 8, the Setup UI in step 9.

## D-024 · Built-in User object
- **Chose:** `object_def` has a `storage` column. User is a `platform` object: described like any other so lookups, OwnerId and CreatedById can point at it, but its rows stay in `app_user` and its fields map to columns. It's created for every org (CLI, and a backfill in migration 0003) and is read-only through the metadata API.
- **Rejected:** Special-casing "User" as a lookup target string. Describe, SOQL (step 6) and sharing (step 5) would each need their own exception.

## D-025 · Field settings in a validated JSONB column
- **Chose:** Settings that apply to every type are real columns (required, unique, external ID, relationship target and rule). Type-specific ones (length, precision, scale, display format) go in `props`, validated by a strict Zod schema per type, so a misspelt setting is an error rather than silently ignored. Relationship columns carry database CHECKs that hold even if the app has a bug.
- **Rejected:** One column per setting across all types (mostly-null columns and a migration for every new type).

## D-026 · Salesforce rules and limits, enforced
- **Chose:** Enterprise Edition limits (200 custom objects, 500 custom fields, 40 relationship fields, 2 master-detail fields, 3 master-detail levels, 25 external IDs, 1000 picklist values). Naming rules match Salesforce exactly, including case-insensitive uniqueness and no reserved custom names, so any real org's schema can be imported 1:1 (answer #7).
- **Master-detail:** always required, cascade delete, can't point at itself or User, can't form a loop. Adding one sets the object's sharing to Controlled by Parent and removes OwnerId from describe; removing the last one restores Public Read/Write.
- **Lookups:** a required lookup must use Restrict on parent delete.
- **Type changes** are refused (delete and recreate), except an object's Name field switching between Text and Auto Number, as Salesforce allows.

## D-027 · Identifiers and ordering
- **Chose:** Key prefixes `01I` (object), `00N` (field) and `012` (record type). Custom objects get key prefixes `a00`, `a01`, ... per org. Records are ordered by an identity column (`seq`), not by timestamp, because everything created in one transaction shares the same `now()`.
- **Chose:** The foreign key from a relationship field to its target object is `DEFERRABLE INITIALLY DEFERRED`. Deleting an org cascades to both ends of every relationship, and Postgres can run an immediate check mid-cascade. The service still pre-checks and names the blocking fields when a single object is deleted.

## D-028 · Migrations listed statically
- **Chose:** `packages/db/migrations/index.ts` lists every migration. Kysely's file-scanning provider uses a native `import()` that bypasses the test runner's module resolution, so migration 0003, which imports shared code, failed under Vitest while working under tsx.
- **Rejected:** Keeping migrations free of imports. The User object definition would then be duplicated in two places that must agree.

## Obligations carried to step 4 (records)
All six are handled in step 4; see D-033.

## D-029 · Records run in system mode until step 5
- **Chose:** `@crm/records` enforces data rules (types, required, unique, lookups, record types, owners) but not permissions. It takes the acting user only for audit fields and default ownership. Step 5 wraps it with object permissions, field-level security and sharing; nothing outside the platform calls it before then, and there are still no HTTP endpoints.
- **Rejected:** Building permission checks into the write path now. They depend on profiles and sharing, which don't exist yet, and would have to be rewritten.

## D-030 · Stored value formats
- **Chose:** Values in `record.data` are JSON strings, except checkbox (boolean). Numbers, currency and percent are exact decimal strings with the field's scale ("1234.50"), parsed with BigInt arithmetic and rounded half away from zero, as Salesforce does. Date-times are stored in UTC and returned as `2026-10-22T08:00:00.000+0000`. Multi-select values are stored as "A;B" in picklist order. Empty values are never stored, so "has a value" is just "key present".
- **Rejected:** JSON numbers (binary doubles lose digits past ~15, and currency allows 18). A Postgres `numeric` column per field (one column per field is what D-004 rejected).

## D-031 · record_index
- **Chose:** Unique fields, external IDs and every lookup and master-detail value are mirrored into `record_index` with a normalised key (lower-cased for case-insensitive text and email, canonical decimals, 18-character IDs). A partial unique index on (field, key) for active rows enforces uniqueness even under concurrent writes; the app pre-checks only to give a friendly message. Lookups in the index let deletes find children without scanning JSON.
- **Rejected:** A JSONB expression index per field (D-004). Uniqueness checked only in app code (two concurrent saves would both pass; a test proves the database stops the second).

## D-032 · Recycle bin and delete rules
- **Chose:** Deleting is soft. Master-detail children go with their master down every level. A Restrict lookup from a surviving record blocks the delete and names the blockers; a SetNull lookup is cleared and logged. Everything deleted together shares a `deletion_id`. Only the record the user deleted can be undeleted, bringing its children back and restoring cleared lookups unless someone has set them since. Records in the bin don't hold unique values; undelete fails if a value has been taken. `purgeDeleted` removes whole groups, by ID or older than N days (Salesforce keeps 15).
- **Rejected:** Hard delete with database cascades. No undelete, and SetNull can't be reversed.
- **Not yet:** Nothing calls `purgeDeleted` on a schedule. That's a job to set up when the API is deployed.

## D-033 · Schema changes never invalidate or silently lose data
- **Chose:** Where Salesforce would truncate, round or leave invalid data behind, this platform refuses the change and says how many records are in the way:
  - Making a field required, or adding a required field, while records lack a value.
  - Making a field unique (or case-insensitive) while live records share a value.
  - Shortening text, or reducing precision or scale, below an existing value. A safe scale change reformats stored values.
  - Restricting a picklist while records hold values outside it.
  - Adding a master-detail field to an object that has records.
- **Applied to the data:**
  - Picklist renames update records, including multi-select.
  - Deleting a picklist value takes a replacement, or clears it; a required field must have a replacement.
  - Deleting a record type in use needs a replacement record type, counting records in the recycle bin.
  - New auto number fields, and a Name field switched to auto number, number existing records oldest first.
  - A new checkbox with a true default is set on existing records.
  - Deleting a field removes its values; deleting an object deletes its records.
- **Rejected:** Matching Salesforce's warn-and-truncate behaviour. Silent data loss is worse than an extra step.

## D-034 · Auto numbers
- **Chose:** One counter row per field, incremented with `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`; the row lock makes concurrent inserts take turns, so numbers are distinct and gap-free while transactions commit (a test runs 20 at once). Changing the starting number sets the next value. `{YYYY}`, `{MM}`, `{DD}` use UTC; org time zones arrive with org settings.
- **Rejected:** A Postgres sequence per field (DDL per field, and sequences skip numbers on rollback).

## D-035 · Pool errors must not crash the process
- **Chose:** `createDb` always attaches a pool `error` listener. When the database restarts or fails over, idle connections die and `pg` emits `error`; with no listener Node exits. Found when the migration test dropped its scratch database; a test now kills a pooled connection and checks the pool reports it and reconnects.

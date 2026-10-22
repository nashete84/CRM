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

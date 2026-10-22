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

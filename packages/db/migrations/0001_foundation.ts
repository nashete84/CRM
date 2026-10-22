import { type Kysely, sql } from "kysely";

// Foundation only: extensions and grants. Platform tables start in step 2.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS citext`.execute(db);

  // Tables the owner creates from now on are usable by the app role.
  // Row-level security (step 2) narrows what crm_app can see within them.
  await sql`GRANT USAGE ON SCHEMA public TO crm_app`.execute(db);
  await sql`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app
  `.execute(db);
  await sql`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO crm_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE USAGE, SELECT ON SEQUENCES FROM crm_app
  `.execute(db);
  await sql`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM crm_app
  `.execute(db);
  await sql`REVOKE USAGE ON SCHEMA public FROM crm_app`.execute(db);
}

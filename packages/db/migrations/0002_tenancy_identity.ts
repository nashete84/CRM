import { type Kysely, sql } from "kysely";

/**
 * Tenancy and identity (step 2). See DECISIONS.md D-005, D-014 to D-018.
 *
 * Isolation rules every tenant table follows:
 *  1. It has an `org_id` column.
 *  2. Row-level security is enabled, with one policy: org_id = app_org_id(),
 *     for both reading (USING) and writing (WITH CHECK).
 *  3. References to other tenant rows are composite (org_id, id) foreign keys,
 *     so a row can never point at another org's row, even by a bug in app code.
 * A test in packages/db/test/tenancy.test.ts fails if any table with an org_id
 * column breaks rule 2.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The org the current transaction acts for. Empty or unset means none, and
  // every policy then matches nothing.
  await sql`
    CREATE FUNCTION app_org_id() RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT nullif(current_setting('app.org_id', true), '') $$
  `.execute(db);

  await sql`
    CREATE TABLE org (
      id          text PRIMARY KEY CHECK (id ~ '^00D[0-9A-Za-z]{12}[A-Z0-5]{3}$'),
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
      slug        citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE app_user (
      id          text PRIMARY KEY CHECK (id ~ '^005[0-9A-Za-z]{12}[A-Z0-5]{3}$'),
      org_id      text NOT NULL REFERENCES org (id) ON DELETE CASCADE,
      email       citext NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email LIKE '%_@_%'),
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
      is_active   boolean NOT NULL DEFAULT true,
      time_zone   text NOT NULL DEFAULT 'UTC',
      locale      text NOT NULL DEFAULT 'en_US',
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, email),
      UNIQUE (org_id, id)
    )
  `.execute(db);

  // Local passwords: development only, gated by ALLOW_LOCAL_LOGIN (D-009).
  await sql`
    CREATE TABLE local_credential (
      user_id        text PRIMARY KEY,
      org_id         text NOT NULL,
      password_hash  text NOT NULL,
      updated_at     timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  // OIDC identity providers, configured per org. The client secret is never
  // stored here: client_secret_env names the environment variable holding it.
  await sql`
    CREATE TABLE identity_provider (
      id                   text PRIMARY KEY CHECK (id ~ '^0SO[0-9A-Za-z]{12}[A-Z0-5]{3}$'),
      org_id               text NOT NULL REFERENCES org (id) ON DELETE CASCADE,
      name                 text NOT NULL,
      issuer               text NOT NULL CHECK (issuer ~ '^https?://'),
      client_id            text NOT NULL,
      client_secret_env    text NOT NULL CHECK (client_secret_env ~ '^[A-Z][A-Z0-9_]*$'),
      allow_email_linking  boolean NOT NULL DEFAULT false,
      is_active            boolean NOT NULL DEFAULT true,
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, id)
    )
  `.execute(db);

  // A user's account at an identity provider. (provider_id, subject) is the
  // stable key OIDC guarantees; email is never used to find a returning user.
  await sql`
    CREATE TABLE user_identity (
      provider_id  text NOT NULL,
      subject      text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
      org_id       text NOT NULL,
      user_id      text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider_id, subject),
      UNIQUE (provider_id, user_id),
      FOREIGN KEY (org_id, provider_id) REFERENCES identity_provider (org_id, id) ON DELETE CASCADE,
      FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  // Sessions. id is the SHA-256 of the bearer token; the token itself is never stored.
  await sql`
    CREATE TABLE user_session (
      id            text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
      org_id        text NOT NULL,
      user_id       text NOT NULL,
      method        text NOT NULL CHECK (method IN ('local', 'oidc')),
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_seen_at  timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      revoked_at    timestamptz,
      ip            inet,
      user_agent    text,
      FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX user_session_user_idx ON user_session (org_id, user_id)`.execute(db);

  // Row-level security. Tables are owned by the migration role, which is never
  // used by the API, so policies are ENABLEd, not FORCEd (D-016).
  await sql`ALTER TABLE org ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY org_isolation ON org
    USING (id = app_org_id()) WITH CHECK (id = app_org_id())
  `.execute(db);
  for (const table of [
    "app_user",
    "local_credential",
    "identity_provider",
    "user_identity",
    "user_session",
  ]) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY tenant_isolation ON ${sql.table(table)}
      USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())
    `.execute(db);
  }

  // The only two ways to read across orgs, both narrow and audited (D-017).
  // 1. Find an org by its login slug, before anyone is signed in.
  await sql`
    CREATE FUNCTION auth_resolve_org(p_slug text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$ SELECT id FROM org WHERE slug = p_slug::citext $$
  `.execute(db);
  // 2. Find which org and user a session token belongs to. Returns nothing
  //    for revoked, expired, idle-timed-out sessions and inactive users.
  await sql`
    CREATE FUNCTION auth_resolve_session(p_token_hash text, p_idle interval)
    RETURNS TABLE (org_id text, user_id text, last_seen_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
      SELECT s.org_id, s.user_id, s.last_seen_at
      FROM user_session s
      JOIN app_user u ON u.org_id = s.org_id AND u.id = s.user_id
      WHERE s.id = p_token_hash
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - p_idle
        AND u.is_active
    $$
  `.execute(db);
  for (const fn of ["auth_resolve_org(text)", "auth_resolve_session(text, interval)"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`).execute(db);
    await sql.raw(`GRANT EXECUTE ON FUNCTION ${fn} TO crm_app`).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS auth_resolve_session(text, interval)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS auth_resolve_org(text)`.execute(db);
  for (const table of [
    "user_session",
    "user_identity",
    "identity_provider",
    "local_credential",
    "app_user",
    "org",
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS app_org_id()`.execute(db);
}

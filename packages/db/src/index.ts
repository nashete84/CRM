import {
  type ColumnType,
  type Generated,
  Kysely,
  PostgresDialect,
  type Transaction,
  sql,
} from "kysely";
import pg from "pg";

// Platform tables only. Tenant-defined objects never appear here: they live in
// the generic record table (DECISIONS.md D-004) and are typed from metadata.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type OrgTable = {
  id: string;
  name: string;
  slug: string;
  created_at: Timestamp;
};

export type AppUserTable = {
  id: string;
  org_id: string;
  email: string;
  name: string;
  is_active: Generated<boolean>;
  time_zone: Generated<string>;
  locale: Generated<string>;
  created_at: Timestamp;
};

export type LocalCredentialTable = {
  user_id: string;
  org_id: string;
  password_hash: string;
  updated_at: Timestamp;
};

export type IdentityProviderTable = {
  id: string;
  org_id: string;
  name: string;
  issuer: string;
  client_id: string;
  client_secret_env: string;
  allow_email_linking: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
};

export type UserIdentityTable = {
  provider_id: string;
  subject: string;
  org_id: string;
  user_id: string;
  created_at: Timestamp;
};

export type UserSessionTable = {
  id: string;
  org_id: string;
  user_id: string;
  method: "local" | "oidc";
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ip: string | null;
  user_agent: string | null;
};

export type Database = {
  org: OrgTable;
  app_user: AppUserTable;
  local_credential: LocalCredentialTable;
  identity_provider: IdentityProviderTable;
  user_identity: UserIdentityTable;
  user_session: UserSessionTable;
};

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Runs `fn` in a transaction scoped to one org. This is the only way API code
 * should touch tenant tables: row-level security sees `app.org_id` and hides
 * every other org's rows. The setting is transaction-local, so it cannot leak
 * to the next request that borrows the same pooled connection.
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!orgId) throw new Error("withOrg requires an org id");
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.org_id', ${orgId}, true)`.execute(tx);
    return fn(tx);
  });
}

/** Cross-org lookups, backed by the two audited SECURITY DEFINER functions. */
export async function resolveOrgBySlug(db: Db, slug: string): Promise<string | null> {
  const { rows } = await sql<{ id: string | null }>`SELECT auth_resolve_org(${slug}) AS id`.execute(
    db,
  );
  return rows[0]?.id ?? null;
}

export type ResolvedSession = { orgId: string; userId: string; lastSeenAt: Date };

export async function resolveSession(
  db: Db,
  tokenHash: string,
  idleMinutes: number,
): Promise<ResolvedSession | null> {
  const { rows } = await sql<{ org_id: string; user_id: string; last_seen_at: Date }>`
    SELECT org_id, user_id, last_seen_at
    FROM auth_resolve_session(${tokenHash}, make_interval(mins => ${idleMinutes}))
  `.execute(db);
  const row = rows[0];
  return row ? { orgId: row.org_id, userId: row.user_id, lastSeenAt: row.last_seen_at } : null;
}

export { migrateToLatest, migrateDown } from "./migrator.js";
export { KeyPrefix, isValidId, newId, normalizeId, to18 } from "./ids.js";

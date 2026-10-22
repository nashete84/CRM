import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

// Platform tables are added to this interface as migrations introduce them.
// Tenant-defined objects never appear here: they live in the generic record
// table (DECISIONS.md D-004) and are typed at runtime from metadata.
// biome-ignore lint/complexity/noBannedTypes: filled in from step 2 onwards
export type Database = {};

export type Db = Kysely<Database>;

export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export { migrateToLatest, migrateDown } from "./migrator.js";

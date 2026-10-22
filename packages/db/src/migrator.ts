import { type Kysely, type MigrationResultSet, Migrator } from "kysely";
import { migrations } from "../migrations/index.js";

function migrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    // Migrations are schema-level and independent of the typed table map.
    db: db as unknown as Kysely<unknown>,
    provider: { getMigrations: async () => migrations },
  });
}

function check(result: MigrationResultSet): MigrationResultSet {
  if (result.error) {
    const failed = result.results?.find((r) => r.status === "Error");
    throw new Error(
      `Migration ${failed?.migrationName ?? "(unknown)"} failed: ${String(result.error)}`,
    );
  }
  return result;
}

/** Applies every pending migration. Must run as the owner role, never the app role. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<MigrationResultSet> {
  return check(await migrator(db).migrateToLatest());
}

export async function migrateDown<DB>(db: Kysely<DB>): Promise<MigrationResultSet> {
  return check(await migrator(db).migrateDown());
}

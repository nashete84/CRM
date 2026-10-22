import { type Kysely, sql } from "kysely";

/**
 * Record storage (step 4). See DECISIONS.md D-004 and D-029 to D-034.
 *
 * Every record of every object lives in `record`. Columns hold what every
 * record has (name, owner, record type, audit fields, recycle-bin state); all
 * other field values sit in `data`, keyed by field ID so renaming a field never
 * touches records. `record_index` mirrors the values that need exact lookups:
 * unique fields, external IDs and every relationship field.
 */
const TABLES = ["record", "record_index", "autonumber_counter", "recycle_cleared_lookup"];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE record (
      id                   text PRIMARY KEY CHECK (id ~ '^[0-9A-Za-z]{15}[A-Z0-5]{3}$'),
      org_id               text NOT NULL REFERENCES org (id) ON DELETE CASCADE,
      object_id            text NOT NULL,
      name                 text CHECK (length(name) <= 255),
      owner_id             text,
      record_type_id       text,
      data                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
      is_deleted           boolean NOT NULL DEFAULT false,
      deletion_id          uuid,
      deleted_at           timestamptz,
      deleted_by_id        text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by_id        text NOT NULL,
      last_modified_at     timestamptz NOT NULL DEFAULT now(),
      last_modified_by_id  text NOT NULL,
      system_modstamp      timestamptz NOT NULL DEFAULT now(),
      seq                  bigint GENERATED ALWAYS AS IDENTITY,
      UNIQUE (org_id, id),
      FOREIGN KEY (org_id, object_id) REFERENCES object_def (org_id, id) ON DELETE CASCADE,
      -- Deferred to commit so that deleting an object or an org can cascade
      -- through records and record types in any order (see D-027).
      FOREIGN KEY (org_id, record_type_id) REFERENCES record_type (org_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (org_id, owner_id) REFERENCES app_user (org_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (org_id, created_by_id) REFERENCES app_user (org_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (org_id, last_modified_by_id) REFERENCES app_user (org_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      CHECK (is_deleted = (deletion_id IS NOT NULL)),
      CHECK (is_deleted = (deleted_at IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX record_object_idx ON record (org_id, object_id, seq) WHERE NOT is_deleted`.execute(
    db,
  );
  await sql`CREATE INDEX record_deletion_idx ON record (deletion_id) WHERE deletion_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX record_owner_idx ON record (org_id, owner_id)`.execute(db);

  await sql`
    CREATE TABLE record_index (
      org_id     text NOT NULL,
      field_id   text NOT NULL,
      record_id  text NOT NULL,
      -- Normalised for comparison: 18-character IDs, case-folded text where the
      -- field is case-insensitive, canonical decimals ("1.50" and "1.5" match).
      value_key  text NOT NULL,
      is_unique  boolean NOT NULL,
      -- False while the record is in the recycle bin, so it doesn't hold its unique values.
      is_active  boolean NOT NULL DEFAULT true,
      PRIMARY KEY (field_id, record_id),
      FOREIGN KEY (org_id, record_id) REFERENCES record (org_id, id) ON DELETE CASCADE,
      FOREIGN KEY (org_id, field_id) REFERENCES field_def (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX record_index_unique ON record_index (field_id, value_key)
    WHERE is_unique AND is_active
  `.execute(db);
  await sql`CREATE INDEX record_index_value ON record_index (field_id, value_key)`.execute(db);

  await sql`
    CREATE TABLE autonumber_counter (
      field_id    text PRIMARY KEY,
      org_id      text NOT NULL,
      next_value  bigint NOT NULL CHECK (next_value >= 0),
      FOREIGN KEY (org_id, field_id) REFERENCES field_def (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  // Lookups cleared because their parent was deleted; put back on undelete.
  await sql`
    CREATE TABLE recycle_cleared_lookup (
      deletion_id  uuid NOT NULL,
      org_id       text NOT NULL,
      record_id    text NOT NULL,
      field_id     text NOT NULL,
      value        text NOT NULL,
      PRIMARY KEY (deletion_id, record_id, field_id),
      FOREIGN KEY (org_id, record_id) REFERENCES record (org_id, id) ON DELETE CASCADE,
      FOREIGN KEY (org_id, field_id) REFERENCES field_def (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  for (const table of TABLES) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY tenant_isolation ON ${sql.table(table)}
      USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...TABLES].reverse()) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
}

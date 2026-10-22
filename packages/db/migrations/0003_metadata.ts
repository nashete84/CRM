import { type Kysely, sql } from "kysely";
import { ensurePlatformObjects } from "../src/platform-seed.js";

/**
 * Metadata engine (step 3). Objects, fields, picklist values and record types
 * are rows, not DDL (DECISIONS.md D-004, D-023). The service in
 * packages/metadata enforces the full rule set; constraints here are the
 * backstop that holds even if application code has a bug.
 */
const FIELD_TYPES = [
  "Text",
  "TextArea",
  "LongTextArea",
  "Email",
  "Phone",
  "Url",
  "Number",
  "Currency",
  "Percent",
  "Checkbox",
  "Date",
  "DateTime",
  "Picklist",
  "MultiselectPicklist",
  "Lookup",
  "MasterDetail",
  "AutoNumber",
];

const TABLES = [
  "object_def",
  "field_def",
  "picklist_value",
  "record_type",
  "record_type_picklist_value",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Bumped on every metadata change so caches can tell when to reload.
  await sql`ALTER TABLE org ADD COLUMN metadata_version bigint NOT NULL DEFAULT 0`.execute(db);

  await sql`
    CREATE TABLE object_def (
      id             text PRIMARY KEY CHECK (id ~ '^01I[0-9A-Za-z]{12}[A-Z0-5]{3}$'),
      org_id         text NOT NULL REFERENCES org (id) ON DELETE CASCADE,
      api_name       text NOT NULL,
      label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
      plural_label   text NOT NULL CHECK (length(plural_label) BETWEEN 1 AND 40),
      description    text CHECK (length(description) <= 1000),
      key_prefix     text NOT NULL CHECK (key_prefix ~ '^[0-9A-Za-z]{3}$'),
      is_custom      boolean NOT NULL,
      storage        text NOT NULL DEFAULT 'record' CHECK (storage IN ('record', 'platform')),
      sharing_model  text NOT NULL DEFAULT 'ReadWrite'
                     CHECK (sharing_model IN ('Private', 'Read', 'ReadWrite', 'ControlledByParent')),
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, id),
      UNIQUE (org_id, key_prefix),
      CHECK (
        (is_custom AND api_name ~ '^[A-Za-z](([A-Za-z0-9]|_(?!_))*[A-Za-z0-9])?__c$' AND length(api_name) <= 43)
        OR (NOT is_custom AND api_name ~ '^[A-Za-z][A-Za-z0-9]*$' AND length(api_name) <= 40)
      ),
      CHECK (NOT is_custom OR storage = 'record')
    )
  `.execute(db);
  // API names are case-insensitive, as in Salesforce.
  await sql`CREATE UNIQUE INDEX object_def_api_name_uq ON object_def (org_id, lower(api_name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE field_def (
      id                 text PRIMARY KEY CHECK (id ~ '^00N[0-9A-Za-z]{12}[A-Z0-5]{3}$'),
      org_id             text NOT NULL,
      object_id          text NOT NULL,
      api_name           text NOT NULL,
      label              text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
      type               text NOT NULL CHECK (type IN (${sql.join(FIELD_TYPES.map((t) => sql.lit(t)))})),
      is_custom          boolean NOT NULL,
      is_name_field      boolean NOT NULL DEFAULT false,
      required           boolean NOT NULL DEFAULT false,
      is_unique          boolean NOT NULL DEFAULT false,
      is_external_id     boolean NOT NULL DEFAULT false,
      description        text CHECK (length(description) <= 1000),
      help_text          text CHECK (length(help_text) <= 510),
      -- Type-specific settings (length, precision, format, ...), validated by packages/metadata.
      props              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(props) = 'object'),
      reference_to       text,
      relationship_name  text,
      relationship_label text,
      delete_constraint  text CHECK (delete_constraint IN ('SetNull', 'Restrict', 'Cascade')),
      -- Creation order. Timestamps tie inside one transaction; this never does.
      seq                bigint GENERATED ALWAYS AS IDENTITY,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, id),
      FOREIGN KEY (org_id, object_id) REFERENCES object_def (org_id, id) ON DELETE CASCADE,
      -- An object can't be deleted while a relationship field still points at it.
      -- Checked at commit: deleting a whole org cascades to both ends of every
      -- relationship, and an earlier check would see a half-finished cascade.
      FOREIGN KEY (org_id, reference_to) REFERENCES object_def (org_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      CHECK (
        (is_custom AND api_name ~ '^[A-Za-z](([A-Za-z0-9]|_(?!_))*[A-Za-z0-9])?__c$' AND length(api_name) <= 43)
        OR (NOT is_custom AND api_name ~ '^[A-Za-z][A-Za-z0-9]*$' AND length(api_name) <= 40)
      ),
      CHECK (
        (type IN ('Lookup', 'MasterDetail'))
          = (reference_to IS NOT NULL AND relationship_name IS NOT NULL AND delete_constraint IS NOT NULL)
      ),
      CHECK (type <> 'MasterDetail' OR (required AND delete_constraint = 'Cascade')),
      CHECK (type <> 'Lookup' OR delete_constraint IN ('SetNull', 'Restrict')),
      CHECK (NOT (type = 'Lookup' AND required AND delete_constraint = 'SetNull')),
      CHECK (relationship_name IS NULL OR relationship_name ~ '^[A-Za-z](([A-Za-z0-9]|_(?!_))*[A-Za-z0-9])?$'),
      CHECK (NOT is_name_field OR type IN ('Text', 'AutoNumber'))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX field_def_api_name_uq ON field_def (org_id, object_id, lower(api_name))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX field_def_one_name_field ON field_def (object_id) WHERE is_name_field`.execute(
    db,
  );
  // Child relationship names are unique per parent object (Account.Contacts, Account.Invoices__r).
  await sql`
    CREATE UNIQUE INDEX field_def_relationship_uq ON field_def (org_id, reference_to, lower(relationship_name))
    WHERE reference_to IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX field_def_reference_idx ON field_def (org_id, reference_to) WHERE reference_to IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE picklist_value (
      org_id      text NOT NULL,
      field_id    text NOT NULL,
      value       text NOT NULL CHECK (length(value) BETWEEN 1 AND 255),
      label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 255),
      sort_order  integer NOT NULL,
      is_default  boolean NOT NULL DEFAULT false,
      is_active   boolean NOT NULL DEFAULT true,
      PRIMARY KEY (field_id, value),
      FOREIGN KEY (org_id, field_id) REFERENCES field_def (org_id, id) ON DELETE CASCADE,
      CHECK (NOT (is_default AND NOT is_active))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX picklist_value_ci_uq ON picklist_value (field_id, lower(value))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX picklist_value_one_default ON picklist_value (field_id) WHERE is_default`.execute(
    db,
  );

  await sql`
    CREATE TABLE record_type (
      id              text PRIMARY KEY CHECK (id ~ '^012[0-9A-Za-z]{12}[A-Z0-5]{3}$'),
      org_id          text NOT NULL,
      object_id       text NOT NULL,
      developer_name  text NOT NULL CHECK (developer_name ~ '^[A-Za-z](([A-Za-z0-9]|_(?!_))*[A-Za-z0-9])?$' AND length(developer_name) <= 80),
      label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
      description     text CHECK (length(description) <= 255),
      is_active       boolean NOT NULL DEFAULT true,
      seq             bigint GENERATED ALWAYS AS IDENTITY,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, id),
      FOREIGN KEY (org_id, object_id) REFERENCES object_def (org_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX record_type_name_uq ON record_type (org_id, object_id, lower(developer_name))`.execute(
    db,
  );

  // Which picklist values each record type offers, and its default.
  await sql`
    CREATE TABLE record_type_picklist_value (
      org_id          text NOT NULL,
      record_type_id  text NOT NULL,
      field_id        text NOT NULL,
      value           text NOT NULL,
      is_default      boolean NOT NULL DEFAULT false,
      PRIMARY KEY (record_type_id, field_id, value),
      FOREIGN KEY (org_id, record_type_id) REFERENCES record_type (org_id, id) ON DELETE CASCADE,
      FOREIGN KEY (field_id, value) REFERENCES picklist_value (field_id, value) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX record_type_picklist_one_default
    ON record_type_picklist_value (record_type_id, field_id) WHERE is_default
  `.execute(db);

  await sql`
    CREATE FUNCTION bump_metadata_version() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        UPDATE org SET metadata_version = metadata_version + 1 WHERE id = OLD.org_id;
      ELSE
        UPDATE org SET metadata_version = metadata_version + 1 WHERE id = NEW.org_id;
      END IF;
      RETURN NULL;
    END
    $$
  `.execute(db);

  for (const table of TABLES) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`
      CREATE POLICY tenant_isolation ON ${sql.table(table)}
      USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())
    `.execute(db);
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_bump_version`)}
      AFTER INSERT OR UPDATE OR DELETE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION bump_metadata_version()
    `.execute(db);
  }

  // Existing orgs get the built-in User object.
  const { rows } = await sql<{ id: string }>`SELECT id FROM org`.execute(db);
  for (const org of rows) await ensurePlatformObjects(db, org.id);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...TABLES].reverse()) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS bump_metadata_version()`.execute(db);
  await sql`ALTER TABLE org DROP COLUMN IF EXISTS metadata_version`.execute(db);
}

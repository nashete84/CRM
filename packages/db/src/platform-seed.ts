import { type Kysely, type Transaction, sql } from "kysely";
import { KeyPrefix, newId } from "./ids.js";
import { PLATFORM_OBJECTS } from "./platform-objects.js";

/**
 * Inserts any missing platform object definitions (User, ...) for one org.
 * Idempotent: safe to run on every org creation and from later migrations
 * that add platform objects. Must run where the org's rows are visible:
 * inside withOrg(), or as the migration owner.
 */
export async function ensurePlatformObjects(
  // biome-ignore lint/suspicious/noExplicitAny: works for any typed or untyped Kysely
  db: Kysely<any> | Transaction<any>,
  orgId: string,
): Promise<void> {
  for (const obj of PLATFORM_OBJECTS) {
    const objectId = newId(KeyPrefix.ObjectDef);
    await sql`
      INSERT INTO object_def (id, org_id, api_name, label, plural_label, key_prefix, is_custom, storage, sharing_model)
      VALUES (${objectId}, ${orgId}, ${obj.apiName}, ${obj.label}, ${obj.pluralLabel}, ${obj.keyPrefix}, false, 'platform', 'Read')
      ON CONFLICT (org_id, lower(api_name)) DO NOTHING
    `.execute(db);
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM object_def WHERE org_id = ${orgId} AND lower(api_name) = lower(${obj.apiName})
    `.execute(db);
    const actualId = rows[0]?.id;
    if (!actualId) throw new Error(`Platform object ${obj.apiName} missing for org ${orgId}`);
    for (const f of obj.fields) {
      const props = { column: f.column, ...(f.length ? { length: f.length } : {}) };
      await sql`
        INSERT INTO field_def (id, org_id, object_id, api_name, label, type, is_custom, is_name_field, required, props)
        VALUES (${newId(KeyPrefix.FieldDef)}, ${orgId}, ${actualId}, ${f.apiName}, ${f.label}, ${f.type},
                false, ${f.isNameField ?? false}, ${f.isNameField ?? false}, ${JSON.stringify(props)}::jsonb)
        ON CONFLICT (org_id, object_id, lower(api_name)) DO NOTHING
      `.execute(db);
    }
  }
}
